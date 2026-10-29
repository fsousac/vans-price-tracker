import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeDb } from '../helpers/db.ts';
import { createProductRepo, createRequestLog, createRunRepo } from '../../src/price-monitor/monitor.repo.ts';

const T0 = '2026-10-14T12:00:00.000Z';
const at = (min: number) => new Date(Date.parse(T0) + min * 60_000).toISOString();
const A = '1003800580026U';
const B = '1003800580099U';
const DONE = { status: 'ok', itemsTotal: 1, itemsOk: 1, itemsFailed: 0, requestsMade: 1, circuitOpened: false } as const;

function setup() {
  const db = makeDb();
  const products = createProductRepo(db);
  const runs = createRunRepo(db);
  const log = createRequestLog(db);
  const seed = (code: string, size = '34') => {
    products.upsertProduct({ code, name: 'Old Skool', legacySku: null, slug: 'old-skool' }, T0);
    products.upsertVariants(code, [{ variantCode: `${code}-${size}`, size, ean: null }], T0);
  };
  const alert = (code: string, status = 'ATIVO', size = '34') =>
    db
      .prepare(
        `INSERT INTO price_alerts (variant_code, target_cents, email, status, paused_at, created_at, updated_at)
         VALUES (?, 10000, 'a@b.co', ?, ?, ?, ?)`,
      )
      .run(`${code}-${size}`, status, status === 'PAUSADO' ? T0 : null, T0, T0);
  return { db, products, runs, log, seed, alert };
}

test('T-REL-03 tryStart falha com rodada running; libera apos finish (RNF-REL-03)', () => {
  const { runs } = setup();
  const r = runs.tryStart('monitor', 'scheduled', T0);
  assert.ok('runId' in r);
  assert.deepEqual(runs.tryStart('catalog', 'manual', at(1)), { skipped: 'anterior_em_andamento' });
  runs.finish(r.runId, DONE, at(2));
  assert.ok('runId' in runs.tryStart('monitor', 'scheduled', at(3)));
});

test('T-REL-03 markInterruptedOnStartup grava finished_at e libera o indice unico', () => {
  const { runs } = setup();
  runs.tryStart('monitor', 'scheduled', T0);
  assert.equal(runs.markInterruptedOnStartup(at(5)), 1);
  assert.equal(runs.markInterruptedOnStartup(at(6)), 0);
  const last = runs.lastFinished('monitor');
  assert.equal(last?.status, 'interrupted');
  assert.equal(last?.finishedAt, at(5));
  assert.ok('runId' in runs.tryStart('monitor', 'recovery', at(7)));
});

test('T-REL-03 recordSkipped nao ocupa o indice; lastFinished ignora running e skipped', () => {
  const { runs } = setup();
  const a = runs.tryStart('monitor', 'scheduled', T0);
  assert.ok('runId' in a);
  runs.finish(a.runId, { ...DONE, status: 'partial', circuitOpened: true }, at(1));
  runs.tryStart('monitor', 'scheduled', at(10)); // running
  runs.recordSkipped('monitor', 'manual', 'circuito_aberto', at(20));
  const last = runs.lastFinished('monitor');
  assert.equal(last?.id, a.runId);
  assert.equal(last?.circuitOpened, true);
  assert.equal(runs.lastFinished('catalog'), null);
});

test('T-REL-03 addItem grava falha, ok e pulado; lastSuccessfulItemAt so conta ok/degradado', () => {
  const { db, runs, seed } = setup();
  seed(A);
  const r = runs.tryStart('monitor', 'scheduled', T0);
  assert.ok('runId' in r);
  runs.addItem(r.runId, { productCode: A, seq: 1, outcome: 'falha', failureClass: 'http_5xx', httpStatus: 503, requests: 3, attempts: 3, finishedAt: at(1) });
  assert.equal(runs.lastSuccessfulItemAt(A), null);
  runs.finish(r.runId, { ...DONE, status: 'failed', itemsOk: 0, itemsFailed: 1 }, at(2));

  const r3 = runs.tryStart('monitor', 'scheduled', at(3));
  assert.ok('runId' in r3);
  runs.addItem(r3.runId, { productCode: A, seq: 1, outcome: 'ok', source: 'occ', httpStatus: 200, requests: 1, attempts: 1, observationsWritten: 2, finishedAt: at(4) });
  assert.equal(runs.lastSuccessfulItemAt(A), at(4));
  runs.finish(r3.runId, DONE, at(5));

  const r4 = runs.tryStart('monitor', 'scheduled', at(6));
  assert.ok('runId' in r4);
  runs.addItem(r4.runId, { productCode: A, seq: 1, outcome: 'pulado', skipReason: 'orcamento_diario', finishedAt: at(7) });
  assert.equal(runs.lastSuccessfulItemAt(A), at(4));
  const item = db.prepare("SELECT * FROM run_items WHERE outcome = 'falha'").get() as { failure_class: string; requests: number };
  assert.equal(item.failure_class, 'http_5xx');
  assert.equal(item.requests, 3);
});

