import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from '../helpers/db.ts';
import { SqliteNotificationRepo } from '../../src/notifications/notifications.repo.ts';
import type { NewNotification } from '../../src/notifications/ports.ts';

const T0 = '2026-10-14T12:00:00.000Z';
const at = (min: number) => new Date(Date.parse(T0) + min * 60_000).toISOString();
const key = (c: string) => c.repeat(64);

function setup() {
  const db = makeDb();
  db.exec(`
    INSERT INTO products (code, name, created_at, updated_at) VALUES ('1003800580026U', 'Old Skool', '${T0}', '${T0}');
    INSERT INTO product_variants (variant_code, product_code, size, last_seen_at) VALUES ('1003800580026U-34', '1003800580026U', '34', '${T0}');
    INSERT INTO monitoring_runs (kind, trigger, status, started_at, finished_at) VALUES ('monitor', 'manual', 'ok', '${T0}', '${T0}');
    INSERT INTO price_observations (variant_code, run_id, seq, observed_at, original_cents, current_cents, available, confirmed, degraded, source)
      VALUES ('1003800580026U-34', 1, 1, '${T0}', 40000, 30000, 1, 1, 0, 'occ'), ('1003800580026U-34', 1, 2, '${T0}', 40000, 30000, 1, 1, 0, 'occ');
    INSERT INTO price_alerts (variant_code, target_cents, email, created_at, updated_at) VALUES ('1003800580026U-34', 30000, 'a@b.co', '${T0}', '${T0}');
  `);
  return { db, repo: new SqliteNotificationRepo(db) };
}

const base = (o: Partial<NewNotification> = {}): NewNotification => ({
  alertId: 1, healthEventId: null, observationId: 1, kind: 'ATINGIDO', idempotencyKey: key('a'), mode: 'teste',
  productCode: '1003800580026U', productName: 'Old Skool', productSlug: 'old-skool', size: '34',
  priceCents: 30000, targetCents: 30000, marginBp: 300, observedAt: T0, source: 'occ',
  degraded: false, alreadyInBand: false, now: T0, ...o,
});

test('T-DUP-07 insertIfAbsent: mesma chave devolve created:false e o mesmo id', () => {
  const { db, repo } = setup();
  const a = repo.insertIfAbsent(base());
  const b = repo.insertIfAbsent(base());
  assert.equal(a.created, true);
  assert.deepEqual(b, { id: a.id, created: false });
  assert.equal((db.prepare('SELECT count(*) c FROM notifications').get() as { c: number }).c, 1);
});

test('T-DUP-07 segunda barreira: chave diferente, mesmo (alert, obs, kind) nao duplica', () => {
  const { repo } = setup();
  const a = repo.insertIfAbsent(base());
  const b = repo.insertIfAbsent(base({ idempotencyKey: key('b') }));
  assert.deepEqual(b, { id: a.id, created: false });
  assert.equal(repo.insertIfAbsent(base({ idempotencyKey: key('c'), observationId: 2 })).created, true);
  assert.equal(repo.insertIfAbsent(base({ idempotencyKey: key('d'), kind: 'PROXIMO' })).created, true);
});

test('T-SM-02 claimDue: attempts++ e lease de 10 min; segundo drain nao pega a mesma linha', () => {
  const { repo } = setup();
  const { id } = repo.insertIfAbsent(base());
  assert.deepEqual(repo.claimDue(at(-1), 10), []);
  const [row] = repo.claimDue(T0, 10);
  assert.equal(row!.id, id);
  assert.equal(row!.attempts, 1);
  assert.equal(row!.nextAttemptAt, at(10));
  assert.deepEqual(repo.claimDue(at(5), 10), []);
  assert.equal(repo.claimDue(at(10), 10)[0]!.attempts, 2); // lease vencido (crash): reenvio
});

