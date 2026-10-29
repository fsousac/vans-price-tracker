import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResendMailer, RESEND_URL } from '../../src/notifications/mailer.resend.ts';
import { DryRunMailer } from '../../src/notifications/mailer.dry.ts';
import type { OutgoingEmail } from '../../src/notifications/ports.ts';

const MAIL: OutgoingEmail = { to: 'marina@example.com', subject: 'Alvo', text: 't', html: '<p>t</p>', idempotencyKey: 'b'.repeat(64) };
const CFG = { apiKey: 're_SEGREDO', from: 'Vans <a@b.dev>' };
const json = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status });

function mk(reply: () => Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const m = new ResendMailer(CFG, async (url, init) => { calls.push({ url, init }); return reply(); });
  return { m, calls };
}

test('T-NOT-03 RF-08 2xx com id: aceito; requisição correta (Bearer, Idempotency-Key, omit, redirect error)', async () => {
  const { m, calls } = mk(async () => json(200, { id: 'abc-1' }));
  assert.equal(m.mode, 'real');
  assert.deepEqual(await m.send(MAIL), { kind: 'accepted', providerMessageId: 'abc-1' });
  const { url, init } = calls[0]!;
  const h = init.headers as Record<string, string>;
  assert.equal(url, RESEND_URL);
  assert.equal(init.method, 'POST');
  assert.equal(h.Authorization, 'Bearer re_SEGREDO');
  assert.equal(h['Idempotency-Key'], MAIL.idempotencyKey);
  assert.equal(init.credentials, 'omit');
  assert.equal(init.redirect, 'error');
  assert.ok(init.signal);
  assert.deepEqual(JSON.parse(init.body as string), { from: CFG.from, to: [MAIL.to], subject: 'Alvo', text: 't', html: '<p>t</p>' });
});

test('T-NOT-03 classificação: 429/5xx temporário; outro 4xx permanente; 2xx sem id não é aceite', async () => {
  const kinds: [number, string][] = [[429, 'temporary_error'], [500, 'temporary_error'], [503, 'temporary_error'], [400, 'permanent_error'], [401, 'permanent_error'], [403, 'permanent_error'], [422, 'permanent_error'], [200, 'temporary_error']];
  for (const [s, kind] of kinds) {
    const r = await mk(async () => json(s, { message: 'marina@example.com re_SEGREDO' })).m.send(MAIL);
    assert.equal(r.kind, kind, String(s));
  }
});

test('T-NOT-03 nunca lança: rede, redirect, timeout e corpo inválido; razão sem PII/segredo', async () => {
  const bad = [
    mk(async () => { throw new TypeError('fetch failed marina@example.com re_SEGREDO'); }).m,
    new ResendMailer({ ...CFG, timeoutMs: 5 }, (_u, init) => new Promise((_, rej) => init.signal!.addEventListener('abort', () => rej(init.signal!.reason)))),
    mk(async () => new Response('não-json', { status: 200 })).m,
  ];
  for (const m of bad) {
    const r = await m.send(MAIL);
    assert.equal(r.kind, 'temporary_error');
    const s = JSON.stringify(r);
    assert.ok(!s.includes('marina') && !s.includes('SEGREDO'));
  }
});

test('T-NOT-02 DryRunMailer: zero rede, aceito simulado sequencial', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error('rede proibida'); }) as typeof fetch;
  try {
    const m = new DryRunMailer();
    assert.equal(m.mode, 'teste');
    assert.deepEqual(await m.send(MAIL), { kind: 'accepted', providerMessageId: 'simulated:1' });
    assert.deepEqual(await m.send(MAIL), { kind: 'accepted', providerMessageId: 'simulated:2' });
  } finally { globalThis.fetch = orig; }
});
