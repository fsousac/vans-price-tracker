import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CircuitStore } from '../../src/app/circuit-store.ts';
import { MonitorService } from '../../src/app/monitor.ts';
import { BudgetExceededError } from '../../src/app/rate-gate.ts';
import { LEASE_MS, Round, SLICE_MS } from '../../src/app/round.ts';
import { createTick } from '../../src/app/tick.ts';
import { createLogger } from '../../src/observability/logger.ts';
import type { Failure, PriceSource, ProductSnapshot, SourceResult } from '../../src/price-monitor/ports.ts';
import { defaultSettings } from '../../src/settings/settings.ts';
import type { FailureClass } from '../../src/shared/types.ts';
import { createAlertStore } from '../../src/store/alerts.store.ts';
import { prefixRange } from '../../src/store/db.ts';
import { createHealthEventStore } from '../../src/store/events.store.ts';
import { createObservationRepo } from '../../src/store/history.store.ts';
import { createMemoryDb } from '../../src/store/memory.ts';
import { createProductRepo, createRequestLog, createRunRepo } from '../../src/store/monitor.store.ts';
import { IdbNotificationRepo } from '../../src/store/notifications.store.ts';
import { createKvStore } from '../../src/store/state.store.ts';
import type { ProductRow } from '../../src/store/ports.ts';
import { ManualClock } from '../helpers/clock.ts';
import { SeededRandom } from '../helpers/prng.ts';

const T0 = '2026-10-14T12:00:00.000Z';
const HOUR = 3_600_000;

// sleep() avança o relógio na hora: esperas curtas e custo de cada requisição são determinísticos.
class AutoClock extends ManualClock {
  override sleep(ms: number): Promise<void> {
    return this.advance(ms);
  }
}

const codeOf = (i: number) => `10038005${String(i).padStart(4, '0')}U`;

async function setup(n = 3, o: { costMs?: number; throwOn?: string; budgetOn?: string } = {}) {
  const db = createMemoryDb();
  const clock = new AutoClock(T0);
  const iso = () => clock.now().toISOString();
  const baseProducts = createProductRepo(db);
  const products = {
    ...baseProducts,
    async resetFailures(code: string, now: string) {
      const p = (await db.get<ProductRow>('products', code))!;
      await db.put('products', { ...p, consecutiveFailures: 0, notFoundStreak: 0, updatedAt: now });
    },
  };
  const runs = createRunRepo(db);
  const alerts = createAlertStore(db);
  const health = createHealthEventStore(db);
  const kv = createKvStore(db);
  const requestLog = createRequestLog(db);
  const notifRepo = new IdbNotificationRepo(db);
  const lines: string[] = [];
  const log = createLogger('round', clock, (l) => lines.push(l));
  const codes = Array.from({ length: n }, (_, i) => codeOf(i));
  for (const c of codes) {
    await products.upsertProduct({ code: c, name: 'Old Skool', legacySku: null, slug: 'old-skool' }, T0);
    await products.upsertVariants(c, [{ variantCode: `${c}-34`, size: '34', ean: null }], T0);
    await alerts.create({ variantCode: `${c}-34`, targetCents: 30000, marginBp: 300 }, T0);
  }

  const queues = new Map<string, SourceResult[]>();
  const calls: string[] = [];
  const snap = (code: string): SourceResult => {
    const s: ProductSnapshot = {
      code, name: 'Old Skool', slug: 'old-skool', legacySku: null, source: 'occ', degraded: false,
      fetchedAt: iso(), skippedVariants: 0,
      variants: [{ variantCode: `${code}-34`, size: '34', ean: null, originalCents: 40000, currentCents: 35000, available: true }],
    };
    return { ok: true, snapshot: s, httpStatus: 200, requests: 1 };
  };
  const fail = (cls: FailureClass, extra: Partial<Failure> = {}): SourceResult => ({ ok: false, failure: { class: cls, ...extra }, requests: 1 });
  const source: PriceSource = {
    name: 'fake',
    async fetchProduct(code) {
      if (code === o.budgetOn) throw new BudgetExceededError();
      calls.push(code);
      await requestLog.record('monitor', iso()); // o RateGate real registra antes da requisição
      await clock.advance(o.costMs ?? 0);
      const q = queues.get(code);
      return q && q.length > 0 ? (q.length > 1 ? q.shift()! : q[0]!) : snap(code);
    },
  };
  const tx = <T>(fn: () => Promise<T>) => db.tx(fn);
  const monitor = new MonitorService({
    source, products, observations: createObservationRepo(db), alerts,
    alertService: { apply: async () => ({ notificationKey: null }) },
    notifications: notifRepo, emailEnabled: async () => false, mode: 'teste', runs, health,
    circuit: { status: async () => ({ state: 'closed' }) }, clock, log, tx, confirmReread: false,
  });
  const scheduled: (string | null)[] = [];
  let drained = 0;
  const circuit = new CircuitStore(kv);
  const round = new Round({
    source,
    monitor: o.throwOn
      ? { processResult: async (r, c, res, op) => { if (c === o.throwOn) throw new Error('boom'); return monitor.processResult(r, c, res, op); } }
      : monitor,
    products, alerts, runs,
    runItems: async (id) => db.getAll('run_items', { range: prefixRange(id) }),
    requestLog, circuit, kv, health, notifications: notifRepo, emailEnabled: async () => false, mode: 'teste',
    drain: async () => { drained++; },
    schedule: async (_n, when) => { scheduled.push(when); },
    clock, random: new SeededRandom(7), log, tx,
  });
  const items = async () => db.getAll<{ productCode: string; outcome: string; skipReason: string | null; attempts: number }>('run_items');
  return {
    db, clock, round, runs, kv, circuit, requestLog, queues, calls, snap, fail, scheduled, lines, codes, items, notifRepo, alerts,
    drained: () => drained, iso,
  };
}

