import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMemoryDb } from '../../src/store/memory.ts';
import { createProductRepo, createRequestLog, createRunRepo } from '../../src/store/monitor.store.ts';
import { StoreConstraintError } from '../../src/store/ports.ts';

const T0 = '2026-10-14T12:00:00.000Z';
const at = (min: number) => new Date(Date.parse(T0) + min * 60_000).toISOString();
const A = '1003800580026U';
const B = '1003800580099U';
const DONE = { status: 'ok', itemsTotal: 1, itemsOk: 1, itemsFailed: 0, requestsMade: 1, circuitOpened: false } as const;
const LEASE = 90_000;
const MAXAGE = 2 * 3_600_000;
const claim = (runs: ReturnType<typeof createRunRepo>, now: string, queue: string[] = [A, B], kind: 'monitor' | 'catalog' = 'monitor') =>
  runs.claim({ kind, trigger: 'scheduled', queue, now, leaseMs: LEASE, maxResumeAgeMs: MAXAGE });

function setup() {
  const db = createMemoryDb();
  const products = createProductRepo(db);
  const runs = createRunRepo(db);
  const log = createRequestLog(db);
  const seed = async (code: string, size = '34') => {
    await products.upsertProduct({ code, name: 'Old Skool', legacySku: null, slug: 'old-skool' }, T0);
    await products.upsertVariants(code, [{ variantCode: `${code}-${size}`, size, ean: null }], T0);
  };
  const alert = (code: string, status = 'ATIVO', size = '34') => db.add('alerts', { variantCode: `${code}-${size}`, status });
  return { db, products, runs, log, seed, alert };
}

test('T-REL-03 claim: cria com fila congelada; lease viva => busy (RNF-REL-03)', async () => {
  const { runs } = setup();
  const r = await claim(runs, T0);
  assert.equal(r.action, 'started');
  assert.ok(r.action === 'started');
  assert.deepEqual(r.run.queue, [A, B]);
  assert.equal(r.run.heartbeatAt, T0);
  assert.equal((await claim(runs, at(1), [B], 'catalog')).action, 'busy'); // 60 s < lease
  assert.deepEqual((await runs.getRunning('monitor'))?.queue, [A, B]); // fila não mudou
});

test('T-REL-03 retomada: lease vencida retoma a mesma rodada, fila e itens preservados', async () => {
  const { runs } = setup();
  const r = await claim(runs, T0);
  assert.ok(r.action === 'started');
  await runs.addItem(r.run.id, { productCode: A, seq: 1, outcome: 'ok', source: 'occ', requests: 1, attempts: 1, observationsWritten: 1, finishedAt: at(1) });
  await runs.setResumeAt(r.run.id, at(5));
  const again = await claim(runs, at(10), []);
  assert.ok(again.action === 'resumed');
  assert.equal(again.run.id, r.run.id);
  assert.deepEqual(again.run.queue, [A, B]); // ignora a fila nova
  assert.equal(again.run.resumeAt, null);
  assert.equal(again.run.heartbeatAt, at(10));
  assert.deepEqual(await runs.doneCodes(r.run.id), [A]); // cursor
});

test('T-REL-03 heartbeat renova a lease; no limite exato (90 s) ela vence', async () => {
  const { runs } = setup();
  const r = await claim(runs, T0);
  assert.ok(r.action === 'started');
  await runs.heartbeat(r.run.id, at(2));
  assert.equal((await claim(runs, at(3))).action, 'busy'); // 60 s desde o batimento
  const edge = new Date(Date.parse(at(2)) + LEASE).toISOString();
  assert.equal((await claim(runs, edge)).action, 'resumed');
});

test('T-REL-03 rodada mais velha que maxResumeAge vira interrupted e nasce outra (RNF-REL-01)', async () => {
  const { runs } = setup();
  const r = await claim(runs, T0);
  assert.ok(r.action === 'started');
  const n = await claim(runs, at(121), [B]);
  assert.ok(n.action === 'started');
  assert.notEqual(n.run.id, r.run.id);
  assert.deepEqual(n.run.queue, [B]);
  assert.equal((await runs.lastFinished('monitor'))?.status, 'interrupted');
  assert.equal((await runs.lastFinished('monitor'))?.finishedAt, at(121));
  // exatamente 2 h ainda retoma
  const m = await claim(runs, at(121 + 120));
  assert.equal(m.action, 'resumed');
});