test('T-NOT-08 claimDue respeita limit e nao pega alerta PAUSADO', () => {
  const { db, repo } = setup();
  repo.insertIfAbsent(base());
  repo.insertIfAbsent(base({ idempotencyKey: key('b'), observationId: 2 }));
  assert.equal(repo.claimDue(T0, 1).length, 1);
  db.prepare(`UPDATE price_alerts SET status = 'PAUSADO', paused_at = ? WHERE id = 1`).run(T0);
  assert.deepEqual(repo.claimDue(at(10), 10), []);
});

test('T-SM-02 markAccepted: ACEITO terminal, simulado em modo teste; linha removida e no-op', () => {
  const { db, repo } = setup();
  const { id } = repo.insertIfAbsent(base());
  repo.claimDue(T0, 1);
  repo.markAccepted(id, { providerMessageId: 'm1', now: at(1), simulated: true });
  const [row] = repo.listForAlert(1);
  assert.equal(row!.status, 'ACEITO');
  assert.equal(row!.simulated, true);
  assert.equal(row!.acceptedAt, at(1));
  assert.equal(row!.nextAttemptAt, null);
  repo.markAttemptFailed(id, { nextAttemptAt: null, reason: 'x', now: at(2) }); // terminal: ignorado
  assert.equal(repo.listForAlert(1)[0]!.status, 'ACEITO');
  db.prepare('DELETE FROM price_alerts').run();
  repo.markAccepted(id, { providerMessageId: 'm2', now: at(3), simulated: false }); // no-op, nao lanca
});

test('T-SM-02 markAttemptFailed: data vira retentativa PENDENTE; null vira FALHA', () => {
  const { repo } = setup();
  const { id } = repo.insertIfAbsent(base());
  repo.claimDue(T0, 1);
  repo.markAttemptFailed(id, { nextAttemptAt: at(5), reason: 'temp', now: at(1) });
  let row = repo.listForAlert(1)[0]!;
  assert.deepEqual([row.status, row.nextAttemptAt, row.failureReason], ['PENDENTE', at(5), 'temp']);
  repo.claimDue(at(5), 1);
  repo.markAttemptFailed(id, { nextAttemptAt: null, reason: 'smtp_permanente', now: at(6) });
  row = repo.listForAlert(1)[0]!;
  assert.deepEqual([row.status, row.failureReason, row.nextAttemptAt], ['FALHA', 'smtp_permanente', null]);
  assert.deepEqual(repo.claimDue(at(60), 10), []);
});

test('T-SM-02 resend: so FALHA volta a PENDENTE, mesma linha e chave, attempts=0', () => {
  const { repo } = setup();
  const { id } = repo.insertIfAbsent(base());
  assert.equal(repo.resend(id, at(1)), false); // PENDENTE
  repo.claimDue(T0, 1);
  repo.markAttemptFailed(id, { nextAttemptAt: null, reason: 'x', now: at(1) });
  assert.equal(repo.resend(id, at(2)), true);
  const [row] = repo.listForAlert(1);
  assert.deepEqual([row!.id, row!.status, row!.attempts, row!.idempotencyKey], [id, 'PENDENTE', 0, key('a')]);
  assert.equal(repo.claimDue(at(2), 1).length, 1);
});

test('T-SM-02 4 tentativas iniciadas e lease vencido: encerra como FALHA sem estourar o CHECK', () => {
  const { repo } = setup();
  const { id } = repo.insertIfAbsent(base());
  for (let i = 0; i < 4; i++) assert.equal(repo.claimDue(at(10 * i), 1).length, 1);
  assert.deepEqual(repo.claimDue(at(40), 1), []);
  const [row] = repo.listForAlert(1);
  assert.deepEqual([row!.id, row!.status, row!.failureReason], [id, 'FALHA', 'tentativas_esgotadas']);
});

test('SAUDE sem alerta e claimable (RF-08)', () => {
  const { db, repo } = setup();
  db.prepare(`INSERT INTO health_events (kind, subject, opened_at) VALUES ('circuito_aberto', 'global', ?)`).run(T0);
  const n = repo.insertIfAbsent(
    base({ alertId: null, healthEventId: 1, observationId: null, kind: 'SAUDE', idempotencyKey: key('s') }),
  );
  assert.equal(repo.claimDue(T0, 5)[0]!.id, n.id);
});
