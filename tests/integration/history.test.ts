import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from '../helpers/db.ts';
import { ManualClock } from '../helpers/clock.ts';
import { SqliteObservationRepo } from '../../src/price-history/history.repo.ts';
import { HistoryService } from '../../src/price-history/history.service.ts';
import type { NewObservation } from '../../src/price-history/ports.ts';

const V = '1003800580026U-34';
const T0 = '2026-10-14T12:00:00.000Z';
const HOUR = 3_600_000;

function setup() {
  const db = makeDb();
  db.prepare(`INSERT INTO products (code, name, created_at, updated_at) VALUES ('1003800580026U','Hylane',?,?)`).run(T0, T0);
  db.prepare(`INSERT INTO product_variants (variant_code, product_code, size, last_seen_at) VALUES (?, '1003800580026U','34',?)`).run(V, T0);
  const run = (): number =>
    Number(
      db
        .prepare(`INSERT INTO monitoring_runs (kind, trigger, status, started_at, finished_at) VALUES ('monitor','manual','ok',?,?)`)
        .run(T0, T0).lastInsertRowid,
    );
  const clock = new ManualClock(T0);
  const repo = new SqliteObservationRepo(db);
  return { run, clock, repo, svc: new HistoryService(repo, clock) };
}
const obs = (runId: number, o: Partial<NewObservation> = {}): NewObservation => ({
  variantCode: V, runId, seq: 1, observedAt: T0, originalCents: 64999, currentCents: 37999,
  available: true, confirmed: true, degraded: false, source: 'occ', ...o,
});

test('T-HST-01 série em ordem decrescente com desconto % calculado (Hylane 41%)', () => {
  const { run, repo, svc } = setup();
  repo.insert(obs(run(), { observedAt: '2026-10-14T10:00:00.000Z', currentCents: 50000 }));
  repo.insert(obs(run()));
  const s = svc.series(V);
  assert.deepEqual(s.map((p) => p.observedAt), [T0, '2026-10-14T10:00:00.000Z']);
  assert.equal(s[0]!.discountPct, 41);
  assert.equal(s[0]!.available, true);
  assert.equal(svc.series(V, 1, 1).length, 1);
});

test('T-HST-02 sem observação não há ponto; preço 0 é inexpressável no banco', () => {
  const { run, repo, svc } = setup();
  assert.deepEqual(svc.series(V), []);
  assert.throws(() => repo.insert(obs(run(), { currentCents: 0 })));
  assert.deepEqual(svc.series(V), []);
});

test('T-HST-03 mín/máx só consideram confirmadas; não confirmada vem marcada', () => {
  const { run, repo, svc } = setup();
  repo.insert(obs(run(), { currentCents: 40000, observedAt: '2026-10-14T09:00:00.000Z' }));
  repo.insert(obs(run(), { currentCents: 50000, observedAt: '2026-10-14T10:00:00.000Z' }));
  repo.insert(obs(run(), { currentCents: 1000, confirmed: false, observedAt: '2026-10-14T11:00:00.000Z' }));
  const sum = svc.summary(V, HOUR);
  assert.equal(sum.minCents, 40000);
  assert.equal(sum.maxCents, 50000);
  assert.equal(sum.confirmedCount, 2);
  assert.equal(sum.points[0]!.confirmed, false);
  assert.equal(repo.latestUnconfirmed(V)!.currentCents, 1000);
});

test('T-HST-03 sem confirmadas: stats nulas e sem_dados', () => {
  const { run, repo, svc } = setup();
  repo.insert(obs(run(), { confirmed: false }));
  const sum = svc.summary(V, HOUR);
  assert.equal(sum.minCents, null);
  assert.equal(sum.freshness, 'sem_dados');
});

test('T-HST-03 confirmação posterior inclui a leitura em mín/máx', () => {
  const { run, repo, svc } = setup();
  const pending = repo.insert(obs(run(), { currentCents: 20000, confirmed: false, observedAt: '2026-10-14T11:00:00.000Z' }));
  const by = repo.insert(obs(run(), { currentCents: 20000 }));
  svc.confirmLater(pending, by);
  assert.equal(repo.latestUnconfirmed(V), null);
  assert.equal(repo.stats(V)!.count, 2);
  assert.equal(repo.history(V, 10, 0).find((o) => o.id === pending)!.confirmedBy, by);
});

test('T-HST-04 UNIQUE(run_id,variant,seq) não duplica; seq=2 é aceito', () => {
  const { run, repo } = setup();
  const r = run();
  repo.insert(obs(r));
  assert.throws(() => repo.insert(obs(r)), /UNIQUE/);
  repo.insert(obs(r, { seq: 2 }));
  assert.equal(repo.history(V, 10, 0).length, 2);
});

test('T-HST-04 uma observação por rodada sem mudança de preço; frescor segue o relógio', async () => {
  const { run, repo, svc, clock } = setup();
  repo.insert(obs(run()));
  repo.insert(obs(run(), { observedAt: '2026-10-14T12:30:00.000Z' }));
  assert.equal(svc.series(V).length, 2);
  assert.equal(svc.summary(V, HOUR).freshness, 'fresco');
  await clock.advance(4 * HOUR);
  assert.equal(svc.summary(V, HOUR).freshness, 'defasado');
  await clock.advance(25 * HOUR);
  assert.equal(svc.summary(V, HOUR).freshness, 'sem_dados');
});