test('T-REL-03 rodada de outro kind com lease vencida é interrompida, não retomada', async () => {
  const { runs } = setup();
  await claim(runs, T0, [], 'catalog');
  const n = await claim(runs, at(10), [A], 'monitor');
  assert.equal(n.action, 'started');
  assert.equal((await runs.lastFinished('catalog'))?.status, 'interrupted');
});

test('T-REL-03 claims concorrentes: só um cria, o outro vê busy', async () => {
  const { runs, db } = setup();
  const rs = await Promise.all([claim(runs, T0), claim(runs, T0), claim(runs, T0)]);
  assert.deepEqual(rs.map((r) => r.action).sort(), ['busy', 'busy', 'started']);
  assert.equal(await db.count('runs'), 1);
});

test('T-REL-03 markInterrupted fecha running, grava finishedAt e libera nova rodada', async () => {
  const { runs } = setup();
  await claim(runs, T0);
  assert.equal(await runs.markInterrupted(at(5)), 1);
  assert.equal(await runs.markInterrupted(at(6)), 0);
  const last = await runs.lastFinished('monitor');
  assert.equal(last?.status, 'interrupted');
  assert.equal(last?.finishedAt, at(5));
  assert.equal((await claim(runs, at(7))).action, 'started');
});

test('T-REL-03 finish fecha uma vez; heartbeat/setResumeAt não reabrem rodada fechada', async () => {
  const { runs } = setup();
  const r = await claim(runs, T0);
  assert.ok(r.action === 'started');
  await runs.finish(r.run.id, DONE, at(2));
  await runs.finish(r.run.id, { ...DONE, status: 'failed' }, at(3)); // ignorado
  await runs.heartbeat(r.run.id, at(4));
  await runs.setResumeAt(r.run.id, at(9));
  const last = await runs.lastFinished('monitor');
  assert.equal(last?.status, 'ok');
  assert.equal(last?.finishedAt, at(2));
  assert.equal(last?.heartbeatAt, T0);
  assert.equal(last?.resumeAt, null);
  assert.equal(await runs.getRunning('monitor'), null);
  await assert.rejects(runs.heartbeat(999, at(5)), StoreConstraintError);
});

test('T-REL-03 recordSkipped não ocupa a vaga; lastFinished ignora running e skipped', async () => {
  const { runs } = setup();
  const a = await claim(runs, T0);
  assert.ok(a.action === 'started');
  await runs.finish(a.run.id, { ...DONE, status: 'partial', circuitOpened: true }, at(1));
  await claim(runs, at(10)); // running
  await runs.recordSkipped('monitor', 'manual', 'circuito_aberto', at(11));
  const last = await runs.lastFinished('monitor');
  assert.equal(last?.id, a.run.id);
  assert.equal(last?.circuitOpened, true);
  assert.equal(await runs.lastFinished('catalog'), null);
  assert.equal((await claim(runs, at(11))).action, 'busy'); // a skipped não interfere
});

test('T-REL-03 addItem idempotente por (runId, produto); falha/pulado não contam como sucesso', async () => {
  const { db, runs, seed } = setup();
  await seed(A);
  const r = await claim(runs, T0);
  assert.ok(r.action === 'started');
  const id = r.run.id;
  const fail = { productCode: A, seq: 1, outcome: 'falha', failureClass: 'http_5xx', httpStatus: 503, requests: 3, attempts: 3, finishedAt: at(1) } as const;
  assert.equal(await runs.addItem(id, fail), true);
  assert.equal(await runs.addItem(id, { ...fail, seq: 2 }), false); // retomada repete o mesmo produto
  assert.equal(await db.count('run_items'), 1);
  assert.equal(await runs.lastSuccessfulItemAt(A), null);
  await runs.finish(id, { ...DONE, status: 'failed', itemsOk: 0, itemsFailed: 1 }, at(2));

  const r3 = await claim(runs, at(3));
  assert.ok(r3.action === 'started');
  await runs.addItem(r3.run.id, { productCode: A, seq: 1, outcome: 'ok', source: 'occ', httpStatus: 200, requests: 1, attempts: 1, observationsWritten: 2, finishedAt: at(4) });
  assert.equal(await runs.lastSuccessfulItemAt(A), at(4));
  await runs.finish(r3.run.id, DONE, at(5));

  const r4 = await claim(runs, at(6));
  assert.ok(r4.action === 'started');
  await runs.addItem(r4.run.id, { productCode: A, seq: 1, outcome: 'pulado', skipReason: 'orcamento_diario', finishedAt: at(7) });
  assert.equal(await runs.lastSuccessfulItemAt(A), at(4));
  const item = (await db.getAll<{ outcome: string; failureClass: string; requests: number; runId: number }>('run_items')).find((x) => x.outcome === 'falha');
  assert.equal(item?.failureClass, 'http_5xx');
  assert.equal(item?.requests, 3);
});