test('rodada completa: itens, resumo ok, drain ao final e alarme resume removido (RF-06-AC1, RF-06-AC6)', async () => {
  const s = await setup(3);
  const r = await s.round.resumeOrStart('manual');
  assert.ok('summary' in r);
  assert.equal(r.summary.status, 'ok');
  assert.equal(r.summary.itemsTotal, 3);
  assert.equal(r.summary.itemsOk, 3);
  assert.equal(r.summary.requestsMade, 3);
  assert.deepEqual(s.calls, s.codes);
  assert.equal(s.drained(), 1);
  assert.equal(s.scheduled.at(-1), null);
  assert.equal((await s.runs.lastFinished('monitor'))?.status, 'ok');
  assert.equal(await s.runs.getRunning('monitor'), null);
});

test('lease viva: nova tentativa e pulada e registrada anterior_em_andamento (RF-06-AC4)', async () => {
  const s = await setup(2);
  await s.runs.claim({ kind: 'monitor', trigger: 'scheduled', queue: s.codes, now: s.iso(), leaseMs: LEASE_MS, maxResumeAgeMs: 2 * HOUR });
  await s.clock.advance(LEASE_MS - 1);
  assert.deepEqual(await s.round.resumeOrStart('scheduled'), { skipped: 'anterior_em_andamento' });
  assert.equal(s.calls.length, 0);
  assert.equal(await s.db.count('runs'), 2); // a rodada viva + a linha do pulo
});

test('lease vencida: retoma a MESMA rodada sem refazer o que ja foi lido (RNF-REL-01)', async () => {
  const s = await setup(3);
  const c = await s.runs.claim({ kind: 'monitor', trigger: 'scheduled', queue: s.codes, now: s.iso(), leaseMs: LEASE_MS, maxResumeAgeMs: 2 * HOUR });
  assert.equal(c.action, 'started');
  const runId = (c as { run: { id: number } }).run.id;
  // o SW "morreu" depois de gravar o 1o produto
  const first = s.codes[0]!;
  await s.runs.addItem(runId, { productCode: first, seq: 1, outcome: 'ok', source: 'occ', requests: 1, attempts: 1, observationsWritten: 0, finishedAt: s.iso() });
  await s.clock.advance(LEASE_MS);
  const r = await s.round.resumeOrStart('recovery');
  assert.ok('summary' in r);
  assert.equal(r.runId, runId);
  assert.deepEqual(s.calls, s.codes.slice(1));
  assert.equal(r.summary.itemsTotal, 3);
  assert.equal(r.summary.itemsOk, 3);
  assert.equal(r.summary.requestsMade, 3); // contadores vem de run_items, sobrevivem a retomada
});

