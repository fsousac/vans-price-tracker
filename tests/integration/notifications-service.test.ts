import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from '../helpers/db.ts';
import { ManualClock } from '../helpers/clock.ts';
import { SqliteNotificationRepo } from '../../src/notifications/notifications.repo.ts';
import { NotificationService, type EnqueueInput } from '../../src/notifications/notifications.service.ts';
import { FakeMailer } from '../../src/notifications/mailer.fake.ts';
import { createAlertRepo } from '../../src/alerts/alerts.repo.ts';
import { createHealthEventRepo } from '../../src/observability/events.repo.ts';
import { createLogger } from '../../src/observability/logger.ts';

const T0 = '2026-10-14T12:00:00.000Z';
const MIN = 60_000;

function setup(mailer = new FakeMailer('real'), ownerEmail: string | null = 'dono@exemplo.com') {
  const db = makeDb();
  db.exec(`
    INSERT INTO products (code, name, created_at, updated_at) VALUES ('1003800580026U', 'Old Skool', '${T0}', '${T0}');
    INSERT INTO product_variants (variant_code, product_code, size, last_seen_at) VALUES ('1003800580026U-34', '1003800580026U', '34', '${T0}');
    INSERT INTO monitoring_runs (kind, trigger, status, started_at, finished_at) VALUES ('monitor', 'manual', 'ok', '${T0}', '${T0}');
  `);
  for (let i = 1; i <= 26; i++) {
    db.prepare(
      `INSERT INTO price_observations (variant_code, run_id, seq, observed_at, original_cents, current_cents, available, confirmed, degraded, source)
       VALUES ('1003800580026U-34', 1, ?, ?, 40000, 30000, 1, 1, 0, 'occ')`,
    ).run(i, T0);
  }
  const clock = new ManualClock(T0);
  const alerts = createAlertRepo(db);
  const alertId = alerts.create({ variantCode: '1003800580026U-34', targetCents: 30000, marginBp: 300, email: 'a@b.co' }, T0);
  const repo = new SqliteNotificationRepo(db);
  const lines: string[] = [];
  const log = createLogger('notifications', clock, (l) => lines.push(l));
  const svc = new NotificationService({ repo, alerts, mailer, clock, log, ownerEmail });
  const input = (o: Partial<EnqueueInput> = {}): EnqueueInput => ({
    alertId, healthEventId: null, observationId: 1, kind: 'ATINGIDO', productCode: '1003800580026U', productName: 'Old Skool',
    productSlug: 'old-skool', size: '34', priceCents: 30000, targetCents: 30000, marginBp: 300, observedAt: T0, source: 'occ',
    degraded: false, alreadyInBand: false, revision: 1, episode: 1, ...o,
  });
  const get = (id: number) => repo.listForAlert(alertId).find((n) => n.id === id)!;
  return { db, clock, alerts, repo, svc, mailer, input, alertId, get, lines };
}

test('T-NOT-04 T-SM-02 inicial + 3 retentativas (5 min/30 min/2 h); 4a falha vira FALHA; 5a nao existe', async () => {
  const mailer = new FakeMailer('real');
  const t = setup(mailer);
  const tmp = { kind: 'temporary_error', reason: 'timeout' } as const;
  mailer.enqueue(tmp, tmp, tmp, tmp, tmp);
  const { id } = t.svc.enqueue(t.input())!;
  const waits = [5, 30, 120];
  for (let i = 0; i < 3; i++) {
    assert.equal(await t.svc.drain(), 1);
    const r = t.get(id);
    assert.equal(r.status, 'PENDENTE');
    assert.equal(r.attempts, i + 1);
    assert.equal(r.nextAttemptAt, new Date(t.clock.now().getTime() + waits[i]! * MIN).toISOString());
    await t.clock.advance(waits[i]! * MIN - 1);
    assert.equal(await t.svc.drain(), 0); // ainda nao venceu
    await t.clock.advance(1);
  }
  assert.equal(await t.svc.drain(), 1); // 4o envio
  const r = t.get(id);
  assert.equal(r.status, 'FALHA');
  assert.equal(r.attempts, 4);
  assert.equal(r.failureReason, 'timeout');
  await t.clock.advance(24 * 60 * MIN);
  assert.equal(await t.svc.drain(), 0);
  assert.equal(mailer.sent.length, 4);
});

test('T-NOT-04 FALHA so sai por reenviar: mesma linha, mesma chave, attempts=0', async () => {
  const mailer = new FakeMailer('real').enqueue({ kind: 'permanent_error', reason: 'email_invalido' });
  const t = setup(mailer);
  const { id } = t.svc.enqueue(t.input())!;
  await t.svc.drain();
  const f = t.get(id);
  assert.equal(f.status, 'FALHA'); // permanente: sem retentativa
  assert.equal(f.attempts, 1);
  assert.equal(t.svc.reenviar(id), true);
  assert.equal(t.svc.reenviar(id), false); // ja PENDENTE: duplo clique nao duplica
  assert.equal(t.get(id).attempts, 0);
  assert.equal(t.get(id).idempotencyKey, f.idempotencyKey);
  await t.svc.drain();
  assert.equal(t.get(id).status, 'ACEITO');
  assert.equal(t.get(id).simulated, false);
  assert.equal(mailer.sent.length, 2);
});