test('T-REL-03 doneCodes isola por rodada; seq repetido com outro produto => StoreConstraintError', async () => {
  const { runs } = setup();
  const a = await claim(runs, T0);
  assert.ok(a.action === 'started');
  const ok = (code: string, seq: number) =>
    ({ productCode: code, seq, outcome: 'ok', source: 'occ', requests: 1, attempts: 1, observationsWritten: 1, finishedAt: at(1) }) as const;
  await runs.addItem(a.run.id, ok(A, 1));
  await assert.rejects(runs.addItem(a.run.id, ok(B, 1)), StoreConstraintError);
  await runs.finish(a.run.id, DONE, at(2));
  const b = await claim(runs, at(3));
  assert.ok(b.action === 'started');
  await runs.addItem(b.run.id, ok(B, 1));
  assert.deepEqual(await runs.doneCodes(a.run.id), [A]);
  assert.deepEqual(await runs.doneCodes(b.run.id), [B]);
});

test('T-REL-04 dueForCollection exige alerta ATIVO, state ativo e 2 h desde a última leitura boa (RF-06-AC7)', async () => {
  const { products, seed, alert } = setup();
  const H2 = 2 * 3_600_000;
  await seed(A);
  await seed(B);
  assert.deepEqual(await products.dueForCollection(T0, H2), []); // sem alerta
  await alert(A, 'PAUSADO');
  assert.deepEqual(await products.dueForCollection(T0, H2), []);
  await alert(B, 'ATIVO');
  assert.deepEqual(await products.dueForCollection(T0, H2), [B]); // nunca lido
  await products.recordSuccess(B, { degraded: false, now: T0 });
  assert.deepEqual(await products.dueForCollection(at(119), H2), []);
  assert.deepEqual(await products.dueForCollection(at(120), H2), [B]); // limite exato
  await products.setState(B, 'removido', at(121));
  assert.deepEqual(await products.dueForCollection(at(300), H2), []);
  await products.setState(B, 'formato_desconhecido', at(121));
  assert.deepEqual(await products.dueForCollection(at(300), H2), []);
});

test('T-REL-04 dueForCollection: nunca-lido primeiro, depois o mais antigo', async () => {
  const { products, seed, alert } = setup();
  await seed(A);
  await seed(B);
  await alert(A);
  await alert(B);
  await products.recordSuccess(A, { degraded: false, now: T0 });
  assert.deepEqual(await products.dueForCollection(at(500), 1), [B, A]);
});

test('T-REL-04 RequestLog: janela de 24 h desliza, qualquer origem conta e poda remove só o antigo (RNF-REL-04)', async () => {
  const { log } = setup();
  await log.record('monitor', at(0));
  await log.record('discover', at(60));
  await log.record('probe', at(24 * 60));
  await log.record('catalog', at(24 * 60 + 1));
  const now = at(24 * 60 + 1);
  const since = new Date(Date.parse(now) - 24 * 3_600_000).toISOString();
  assert.equal(await log.countSince(since), 3); // a de t0 saiu da janela
  assert.equal(await log.countSince(at(24 * 60 + 2)), 0);
  assert.equal(await log.prune(at(60)), 1); // estritamente anterior
  assert.equal(await log.countSince(at(0)), 3);
  assert.equal(await log.prune(at(60)), 0);
});