test('rodada com mais de 2 h: fecha interrupted e inicia nova (RNF-REL-01)', async () => {
  const s = await setup(2);
  const c = await s.runs.claim({ kind: 'monitor', trigger: 'scheduled', queue: s.codes, now: s.iso(), leaseMs: LEASE_MS, maxResumeAgeMs: 2 * HOUR });
  const oldId = (c as { run: { id: number } }).run.id;
  await s.clock.advance(2 * HOUR + 1);
  const r = await s.round.resumeOrStart('recovery');
  assert.ok('summary' in r);
  assert.notEqual(r.runId, oldId);
  assert.equal((await s.db.get<{ status: string }>('runs', oldId))?.status, 'interrupted');
  assert.equal(s.calls.length, 2);
});

test('fatia de 150 s: pausa com resumeAt+alarme, lease solta, e o tick retoma e conclui (RF-06-AC5)', async () => {
  const s = await setup(40, { costMs: 5_000 });
  const r1 = await s.round.resumeOrStart('scheduled');
  assert.ok('paused' in r1);
  assert.equal(s.calls.length, SLICE_MS / 5_000); // 30 produtos na 1a fatia
  assert.equal(r1.resumeAt, new Date(s.clock.now().getTime() + 30_000).toISOString());
  assert.equal(s.scheduled.at(-1), r1.resumeAt);
  const running = await s.runs.getRunning('monitor');
  assert.equal(running?.resumeAt, r1.resumeAt);
  assert.equal(s.drained(), 0);

  await s.clock.advance(30_000); // alarme `resume`: a lease solta deixa retomar em 30 s (< LEASE_MS)
  const tick = createTick({
    round: s.round, runs: s.runs, settings: { get: async () => defaultSettings() }, kv: s.kv,
    notifications: { drain: async () => undefined }, clock: s.clock,
  });
  const t = await tick();
  assert.ok(t.round && 'summary' in t.round);
  assert.equal(t.round.summary.status, 'ok');
  assert.equal(t.round.summary.itemsOk, 40);
  assert.equal(new Set(s.calls).size, 40);
  assert.equal(s.calls.length, 40); // nada refeito
  assert.equal(s.drained(), 1);
});

test('resumeOnly (alarme resume) nunca inicia rodada nova e nao enche runs de pulos automaticos', async () => {
  const s = await setup(2);
  assert.deepEqual(await s.round.resumeOrStart('recovery', { resumeOnly: true }), { skipped: 'intervalo_minimo' });
  assert.equal(s.calls.length, 0);
  assert.equal(await s.db.count('runs'), 0);
});

test('espera longa (429 com Retry-After 60 s): nao dorme, grava resumeAt e retoma a mesma tentativa (RN-18)', async () => {
  const s = await setup(2);
  const [a, b] = s.codes as [string, string];
  s.queues.set(a, [s.fail('http_429', { retryAfterMs: 60_000 }), s.snap(a)]);
  const t0 = s.clock.now().getTime();
  const r = await s.round.resumeOrStart('manual');
  assert.ok('paused' in r);
  assert.equal(s.clock.now().getTime(), t0); // nenhum sleep
  assert.equal(r.resumeAt, new Date(t0 + 60_000).toISOString());
  assert.equal((await s.items()).length, 0); // falha transitoria nao virou item nem preco
  assert.equal(await s.db.count('observations'), 0);

  await s.clock.advance(60_000);
  const r2 = await s.round.resumeOrStart('recovery', { resumeOnly: true });
  assert.ok('summary' in r2);
  assert.equal(r2.summary.status, 'ok');
  assert.deepEqual(s.calls, [a, a, b]);
  const it = await s.items();
  assert.equal(it.find((x) => x.productCode === a)?.attempts, 2);
  assert.equal(await s.kv.get('round_retry' as never), null);
});

