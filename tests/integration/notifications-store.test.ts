// T27 (store IndexedDB/memória): canais desktop e e-mail. RF-08, RF-10-AC1, RN-12, RN-15.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDb } from '../../src/store/memory.ts';
import { IdbNotificationRepo } from '../../src/store/notifications.store.ts';
import type { NewNotification } from '../../src/store/ports.ts';

const T0 = '2026-10-14T12:00:00.000Z' as never;
const at = (min: number) => new Date(Date.parse(T0) + min * 60_000).toISOString() as never;
const K = '1|1|ATINGIDO|1';

async function setup() {
  const db = createMemoryDb();
  await db.put('alerts', { id: 1, variantCode: 'v', status: 'ATIVO' });
  return { db, repo: new IdbNotificationRepo(db) };
}
const base = (o: Partial<NewNotification> = {}): NewNotification => ({
  key: K, alertId: 1, healthEventId: null, observationId: 1, kind: 'ATINGIDO', emailEnabled: true, mode: 'teste',
  productCode: '1003800580026U', productName: 'Old Skool', productSlug: 'old-skool', size: '34',
  priceCents: 30000 as never, targetCents: 30000 as never, marginBp: 300 as never, observedAt: T0, source: 'occ',
  degraded: false, alreadyInBand: false, now: T0, ...o,
});

test('T-DUP-07 insertIfAbsent idempotente pela chave composta em texto', async () => {
  const { db, repo } = await setup();
  assert.deepEqual(await repo.insertIfAbsent(base()), { created: true });
  assert.deepEqual(await repo.insertIfAbsent(base({ priceCents: 1 as never })), { created: false });
  assert.equal(await db.count('notifications'), 1);
  assert.equal((await repo.get(K))!.priceCents, 30000); // original preservado
});

test('T-SM-02 e-mail desligado: fora da fila de e-mail, desktop pendente', async () => {
  const { repo } = await setup();
  await repo.insertIfAbsent(base({ emailEnabled: false }));
  const r = (await repo.get(K))!;
  assert.deepEqual([r.email, r.desktop, r.nextAttemptAt], ['desligado', 'pendente', null]);
  assert.deepEqual(await repo.claimDue(at(60), 10), []);
  assert.equal(await repo.nextAttemptAt(), null);
  assert.equal((await repo.listPendingDesktop(5)).length, 1);
});

test('T-SM-02 claimDue: attempts++ e lease 10 min; segundo drain nao pega; lease vencido reenvia', async () => {
  const { repo } = await setup();
  await repo.insertIfAbsent(base());
  assert.deepEqual(await repo.claimDue(at(-1), 10), []);
  const [row] = await repo.claimDue(T0, 10);
  assert.equal(row!.attempts, 1);
  assert.equal(row!.nextAttemptAt, at(10));
  assert.deepEqual(await repo.claimDue(at(5), 10), []);
  assert.equal((await repo.claimDue(at(10), 10))[0]!.attempts, 2);
  assert.equal(await repo.nextAttemptAt(), at(20));
});

test('T-NOT-08 claimDue respeita limit e alerta PAUSADO; SAUDE sem alerta e claimable', async () => {
  const { db, repo } = await setup();
  await repo.insertIfAbsent(base());
  await repo.insertIfAbsent(base({ key: '1|1|PROXIMO|1', kind: 'PROXIMO' }));
  assert.equal((await repo.claimDue(T0, 1)).length, 1);
  await db.put('alerts', { id: 1, variantCode: 'v', status: 'PAUSADO' });
  assert.deepEqual(await repo.claimDue(at(10), 10), []);
  await repo.insertIfAbsent(base({ key: 'saude|1', alertId: null, healthEventId: 1, observationId: null, kind: 'SAUDE' }));
  assert.deepEqual((await repo.claimDue(at(10), 10)).map((r) => r.key), ['saude|1']);
});