test('T-REL-04 recordFailure conta falhas e streak de removido; 2 seguidas => removido (RN-19)', async () => {
  const { products, seed } = setup();
  await seed(A);
  assert.deepEqual(await products.recordFailure(A, { class: 'produto_removido', now: at(1) }), { consecutiveFailures: 1, notFoundStreak: 1, state: 'ativo' });
  assert.deepEqual(await products.recordFailure(A, { class: 'http_5xx', now: at(2) }), { consecutiveFailures: 2, notFoundStreak: 0, state: 'ativo' });
  await products.recordFailure(A, { class: 'produto_removido', now: at(3) });
  assert.deepEqual(await products.recordFailure(A, { class: 'produto_removido', now: at(4) }), { consecutiveFailures: 4, notFoundStreak: 2, state: 'removido' });
  assert.equal((await products.get(A))?.lastAttemptAt, at(4));
  assert.equal((await products.get(A))?.lastOkAt, null);
  await assert.rejects(products.recordFailure('X', { class: 'http_5xx', now: at(5) }), StoreConstraintError);
});

test('T-REL-04 recordSuccess zera contadores e preserva o início do episódio degradado', async () => {
  const { products, seed } = setup();
  await seed(A);
  await products.recordFailure(A, { class: 'http_5xx', now: at(1) });
  await products.recordSuccess(A, { degraded: true, now: at(2) });
  await products.recordSuccess(A, { degraded: true, now: at(3) });
  const p = await products.get(A);
  assert.equal(p?.consecutiveFailures, 0);
  assert.equal(p?.degradedSince, at(2));
  assert.equal(p?.lastOkAt, at(3));
  await products.recordSuccess(A, { degraded: false, now: at(4) });
  assert.equal((await products.get(A))?.degradedSince, null);
});

test('T-FLH-11 failure_sample: 1 por produto, sobrescrita, truncada em 256 KiB, apagada sob demanda', async () => {
  const { db, products, runs, seed } = setup();
  await seed(A);
  const r = await claim(runs, T0);
  assert.ok(r.action === 'started');
  await products.saveFailureSample(A, { runId: r.run.id, capturedAt: at(1), httpStatus: 200, contentType: 'text/html', body: '<html>a</html>' });
  await products.saveFailureSample(A, { runId: r.run.id, capturedAt: at(2), body: 'b'.repeat(300_000) });
  assert.equal(await db.count('failure_samples'), 1);
  const row = await db.get<{ capturedAt: string; body: string; httpStatus: number | null }>('failure_samples', A);
  assert.equal(row?.capturedAt, at(2));
  assert.equal(row?.body.length, 262_144);
  assert.equal(row?.httpStatus, null);
  await products.clearFailureSample(A);
  assert.equal(await db.count('failure_samples'), 0);
});

test('upsertProduct preserva estado e slug; upsertVariants exige produto e atualiza lastSeenAt', async () => {
  const { products, seed } = setup();
  await seed(A);
  await products.setState(A, 'removido', at(1));
  await products.upsertProduct({ code: A, name: 'Novo nome', legacySku: 'X1', slug: null }, at(2));
  const p = await products.get(A);
  assert.equal(p?.state, 'removido');
  assert.equal(p?.name, 'Novo nome');
  assert.equal(p?.lastSlug, 'old-skool');
  assert.equal(p?.createdAt, T0);
  await products.upsertVariants(A, [{ variantCode: `${A}-34`, size: '34', ean: '123' }], at(3));
  const [v] = await products.listVariants(A);
  assert.equal(v?.ean, '123');
  assert.equal(v?.lastSeenAt, at(3));
  assert.equal((await products.getVariant(`${A}-34`))?.productCode, A);
  assert.equal(await products.getVariant('nope'), null);
  await assert.rejects(products.upsertVariants(B, [{ variantCode: 'z', size: '1', ean: null }], at(4)), StoreConstraintError);
});

test('T-REL-03 sobrevive à morte do SW: reabrir a Db com o mesmo estado retoma a rodada', async () => {
  const { db, runs } = setup();
  const r = await claim(runs, T0);
  assert.ok(r.action === 'started');
  const db2 = createMemoryDb({ state: db.dump() }); // novo "SW", mesmo armazenamento
  const resumed = await claim(createRunRepo(db2), at(10));
  assert.ok(resumed.action === 'resumed');
  assert.equal(resumed.run.id, r.run.id);
});
