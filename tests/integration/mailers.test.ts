import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManualClock } from '../helpers/clock.ts';
import { createLogger } from '../../src/observability/logger.ts';
import { loadConfig } from '../../src/config.ts';
import { SimulatedMailer } from '../../src/notifications/mailer.simulated.ts';
import { FakeMailer } from '../../src/notifications/mailer.fake.ts';
import { SmtpMailer, classify, transportOptions } from '../../src/notifications/mailer.smtp.ts';
import type { OutgoingEmail } from '../../src/notifications/ports.ts';

const KEY = 'a'.repeat(64);
const MAIL: OutgoingEmail = {
  to: 'marina@example.com', subject: 'Preço-alvo atingido: Era', text: 'corpo secreto', html: '<p>corpo secreto</p>', idempotencyKey: KEY,
};
const SMTP = {
  SMTP_HOST: 'smtp.example.com', SMTP_PORT: '587', SMTP_USER: 'user-x', SMTP_PASS: 'pass-y', SMTP_FROM: 'from@example.com', EMAIL_MODE: 'real',
};
const cfg = (extra: Record<string, string> = {}) => loadConfig({ ...SMTP, ...extra }).smtp!;
const logs = () => {
  const lines: string[] = [];
  return { lines, log: createLogger('mail', new ManualClock('2026-10-14T12:00:00Z'), (l) => lines.push(l)) };
};

test('T-NOT-02 SimulatedMailer aceita com id simulated:n, sem conexão, log sem PII', async () => {
  const { log, lines } = logs();
  const m = new SimulatedMailer(log);
  assert.equal(m.mode, 'teste');
  assert.deepEqual(await m.send(MAIL), { kind: 'accepted', providerMessageId: 'simulated:1' });
  assert.deepEqual(await m.send(MAIL), { kind: 'accepted', providerMessageId: 'simulated:2' });
  const all = lines.join('');
  for (const secret of ['marina', 'corpo secreto', 'Preço-alvo']) assert.ok(!all.includes(secret));
});

test('T-NOT-02 sink de arquivo opt-in: nome derivado do id, chave hostil não vira caminho', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'outbox-'));
  try {
    const m = new SimulatedMailer(logs().log, join(dir, 'outbox'));
    await m.send({ ...MAIL, idempotencyKey: '../../evil' });
    await m.send(MAIL);
    assert.deepEqual((await readdir(join(dir, 'outbox'))).sort(), [`${KEY}.eml`, 'n1.eml']);
    assert.match(await readFile(join(dir, 'outbox', `${KEY}.eml`), 'utf8'), /corpo secreto/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('T-NOT-02 sink falho não derruba o envio simulado', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'outbox-'));
  try {
    await writeFile(join(dir, 'arquivo'), 'x');
    const r = await new SimulatedMailer(logs().log, join(dir, 'arquivo', 'sub')).send(MAIL); // mkdir sob arquivo falha
    assert.equal(r.kind, 'accepted');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('T-NOT-02 FakeMailer: registra, fila programável e modo falha-se-chamado', async () => {
  const f = new FakeMailer('real').enqueue({ kind: 'temporary_error', reason: 'x' });
  assert.equal(f.mode, 'real');
  assert.equal((await f.send(MAIL)).kind, 'temporary_error');
  assert.equal((await f.send(MAIL)).kind, 'accepted');
  assert.equal(f.sent.length, 2);
  assert.throws(() => new FakeMailer().failIfCalled().send(MAIL), /não deveria/);
});

test('S16 transportOptions: TLS obrigatório e rejectUnauthorized nunca false', () => {
  const o587 = transportOptions(cfg());
  assert.equal(o587.secure, false);
  assert.equal(o587.requireTLS, true);
  assert.equal(o587.tls.rejectUnauthorized, true);
  const o465 = transportOptions(cfg({ SMTP_PORT: '465' }));
  assert.equal(o465.secure, true);
  assert.equal(o465.tls.rejectUnauthorized, true);
});

test('RF-08-AC4 SmtpMailer classifica 4xx = temporário, 5xx = permanente, rede = temporário', () => {
  assert.equal(classify({ responseCode: 451, code: 'EMESSAGE' }).kind, 'temporary_error');
  assert.equal(classify({ responseCode: 550, code: 'EENVELOPE' }).kind, 'permanent_error');
  assert.equal(classify({ code: 'EAUTH' }).kind, 'permanent_error');
  assert.equal(classify({ code: 'ECONNECTION' }).kind, 'temporary_error');
  assert.equal(classify(new Error('boom marina@example.com')).kind, 'temporary_error');
});

test('RF-08-AC7 SmtpMailer: sucesso, erros e log sem destinatário/corpo/credencial', async () => {
  const { log, lines } = logs();
  const sent: Record<string, unknown>[] = [];
  let fail: unknown = null;
  const m = new SmtpMailer(cfg(), log, {
    sendMail: async (x) => {
      sent.push(x);
      if (fail) throw fail;
      return { messageId: '<abc@srv>' };
    },
  });
  assert.deepEqual(await m.send(MAIL), { kind: 'accepted', providerMessageId: '<abc@srv>' });
  assert.equal(sent[0]!.messageId, `<${KEY}@vans-alert.local>`);
  assert.equal(sent[0]!.from, 'from@example.com');

  fail = Object.assign(new Error('Recipient marina@example.com rejected'), { responseCode: 550, code: 'EENVELOPE' });
  const r = await m.send(MAIL);
  assert.equal(r.kind, 'permanent_error');
  fail = Object.assign(new Error('try later pass-y'), { responseCode: 421 });
  assert.equal((await m.send(MAIL)).kind, 'temporary_error');

  const all = lines.join('') + JSON.stringify(r);
  for (const s of ['marina', 'corpo secreto', 'pass-y', 'user-x']) assert.ok(!all.includes(s), s);
});

test('S16 SmtpMailer contra SMTP falso em loopback sem STARTTLS: recusa e nunca envia dados', async () => {
  const seen: string[] = [];
  const srv = net.createServer((s) => {
    s.write('220 fake ESMTP\r\n');
    s.on('data', (d) => {
      const line = d.toString();
      seen.push(line.trim().split(' ')[0]!.toUpperCase());
      if (/^EHLO/i.test(line)) s.write('250-fake\r\n250 AUTH PLAIN\r\n'); // sem STARTTLS
      else s.write('221 bye\r\n');
    });
    s.on('error', () => {});
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const port = (srv.address() as net.AddressInfo).port;
    const { log, lines } = logs();
    const m = new SmtpMailer(cfg({ SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port) }), log);
    const r = await m.send(MAIL);
    assert.notEqual(r.kind, 'accepted');
    for (const cmd of ['AUTH', 'MAIL', 'RCPT', 'DATA']) assert.ok(!seen.includes(cmd), `enviou ${cmd}`);
    assert.ok(!lines.join('').includes('marina'));
  } finally {
    srv.close();
  }
});
