import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ManualClock } from '../helpers/clock.ts';
import { createMemoryDb } from '../../src/store/memory.ts';
import { createObservationRepo } from '../../src/store/history.store.ts';
import type { NewObservation } from '../../src/store/ports.ts';
import { createHistoryService, discountPct } from '../../src/app/history.ts';

const V = '1003800580026U-34';
const T0 = '2026-10-14T12:00:00.000Z';
const H = 3_600_000;
const at = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();
const obs = (o: Partial<NewObservation>): NewObservation => ({
  variantCode: V, runId: 1, seq: 1, observedAt: T0, originalCents: 64999, currentCents: 37999,
  available: true, confirmed: true, degraded: false, source: 'occ', ...o,
});
const setup = () => {
  const repo = createObservationRepo(createMemoryDb());
  return { repo, svc: createHistoryService(repo, new ManualClock(at(H))) };
};

test('T-HST-03 RF-07-AC2 desconto calculado (trunca), 0 sem desconto', async () => {
  assert.equal(discountPct(64999, 37999), 41);
  assert.equal(discountPct(1000, 1000), 0);
  const { repo, svc } = setup();
  await repo.insert(obs({}));
  assert.equal((await svc.series(V))[0]!.discountPct, 41);
});

test('T-HST-05 RF-07-AC4/5 mín/máx só confirmadas; pendente aparece na série mas não no resumo', async () => {
  const { repo, svc } = setup();
  await repo.insert(obs({ runId: 1, currentCents: 30000, observedAt: at(0) }));
  await repo.insert(obs({ runId: 2, currentCents: 40000, observedAt: at(-H) }));
  await repo.insert(obs({ runId: 3, currentCents: 100, confirmed: false, observedAt: at(H / 2) }));
  const s = await svc.summary(V, 4 * H);
  assert.equal(s.points.length, 3);
  assert.equal(s.points[0]!.confirmed, false);
  assert.equal(s.minCents, 30000);
  assert.equal(s.maxCents, 40000);
  assert.equal(s.confirmedCount, 2);
  assert.equal(s.lastConfirmedAt, at(0));
});

test('T-HST-06 RN-17 frescor da última confirmada; sem dados => nulos', async () => {
  const { repo, svc } = setup();
  const empty = await svc.summary(V, 4 * H);
  assert.deepEqual([empty.minCents, empty.maxCents, empty.freshness, empty.confirmedCount], [null, null, 'sem_dados', 0]);
  await repo.insert(obs({ observedAt: at(-9 * H) })); // 10 h > 2*4 h
  assert.equal((await svc.summary(V, 4 * H)).freshness, 'defasado');
  await repo.insert(obs({ runId: 2, observedAt: at(0) }));
  assert.equal((await svc.summary(V, 4 * H)).freshness, 'fresco');
});

test('T-HST-07 RN-09c confirmLater promove a pendente', async () => {
  const { repo, svc } = setup();
  const a = await repo.insert(obs({ runId: 1, currentCents: 20000, confirmed: false }));
  const b = await repo.insert(obs({ runId: 2, currentCents: 20000, observedAt: at(H / 2) }));
  assert.equal((await svc.summary(V, 4 * H)).confirmedCount, 1);
  await svc.confirmLater(a, b);
  assert.equal((await svc.summary(V, 4 * H)).confirmedCount, 2);
});

test('T-HST-01 paginação', async () => {
  const { repo, svc } = setup();
  for (let i = 0; i < 5; i++) await repo.insert(obs({ runId: i + 1, observedAt: at(-i * 60_000) }));
  const p = await svc.summary(V, 4 * H, 2, 2);
  assert.equal(p.points.length, 2);
  assert.equal(p.confirmedCount, 5);
});
