import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMemoryDb } from '../../src/store/memory.ts';
import { createHealthEventStore } from '../../src/store/events.store.ts';
import { createKvStore } from '../../src/store/state.store.ts';
import { createSettingsStore } from '../../src/store/settings.store.ts';
import { createHealthReadStore } from '../../src/store/health.store.ts';

const T0 = '2026-10-14T12:00:00.000Z';
const T1 = '2026-10-14T13:00:00.000Z';

// Espelha T28 / RNF-OBS-03: 1 episódio aberto por (kind, subject)
test('events: open duas vezes = 1 episódio; close e reabrir cria outro (RNF-OBS-03, T-OBS-03)', async () => {
  const ev = createHealthEventStore(createMemoryDb());
  const a = await ev.open('produto_com_falha', 'P0000001', 'x', T0);
  const b = await ev.open('produto_com_falha', 'P0000001', 'y', T1);
  assert.deepEqual([a.created, b.created, b.id], [true, false, a.id]);
  await ev.open('produto_com_falha', 'P0000002', null, T0);
  assert.equal((await ev.listOpen()).length, 2);
  await ev.close('produto_com_falha', 'P0000001', T1);
  assert.deepEqual((await ev.listOpen()).map((e) => e.subject), ['P0000002']);
  const c = await ev.open('produto_com_falha', 'P0000001', null, T1);
  assert.equal(c.created, true);
  assert.notEqual(c.id, a.id);
});

test('kv: get/set/delete e persiste entre instâncias (SW efêmero, EA seção 6)', async () => {
  const db = createMemoryDb();
  const kv = createKvStore(db);
  assert.equal(await kv.get('last_tick_at'), null);
  await kv.set('last_tick_at', T0);
  await kv.set('circuit_open_until', T1);
  assert.equal(await createKvStore(createMemoryDb({ state: db.dump() })).get('last_tick_at'), T0);
  await kv.delete('last_tick_at');
  assert.equal(await kv.get('last_tick_at'), null);
  assert.equal(await kv.get('circuit_open_until'), T1);
});

test('settings: sem registro devolve padrões; apiKey nunca na visão pública (RF-08, T-SEG)', async () => {
  const kv = createKvStore(createMemoryDb());
  const s = createSettingsStore(kv);
  const d = await s.getPublic();
  assert.equal(d.intervalHours, 4);
  assert.equal(d.email.mode, 'teste');
  assert.equal(d.email.apiKeySet, false);

  const r = await s.set({ intervalHours: 3, email: { mode: 'real', enabled: true, to: 'a@b.com', from: 'c@d.com', apiKey: 're_secret123' } });
  assert.ok(r.ok);
  const pub = await s.getPublic();
  assert.equal(pub.email.apiKeySet, true);
  assert.ok(!JSON.stringify(pub).includes('re_secret123'));
  assert.ok(!('apiKey' in pub.email));
  const internal = await s.get();
  assert.equal(internal.email.apiKey, 're_secret123'); // serviço interno lê
  assert.ok(!JSON.stringify(internal).includes('re_secret123')); // toJSON redigido
  assert.ok((await kv.get('settings'))!.includes('re_secret123')); // só em storage local

  await s.set({ intervalHours: 5 }); // apiKey ausente mantém
  assert.equal((await s.get()).email.apiKey, 're_secret123');
  const off = await s.set({ email: { enabled: false, apiKey: '' } }); // '' remove
  assert.ok(off.ok && !off.value.email.apiKeySet);
});

test('settings: intervalo fora de 2-6 h e e-mail com CRLF recusados, nada gravado', async () => {
  const kv = createKvStore(createMemoryDb());
  const s = createSettingsStore(kv);
  const bad = await s.set({ intervalHours: 7, email: { to: 'a@b.com\r\nBcc: x@y.com' } });
  assert.ok(!bad.ok);
  if (!bad.ok) assert.ok(bad.error.intervalHours && bad.error.to);
  assert.equal(await kv.get('settings'), null);
});

test('settings: registro corrompido ou parcial vira padrão por campo', async () => {
  const kv = createKvStore(createMemoryDb());
  await kv.set('settings', '{nao json');
  assert.equal((await createSettingsStore(kv).getPublic()).intervalHours, 4);
  await kv.set('settings', JSON.stringify({ v: 1, intervalHours: 3 }));
  const p = await createSettingsStore(kv).getPublic();
  assert.equal(p.intervalHours, 3);
  assert.equal(p.email.mode, 'teste');
});

test('health read: contadores somente leitura sobre stores alheios (T-SAU-01/05)', async () => {
  const db = createMemoryDb();
  const h = createHealthReadStore(db);
  assert.equal(await h.lastFinishedRun(), null);
  assert.equal(await h.lastObservationAt(), null);
  assert.equal(await h.activeAlertCount(), 0);

  const run = (o: object) => db.add('runs', { kind: 'monitor', trigger: 'scheduled', itemsOk: 0, itemsFailed: 0, ...o });
  await run({ status: 'ok', startedAt: T0, finishedAt: T0, itemsOk: 3 });
  await run({ status: 'skipped', startedAt: T1, finishedAt: T1 });
  await run({ status: 'running', startedAt: T1, finishedAt: null });
  const last = await h.lastFinishedRun();
  assert.equal(last?.status, 'ok');
  assert.equal(last?.itemsOk, 3);
  assert.deepEqual(await h.runsByStatus(), { ok: 1, skipped: 1, running: 1 });

  await db.add('alerts', { variantCode: 'V1', status: 'ATIVO' });
  await db.add('alerts', { variantCode: 'V2', status: 'ATIVO' });
  await db.add('alerts', { variantCode: 'V3', status: 'PAUSADO' });
  let n = 0;
  const obs = (variantCode: string, observedAt: string, confirmed: boolean, source = 'occ') =>
    db.add('observations', { variantCode, observedAt, confirmed, source, runId: 1, seq: ++n });
  await obs('V1', T0, true);
  await obs('V1', T1, false, 'nextdata');
  assert.equal(await h.activeAlertCount(), 2);
  assert.deepEqual(await h.activeAlertLastConfirmed(), [T0, null]); // não confirmada não conta
  assert.deepEqual(await h.observationsBySource(), { occ: 1, nextdata: 1 });
  assert.equal(await h.lastObservationAt(), T1);

  const item = (seq: number, outcome: string, finishedAt: string, failureClass?: string) =>
    db.put('run_items', { runId: 1, seq, outcome, finishedAt, failureClass });
  await item(1, 'ok', T1);
  await item(2, 'degradado', T1);
  await item(3, 'falha', T1, 'timeout');
  await item(4, 'pulado', T1);
  await item(5, 'falha', T0, 'timeout');
  assert.deepEqual(await h.itemsSince(T1), { ok: 2, failedByClass: { timeout: 1 } });

  await db.put('notifications', { key: 'a', emailStatus: 'ACEITO' });
  await db.put('notifications', { key: 'b', emailStatus: 'PENDENTE' });
  assert.deepEqual(await h.notificationsByStatus(), { ACEITO: 1, PENDENTE: 1 });
});