test('RF-08-AC4 T-SM-02 modo teste termina em ACEITO simulado; attempts persistido antes do envio', async () => {
  const mailer = new FakeMailer('teste');
  const t = setup(mailer);
  const { id } = t.svc.enqueue(t.input())!;
  assert.equal(t.get(id).mode, 'teste');
  let seen = -1;
  const orig = mailer.send.bind(mailer);
  mailer.send = (m) => {
    seen = t.get(id).attempts;
    return orig(m);
  };
  await t.svc.drain();
  assert.equal(seen, 1);
  const r = t.get(id);
  assert.equal(r.status, 'ACEITO');
  assert.equal(r.simulated, true);
  assert.equal(r.nextAttemptAt, null);
  assert.equal(r.acceptedAt, T0);
});

test('T-NOT-08 lease: dois drains concorrentes nao enviam a mesma linha', async () => {
  const mailer = new FakeMailer('real');
  const t = setup(mailer);
  t.svc.enqueue(t.input());
  const [a, b] = await Promise.all([t.svc.drain(), t.svc.drain()]);
  assert.equal(a + b, 1);
  assert.equal(mailer.sent.length, 1);
});

test('T-SM-02 enqueue idempotente (RN-12): mesma chave nao cria segunda; nova revisao/episodio cria', () => {
  const t = setup();
  const a = t.svc.enqueue(t.input())!;
  assert.deepEqual(t.svc.enqueue(t.input())!, { id: a.id, created: false });
  assert.equal(t.svc.enqueue(t.input({ observationId: 2, episode: 2 }))!.created, true);
  assert.equal(t.svc.enqueue(t.input({ observationId: 3, revision: 2 }))!.created, true);
});

test('T-SM-02 PENDENTE de alerta pausado fica retido; retomado envia; pausa > 24 h vira FALHA alerta_pausado', async () => {
  const mailer = new FakeMailer('real');
  const t = setup(mailer);
  const { id } = t.svc.enqueue(t.input())!;
  t.alerts.update(t.alertId, { status: 'PAUSADO' }, T0);
  await t.clock.advance(23 * 60 * MIN);
  assert.equal(await t.svc.drain(), 0);
  assert.equal(t.get(id).status, 'PENDENTE');
  assert.equal(t.get(id).attempts, 0);
  t.alerts.update(t.alertId, { status: 'ATIVO' }, t.clock.now().toISOString());
  assert.equal(await t.svc.drain(), 1);
  assert.equal(t.get(id).status, 'ACEITO');

  const n2 = t.svc.enqueue(t.input({ observationId: 2, episode: 2 }))!;
  t.alerts.update(t.alertId, { status: 'PAUSADO' }, t.clock.now().toISOString());
  await t.clock.advance(24 * 60 * MIN + 1);
  await t.svc.drain();
  assert.equal(t.get(n2.id).status, 'FALHA');
  assert.equal(t.get(n2.id).failureReason, 'alerta_pausado');
  assert.equal(mailer.sent.length, 1);
});

test('SAUDE vai para OWNER_EMAIL; sem OWNER_EMAIL nao e criada', async () => {
  const mailer = new FakeMailer('real');
  const t = setup(mailer);
  const ev = createHealthEventRepo(t.db).open('circuito_aberto', 'global', null, T0);
  const health = t.input({ kind: 'SAUDE', alertId: null, observationId: null, healthEventId: ev.id, revision: undefined, episode: undefined });
  const r = t.svc.enqueue(health)!;
  assert.equal(t.svc.enqueue(health)!.created, false);
  await t.svc.drain();
  assert.equal(mailer.sent[0]!.to, 'dono@exemplo.com');
  const row = t.db.prepare('SELECT status FROM notifications WHERE id = ?').get(r.id) as { status: string };
  assert.equal(row.status, 'ACEITO');

  const sem = setup(new FakeMailer('real'), null);
  assert.equal(sem.svc.enqueue({ ...health, healthEventId: 1 }), null);
});

test('teto 20/h: excedente fica PENDENTE e sai quando a janela libera', async () => {
  const mailer = new FakeMailer('real');
  const t = setup(mailer);
  const ids = Array.from({ length: 25 }, (_, i) => t.svc.enqueue(t.input({ observationId: i + 1, episode: i + 1 }))!.id);
  let n = 0;
  for (let i = 0; i < 5; i++) n += await t.svc.drain();
  assert.equal(n, 20);
  assert.equal(mailer.sent.length, 20);
  const pend = ids.filter((id) => t.get(id).status === 'PENDENTE');
  assert.equal(pend.length, 5);
  assert.ok(pend.every((id) => t.get(id).attempts === 0));
  await t.clock.advance(60 * MIN);
  assert.equal(await t.svc.drain(), 5);
  assert.equal(mailer.sent.length, 25);
});

test('T-NOT-05 logs sem e-mail, corpo nem segredo', async () => {
  const mailer = new FakeMailer('real').enqueue({ kind: 'temporary_error', reason: 'x' });
  const t = setup(mailer);
  t.svc.enqueue(t.input());
  await t.svc.drain();
  await t.clock.advance(5 * MIN);
  await t.svc.drain();
  assert.ok(t.lines.length >= 2);
  for (const l of t.lines) assert.doesNotMatch(l, /a@b\.co|Old Skool|dono@|R\$/);
});

test('excecao do mailer vira erro temporario (nunca derruba o drain)', async () => {
  const mailer = new FakeMailer('real');
  mailer.send = () => {
    throw new Error('boom a@b.co');
  };
  const t = setup(mailer);
  const { id } = t.svc.enqueue(t.input())!;
  await t.svc.drain();
  assert.equal(t.get(id).status, 'PENDENTE');
  assert.equal(t.get(id).failureReason, 'excecao_no_envio');
});
