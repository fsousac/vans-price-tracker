import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ManualClock } from '../helpers/clock.ts';
import { createMemoryDb, type MemoryDb } from '../../src/store/memory.ts';
import { createKvStore } from '../../src/store/state.store.ts';
import { createHealthEventStore } from '../../src/store/events.store.ts';
import { createRequestLog } from '../../src/store/monitor.store.ts';
import { createHealthReadStore } from '../../src/store/health.store.ts';
import { buildHealth } from '../../src/app/health.ts';
import { DAILY_BUDGET } from '../../src/app/rate-gate.ts';

const T0 = '2026-10-14T12:00:00.000Z';
const H = 3_600_000;
const iso = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();

function setup() {
  const db = createMemoryDb();
  const clock = new ManualClock(T0);
  const kv = createKvStore(db);
  const events = createHealthEventStore(db);
  const requests = createRequestLog(db);
  const deps = {
    read: createHealthReadStore(db), kv, events, requests, clock, version: '0.2.0',
    intervalMs: 4 * H, installedAt: new Date(T0), emailMode: 'teste' as const,
  };
  return { db, clock, kv, events, requests, deps };
}
const addAlert = (db: MemoryDb) => db.add('alerts', { variantCode: 'P1-34', status: 'ATIVO', targetCents: 20000 });
const addRun = (db: MemoryDb, status: string, finishedMs: number) =>
  db.add('runs', { kind: 'monitor', trigger: 'scheduled', status, startedAt: iso(finishedMs - 60_000), finishedAt: iso(finishedMs), itemsOk: 3, itemsFailed: 1 });

test('T-OBS-01 RF-12-AC1 estado inicial: ok, sem rodada, orçamento cheio', async () => {
  const { deps } = setup();
  const h = await buildHealth(deps);
  assert.equal(h.scheduler.status, 'ok');
  assert.equal(h.scheduler.lastRun, null);
  assert.deepEqual(h.circuit, { open: false, reason: null, until: null });
  assert.deepEqual(h.budget24h, { used: 0, limit: DAILY_BUDGET, remaining: DAILY_BUDGET });
  assert.deepEqual(h.openEvents, []);
});

test('T-OBS-02 RF-12-AC2 atrasado só com alerta ativo e > 2*I desde a última rodada (ou instalação)', async () => {
  const { db, clock, deps } = setup();
  await clock.advance(9 * H);
  assert.equal((await buildHealth(deps)).scheduler.status, 'ok'); // sem alertas
  await addAlert(db);
  assert.equal((await buildHealth(deps)).scheduler.status, 'atrasado'); // nunca rodou, 9 h > 8 h
  await addRun(db, 'ok', 8 * H);
  const h = await buildHealth(deps);
  assert.equal(h.scheduler.status, 'ok');
  assert.equal(h.scheduler.lastRun?.itemsOk, 3);
  await clock.advance(8 * H + 1);
  assert.equal((await buildHealth(deps)).scheduler.status, 'atrasado');
});

test('T-OBS-04 RN-18 circuito aberto => pausado_circuito com motivo; vencido => fechado', async () => {
  const { clock, kv, deps } = setup();
  await kv.set('circuit_open_until', iso(24 * H));
  await kv.set('circuit_reason', 'http_429_repetido');
  const h = await buildHealth(deps);
  assert.equal(h.scheduler.status, 'pausado_circuito');
  assert.deepEqual(h.circuit, { open: true, reason: 'http_429_repetido', until: iso(24 * H) });
  await clock.advance(25 * H);
  const h2 = await buildHealth(deps);
  assert.equal(h2.circuit.open, false);
  assert.equal(h2.circuit.reason, null);
});

test('T-OBS-05 RN-17 frescor via shared/freshness por alerta ativo', async () => {
  const { db, deps } = setup();
  for (const [v, min] of [['A', 1], ['B', 10 * 60], ['C', 48 * 60]] as const) {
    await db.add('alerts', { variantCode: v, status: 'ATIVO' });
    await db.add('observations', { variantCode: v, runId: 1, seq: 1, observedAt: iso(-min * 60_000), confirmed: true, source: 'occ' });
  }
  await db.add('alerts', { variantCode: 'D', status: 'ATIVO' }); // sem leitura
  await db.add('alerts', { variantCode: 'E', status: 'PAUSADO' }); // ignorado
  assert.deepEqual((await buildHealth(deps)).freshness, { fresco: 1, defasado: 1, sem_dados: 2 });
});

test('T-OBS-06 RNF-REL-04 orçamento 24 h conta só requisições da janela', async () => {
  const { requests, deps, clock } = setup();
  await clock.advance(30 * H);
  await requests.record('monitor', iso(0)); // 30 h atrás: fora
  for (let i = 0; i < 5; i++) await requests.record('monitor', iso(29 * H));
  assert.deepEqual((await buildHealth(deps)).budget24h, { used: 5, limit: DAILY_BUDGET, remaining: DAILY_BUDGET - 5 });
});

test('T-OBS-03 eventos abertos aparecem; fechados não; sem detalhe livre', async () => {
  const { events, deps } = setup();
  await events.open('parser_degradado', 'P1', 'corpo da loja', T0);
  await events.open('produto_com_falha', 'P2', null, T0);
  await events.close('produto_com_falha', 'P2', T0);
  const h = await buildHealth(deps);
  assert.equal(h.openEvents.length, 1);
  assert.deepEqual(Object.keys(h.openEvents[0]!).sort(), ['id', 'kind', 'openedAt', 'subject']);
});

test('T-SEC-LOG RNF-SEC payload de saúde sem e-mail, chave nem nome de produto', async () => {
  const { db, kv, events, deps } = setup();
  await kv.set('settings', JSON.stringify({ email: 'segredo@example.com', apiKey: 're_SEGREDO' }));
  await db.add('alerts', { variantCode: 'P1-34', status: 'ATIVO', email: 'segredo@example.com' });
  await db.add('notifications', { key: 'k', emailStatus: 'PENDENTE', productName: 'Tenis Secreto' });
  await events.open('parser_degradado', 'P1', 'segredo@example.com', T0);
  const json = JSON.stringify(await buildHealth(deps));
  for (const s of ['segredo', 're_SEGREDO', 'Secreto', '@']) assert.ok(!json.includes(s), s);
  assert.equal(JSON.parse(json).counters.notificationsByStatus.PENDENTE, 1);
});