test('429 antes e depois da pausa = 429 repetido: abre o circuito 24 h e pula o resto (RN-18)', async () => {
  const s = await setup(3);
  const [a] = s.codes as [string];
  s.queues.set(a, [s.fail('http_429', { retryAfterMs: 60_000 })]); // sempre 429
  await s.round.resumeOrStart('manual');
  await s.clock.advance(60_000);
  const r = await s.round.resumeOrStart('recovery', { resumeOnly: true });
  assert.ok('summary' in r);
  assert.equal(r.summary.circuitOpened, true);
  assert.equal(r.summary.status, 'failed');
  assert.deepEqual((await s.items()).map((x) => [x.outcome, x.skipReason]), [['falha', null], ['pulado', 'circuito_aberto'], ['pulado', 'circuito_aberto']]);
  assert.equal((await s.circuit.status(s.iso())).state, 'open');
  assert.equal(s.calls.length, 2); // 3o e 4o produtos nunca foram requisitados
});

test('espera curta (5xx): dorme com backoff e retenta na mesma ativacao (RN-18)', async () => {
  const s = await setup(1);
  const [a] = s.codes as [string];
  s.queues.set(a, [s.fail('http_5xx'), s.snap(a)]);
  const r = await s.round.resumeOrStart('manual');
  assert.ok('summary' in r);
  assert.equal(r.summary.status, 'ok');
  assert.equal((await s.items())[0]?.attempts, 2);
  assert.equal(s.calls.length, 2);
  assert.ok(s.clock.now().getTime() - Date.parse(T0) >= 3_750); // 5 s -25% de jitter
});

test('403 abre o circuito, pula o resto, cria 1 aviso SAUDE e a rodada seguinte e pulada (T-FLH-08, RNF-LEG-02)', async () => {
  const s = await setup(3);
  s.queues.set(s.codes[0]!, [s.fail('http_403_ou_desafio')]);
  const r = await s.round.resumeOrStart('scheduled');
  assert.ok('summary' in r);
  assert.equal(r.summary.circuitOpened, true);
  assert.equal(r.summary.status, 'failed');
  assert.equal(s.calls.length, 1);
  assert.equal((await s.notifRepo.get('saude|1'))?.kind, 'SAUDE');
  assert.equal(await s.db.count('notifications'), 1);
  assert.equal(s.drained(), 1);
  assert.deepEqual(await s.round.resumeOrStart('scheduled'), { skipped: 'circuito_aberto' });
  assert.equal(s.calls.length, 1);
});

test('circuito meio-aberto: 1o produto e a sonda; sucesso fecha o episodio (T-FLH-08)', async () => {
  const s = await setup(2);
  await s.circuit.open('http_403_ou_desafio', s.iso());
  await s.clock.advance(24 * HOUR + 1);
  assert.equal((await s.circuit.status(s.iso())).state, 'half_open');
  const r = await s.round.resumeOrStart('scheduled');
  assert.ok('summary' in r);
  assert.equal(r.summary.status, 'ok');
  assert.equal((await s.circuit.status(s.iso())).state, 'closed');
});

test('sonda com falha de transporte reabre o circuito sem novo aviso e pula o resto (T-FLH-08)', async () => {
  const s = await setup(2);
  await s.circuit.open('http_403_ou_desafio', s.iso());
  await s.clock.advance(24 * HOUR + 1);
  s.queues.set(s.codes[0]!, [s.fail('http_5xx')]); // 5xx: 2 retentativas esgotam e a sonda falha
  const r = await s.round.resumeOrStart('scheduled');
  assert.ok('summary' in r);
  assert.equal(r.summary.circuitOpened, true);
  assert.equal((await s.circuit.status(s.iso())).state, 'open');
  assert.equal(await s.db.count('notifications'), 0);
  assert.equal(s.calls.length, 3);
});