test('T-REL-04 dueForCollection exige alerta ATIVO, state ativo e 2 h desde a ultima leitura boa (RF-06-AC7)', () => {
  const { products, seed, alert } = setup();
  const H2 = 2 * 3_600_000;
  seed(A);
  seed(B);
  assert.deepEqual(products.dueForCollection(T0, H2), []); // sem alerta
  alert(A, 'PAUSADO');
  assert.deepEqual(products.dueForCollection(T0, H2), []); // so pausado
  alert(B, 'ATIVO');
  assert.deepEqual(products.dueForCollection(T0, H2), [B]); // nunca lido
  products.recordSuccess(B, { degraded: false, now: T0 });
  assert.deepEqual(products.dueForCollection(at(119), H2), []);
  assert.deepEqual(products.dueForCollection(at(120), H2), [B]); // limite exato
  products.setState(B, 'removido', at(121));
  assert.deepEqual(products.dueForCollection(at(300), H2), []);
  products.setState(B, 'formato_desconhecido', at(121));
  assert.deepEqual(products.dueForCollection(at(300), H2), []);
});

test('T-REL-04 dueForCollection ordena nunca-lido primeiro e depois o mais antigo', () => {
  const { products, seed, alert } = setup();
  seed(A);
  seed(B);
  alert(A);
  alert(B);
  products.recordSuccess(A, { degraded: false, now: T0 });
  assert.deepEqual(products.dueForCollection(at(500), 1), [B, A]);
});

test('T-REL-04 RequestLog: janela de 24 h desliza e qualquer origem conta (RNF-REL-04)', () => {
  const { log } = setup();
  log.record('monitor', at(0));
  log.record('discover', at(60));
  log.record('probe', at(24 * 60));
  log.record('catalog', at(24 * 60 + 1));
  const now = at(24 * 60 + 1);
  const since = new Date(Date.parse(now) - 24 * 3_600_000).toISOString();
  assert.equal(log.countSince(since), 3); // a de t0 saiu da janela
  assert.equal(log.countSince(at(24 * 60 + 2)), 0);
});

test('T-REL-04 recordFailure conta falhas e streak de removido; 2 seguidas => removido (RN-19)', () => {
  const { products, seed } = setup();
  seed(A);
  assert.deepEqual(products.recordFailure(A, { class: 'produto_removido', now: at(1) }), {
    consecutiveFailures: 1,
    notFoundStreak: 1,
    state: 'ativo',
  });
  // outra classe zera o streak de 404 mas segue contando falhas
  assert.deepEqual(products.recordFailure(A, { class: 'http_5xx', now: at(2) }), {
    consecutiveFailures: 2,
    notFoundStreak: 0,
    state: 'ativo',
  });
  products.recordFailure(A, { class: 'produto_removido', now: at(3) });
  const r = products.recordFailure(A, { class: 'produto_removido', now: at(4) });
  assert.deepEqual(r, { consecutiveFailures: 4, notFoundStreak: 2, state: 'removido' });
  assert.equal(products.get(A)?.lastAttemptAt, at(4));
  assert.equal(products.get(A)?.lastOkAt, null);
});

test('T-REL-04 recordSuccess zera contadores e controla degraded_since', () => {
  const { products, seed } = setup();
  seed(A);
  products.recordFailure(A, { class: 'http_5xx', now: at(1) });
  products.recordSuccess(A, { degraded: true, now: at(2) });
  products.recordSuccess(A, { degraded: true, now: at(3) });
  let p = products.get(A);
  assert.equal(p?.consecutiveFailures, 0);
  assert.equal(p?.degradedSince, at(2)); // preserva o inicio do episodio
  assert.equal(p?.lastOkAt, at(3));
  products.recordSuccess(A, { degraded: false, now: at(4) });
  p = products.get(A);
  assert.equal(p?.degradedSince, null);
});

test('T-FLH-11 failure_sample: 1 por produto, sobrescrito, apagado sob demanda', () => {
  const { db, products, runs, seed } = setup();
  seed(A);
  const r = runs.tryStart('monitor', 'scheduled', T0);
  assert.ok('runId' in r);
  const count = () => (db.prepare('SELECT COUNT(*) AS n FROM failure_samples').get() as { n: number }).n;
  products.saveFailureSample(A, { runId: r.runId, capturedAt: at(1), httpStatus: 200, contentType: 'text/html', body: '<html>a</html>' });
  products.saveFailureSample(A, { runId: r.runId, capturedAt: at(2), body: 'b'.repeat(300_000) });
  assert.equal(count(), 1);
  const row = db.prepare('SELECT * FROM failure_samples').get() as { captured_at: string; body: string; http_status: number | null };
  assert.equal(row.captured_at, at(2));
  assert.equal(row.body.length, 262_144);
  assert.equal(row.http_status, null);
  products.clearFailureSample(A);
  assert.equal(count(), 0);
});

test('upsertProduct preserva estado e slug; upsertVariants atualiza last_seen_at', () => {
  const { products, seed } = setup();
  seed(A);
  products.setState(A, 'removido', at(1));
  products.upsertProduct({ code: A, name: 'Novo nome', legacySku: 'X1', slug: null }, at(2));
  const p = products.get(A);
  assert.equal(p?.state, 'removido');
  assert.equal(p?.name, 'Novo nome');
  assert.equal(p?.lastSlug, 'old-skool');
  assert.equal(p?.createdAt, T0);
  products.upsertVariants(A, [{ variantCode: `${A}-34`, size: '34', ean: '123' }], at(3));
  const [v] = products.listVariants(A);
  assert.equal(v?.ean, '123');
  assert.equal(v?.lastSeenAt, at(3));
});