test('T-SM-02 markAccepted: ACEITO terminal e simulado; chave ausente e no-op', async () => {
  const { repo } = await setup();
  await repo.insertIfAbsent(base());
  await repo.claimDue(T0, 1);
  await repo.markAccepted(K, { providerMessageId: 'm1', now: at(1), simulated: true });
  const r = (await repo.get(K))!;
  assert.deepEqual([r.email, r.simulated, r.acceptedAt, r.nextAttemptAt, r.providerMessageId], ['ACEITO', true, at(1), null, 'm1']);
  await repo.markAttemptFailed(K, { nextAttemptAt: null, reason: 'x', now: at(2) }); // terminal
  assert.equal((await repo.get(K))!.email, 'ACEITO');
  await repo.markAccepted('nao-existe', { providerMessageId: 'm', now: at(3), simulated: false });
  assert.equal(await repo.get('nao-existe'), null);
});

test('T-SM-02 markAttemptFailed: data vira PENDENTE; null vira FALHA e sai da fila', async () => {
  const { repo } = await setup();
  await repo.insertIfAbsent(base());
  await repo.claimDue(T0, 1);
  await repo.markAttemptFailed(K, { nextAttemptAt: at(5), reason: 'temp', now: at(1) });
  let r = (await repo.get(K))!;
  assert.deepEqual([r.email, r.nextAttemptAt, r.failureReason], ['PENDENTE', at(5), 'temp']);
  await repo.claimDue(at(5), 1);
  await repo.markAttemptFailed(K, { nextAttemptAt: null, reason: 'permanente', now: at(6) });
  r = (await repo.get(K))!;
  assert.deepEqual([r.email, r.failureReason, r.nextAttemptAt], ['FALHA', 'permanente', null]);
  assert.deepEqual(await repo.claimDue(at(60), 10), []);
});

test('T-SM-02 resend: so FALHA volta a PENDENTE com attempts=0', async () => {
  const { repo } = await setup();
  await repo.insertIfAbsent(base());
  assert.equal(await repo.resend(K, at(1)), false);
  await repo.claimDue(T0, 1);
  await repo.markAttemptFailed(K, { nextAttemptAt: null, reason: 'x', now: at(1) });
  assert.equal(await repo.resend(K, at(2)), true);
  const r = (await repo.get(K))!;
  assert.deepEqual([r.email, r.attempts, r.failureReason], ['PENDENTE', 0, null]);
  assert.equal((await repo.claimDue(at(2), 1)).length, 1);
  assert.equal(await repo.resend('nao-existe', at(3)), false);
});

test('T-SM-02 4 tentativas e lease vencido: encerra FALHA tentativas_esgotadas', async () => {
  const { repo } = await setup();
  await repo.insertIfAbsent(base());
  for (let i = 0; i < 4; i++) assert.equal((await repo.claimDue(at(10 * i), 1)).length, 1);
  assert.deepEqual(await repo.claimDue(at(40), 1), []);
  const r = (await repo.get(K))!;
  assert.deepEqual([r.email, r.failureReason], ['FALHA', 'tentativas_esgotadas']);
});

test('markDesktop resolve uma vez; listPendingDesktop e listForAlert (mais recente primeiro)', async () => {
  const { repo } = await setup();
  await repo.insertIfAbsent(base());
  await repo.insertIfAbsent(base({ key: '1|1|PROXIMO|1', kind: 'PROXIMO', now: at(1) }));
  assert.equal((await repo.listPendingDesktop(1)).length, 1);
  await repo.markDesktop(K, 'mostrada', null, at(2));
  await repo.markDesktop('1|1|PROXIMO|1', 'falha', 'sem_permissao', at(2));
  await repo.markDesktop('1|1|PROXIMO|1', 'mostrada', null, at(3)); // ja resolvida: ignora
  assert.deepEqual(await repo.listPendingDesktop(5), []);
  const list = await repo.listForAlert(1);
  assert.deepEqual(list.map((r) => [r.key, r.desktop]), [['1|1|PROXIMO|1', 'falha'], [K, 'mostrada']]);
  assert.equal(list[0]!.failureReason, 'sem_permissao');
});