test('3 produtos seguidos com conteudo ruim encerram parcial sem circuito (T-FLH-13)', async () => {
  const s = await setup(5);
  for (const c of s.codes.slice(0, 3)) s.queues.set(c, [s.fail('formato_desconhecido')]);
  const r = await s.round.resumeOrStart('manual');
  assert.ok('summary' in r);
  assert.equal(r.summary.status, 'failed');
  assert.equal(r.summary.circuitOpened, false);
  assert.equal(s.calls.length, 3);
  assert.equal(await s.db.count('observations'), 0); // falha de extracao nunca vira preco (RF-11-AC1)
});

test('orcamento diario esgotado: itens pulados orcamento_diario e nenhuma requisicao (RNF-REL-04)', async () => {
  const s = await setup(2);
  for (let i = 0; i < 400; i++) await s.requestLog.record('monitor', s.iso());
  const r = await s.round.resumeOrStart('manual');
  assert.ok('summary' in r);
  assert.equal(r.summary.status, 'partial');
  assert.deepEqual((await s.items()).map((x) => x.skipReason), ['orcamento_diario', 'orcamento_diario']);
  assert.equal(s.calls.length, 0);
});

test('BudgetExceededError da fonte (RateGate) no 2o produto: pula o resto (RNF-REL-04)', async () => {
  const s = await setup(3, { budgetOn: codeOf(1) });
  const r = await s.round.resumeOrStart('manual');
  assert.ok('summary' in r);
  assert.equal(r.summary.status, 'partial');
  assert.deepEqual((await s.items()).map((x) => x.skipReason), [null, 'orcamento_diario', 'orcamento_diario']);
});

test('sem alerta ativo: manual registra o pulo, automatico so loga (RF-06-AC7)', async () => {
  const s = await setup(0);
  assert.deepEqual(await s.round.resumeOrStart('scheduled'), { skipped: 'sem_alertas_ativos' });
  assert.equal(await s.db.count('runs'), 0);
  assert.deepEqual(await s.round.resumeOrStart('manual'), { skipped: 'sem_alertas_ativos' });
  assert.equal(await s.db.count('runs'), 1);
});

test('produtos lidos ha menos de 2 h nao entram: intervalo_minimo (RF-06 min. 2 h por produto)', async () => {
  const s = await setup(2);
  await s.round.resumeOrStart('manual');
  await s.clock.advance(HOUR);
  assert.deepEqual(await s.round.resumeOrStart('manual'), { skipped: 'intervalo_minimo' });
  await s.clock.advance(HOUR + 1);
  const r = await s.round.resumeOrStart('manual');
  assert.ok('summary' in r);
});

test('excecao inesperada deixa a rodada running e retomavel, sem alerta falso (RNF-REL-02)', async () => {
  const s = await setup(3, { throwOn: codeOf(1) });
  await assert.rejects(s.round.resumeOrStart('manual'), /boom/);
  const run = await s.runs.getRunning('monitor');
  assert.ok(run);
  assert.deepEqual((await s.items()).map((x) => x.productCode), [codeOf(0)]);
  await s.clock.advance(LEASE_MS);
  await assert.rejects(s.round.resumeOrStart('recovery'), /boom/); // retoma o produto pendente
  assert.deepEqual(s.calls, [codeOf(0), codeOf(1), codeOf(1)]);
});

test('abort: encerra parcial sem requisitar o restante', async () => {
  const s = await setup(3);
  const ac = new AbortController();
  ac.abort();
  const r = await s.round.resumeOrStart('manual', { signal: ac.signal });
  assert.ok('summary' in r);
  assert.equal(r.summary.status, 'partial');
  assert.equal(s.calls.length, 0);
});

test('logs sem PII: so campos permitidos', async () => {
  const s = await setup(2);
  await s.round.resumeOrStart('manual');
  for (const l of s.lines) assert.ok(!/@|apiKey|Bearer/.test(l), l);
});
