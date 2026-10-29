import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDb } from '../../src/store/memory.ts';
import { createObservationRepo } from '../../src/store/history.store.ts';
import { StoreConstraintError, type NewObservation } from '../../src/store/ports.ts';

const V = '1003800580026U-34';
const W = '1003800580026U-35';
const T0 = '2026-10-14T12:00:00.000Z';
const setup = () => createObservationRepo(createMemoryDb());
const obs = (o: Partial<NewObservation> = {}): NewObservation => ({
  variantCode: V, runId: 1, seq: 1, observedAt: T0, originalCents: 64999, currentCents: 37999,
  available: true, confirmed: true, degraded: false, source: 'occ', ...o,
});

test('T25 / T-HST-04 [runId,variantCode,seq] repetido lança StoreConstraintError; não duplica', async () => {
  const r = setup();
  await r.insert(obs());
  await assert.rejects(r.insert(obs({ currentCents: 30000 })), StoreConstraintError);
  assert.equal((await r.history(V, 10, 0)).length, 1);
  await r.insert(obs({ seq: 2 }));
  await r.insert(obs({ runId: 2 }));
  await r.insert(obs({ variantCode: W }));
  assert.equal((await r.history(V, 10, 0)).length, 3);
});

test('T25 / T-HST-02 RF-11-AC2 currentCents <= 0 (e inválidos) recusado; nada gravado', async () => {
  const r = setup();
  for (const c of [0, -1, 1.5, NaN]) await assert.rejects(r.insert(obs({ currentCents: c })), StoreConstraintError);
  await assert.rejects(r.insert(obs({ originalCents: 1000, currentCents: 2000 })), StoreConstraintError);
  assert.deepEqual(await r.history(V, 10, 0), []);
  assert.equal(await r.latestConfirmed(V), null);
  assert.equal(await r.stats(V), null);
});

test('T25 / T-HST-01 history em ordem decrescente e paginada', async () => {
  const r = setup();
  for (let h = 0; h < 5; h++) await r.insert(obs({ runId: h + 1, observedAt: `2026-10-14T0${h}:00:00.000Z` }));
  await r.insert(obs({ variantCode: W, runId: 9 }));
  const all = await r.history(V, 10, 0);
  assert.deepEqual(all.map((x) => x.observedAt.slice(11, 13)), ['04', '03', '02', '01', '00']);
  assert.deepEqual((await r.history(V, 2, 2)).map((x) => x.observedAt.slice(11, 13)), ['02', '01']);
  assert.deepEqual(await r.history(V, 2, 5), []);
});

test('T25 / T-HST-03 RN-09c latestConfirmed x latestUnconfirmed; confirm vira confirmada', async () => {
  const r = setup();
  const a = await r.insert(obs({ confirmed: false, currentCents: 30000, observedAt: '2026-10-14T10:00:00.000Z' }));
  assert.equal(await r.latestConfirmed(V), null);
  assert.equal((await r.latestUnconfirmed(V))?.id, a);
  const b = await r.insert(obs({ runId: 2, currentCents: 30000, observedAt: '2026-10-14T14:00:00.000Z' }));
  await r.confirm(a, b);
  const row = (await r.latestConfirmed(V))!;
  assert.equal(row.id, b);
  assert.equal(await r.latestUnconfirmed(V), null);
  const first = (await r.history(V, 10, 0)).find((x) => x.id === a)!;
  assert.equal(first.confirmed, true);
  assert.equal(first.confirmedBy, b);
  await assert.rejects(r.confirm(999, b), StoreConstraintError);
});

test('T25 / T-HST-03 stats só de confirmadas (mín/máx/contagem)', async () => {
  const r = setup();
  await r.insert(obs({ seq: 1, currentCents: 50000 }));
  await r.insert(obs({ seq: 2, currentCents: 37999 }));
  await r.insert(obs({ seq: 3, currentCents: 1000, confirmed: false }));
  await r.insert(obs({ seq: 4, currentCents: 60000, variantCode: W }));
  assert.deepEqual(await r.stats(V), { minCents: 37999, maxCents: 50000, count: 2 });
});

test('T25 latest desempata por seq no mesmo instante (releitura seq=2)', async () => {
  const r = setup();
  await r.insert(obs({ seq: 1, confirmed: false, currentCents: 40000 }));
  const s2 = await r.insert(obs({ seq: 2, confirmed: false, currentCents: 40000 }));
  assert.equal((await r.latestUnconfirmed(V))?.id, s2);
});
