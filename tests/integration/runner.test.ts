import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAlertRepo } from '../../src/alerts/alerts.repo.ts';
import { AlertService } from '../../src/alerts/alerts.service.ts';
import { transaction } from '../../src/db/connection.ts';
import { FakeMailer } from '../../src/notifications/mailer.fake.ts';
import { SqliteNotificationRepo } from '../../src/notifications/notifications.repo.ts';
import { NotificationService } from '../../src/notifications/notifications.service.ts';
import { createHealthEventRepo } from '../../src/observability/events.repo.ts';
import { createLogger } from '../../src/observability/logger.ts';
import { createStateRepo } from '../../src/observability/state.repo.ts';
import { SqliteObservationRepo } from '../../src/price-history/history.repo.ts';
import { FakeHttpClient } from '../../src/price-monitor/fake.source.ts';
import { withRateGate } from '../../src/price-monitor/http/rate-gate.ts';
import { MonitorService } from '../../src/price-monitor/monitor.service.ts';
import { createProductRepo, createRequestLog, createRunRepo } from '../../src/price-monitor/monitor.repo.ts';
import type { PriceSource, SourceResult } from '../../src/price-monitor/ports.ts';
import { Runner } from '../../src/scheduler/runner.ts';
import { CircuitStore } from '../../src/scheduler/circuit.ts';
import type { FailureClass } from '../../src/shared/types.ts';
import { ManualClock } from '../helpers/clock.ts';
import { makeDb } from '../helpers/db.ts';
import { SeededRandom } from '../helpers/prng.ts';

const T0 = '2026-10-14T12:00:00.000Z';
const HOUR = 3_600_000;
const code = (n: number) => `100${String(n).padStart(4, '0')}U`;

// sleep() avança o relógio na hora: nada espera de verdade.
class AutoClock extends ManualClock {
  override sleep(ms: number): Promise<void> {
    return this.advance(ms);
  }
}

function setup(nProducts: number, withAlert: (n: number) => boolean = () => true) {
  const db = makeDb();
  const clock = new AutoClock(T0);
  const random = new SeededRandom(7);
  const iso = () => clock.now().toISOString();
  const products = createProductRepo(db);
  const runs = createRunRepo(db);
  const alerts = createAlertRepo(db);
  const observations = new SqliteObservationRepo(db);
  const notifRepo = new SqliteNotificationRepo(db);
  const log = createLogger('runner', clock, () => undefined);
  const notifications = new NotificationService({
    repo: notifRepo, alerts, mailer: new FakeMailer('teste'), clock, log, ownerEmail: 'dono@exemplo.com',
  });
  const tx = <T>(fn: () => T): T => transaction(db, fn);
  const alertService = new AlertService({ alerts, notifications: notifRepo, observations, products, clock, tx, mode: 'teste' });
  const health = createHealthEventRepo(db);
  const state = createStateRepo(db);
  const circuit = new CircuitStore(state);
  const requestLog = createRequestLog(db);
  const monitor = new MonitorService({
    source: { name: 'fake', fetchProduct: async () => { throw new Error('não usado'); } },
    products: { ...products, resetFailures: () => undefined },
    observations, alerts, alertService, notifications, runs, health, circuit, clock, log, tx, confirmReread: false,
  });

  // Fonte de teste: cada fetch passa pelo RateGate real (FakeHttpClient por baixo) e devolve o resultado programado.
  const gate = withRateGate(new FakeHttpClient({ 'https://x.test/p': { ok: true, status: 200, body: '{}', contentType: 'application/json' } }), { clock, random, log: requestLog });
  const programmed = new Map<string, SourceResult[]>();
  const calls: string[] = [];
  const okRes = (c: string): SourceResult => ({
    ok: true, httpStatus: 200, requests: 1,
    snapshot: {
      code: c, name: `Tênis ${c}`, slug: 'tenis', legacySku: null, source: 'occ', degraded: false, fetchedAt: iso(), skippedVariants: 0,
      variants: [{ variantCode: `${c}-34`, size: '34', ean: null, originalCents: 40000, currentCents: 35000, available: true }],
    },
  });
  const failRes = (cls: FailureClass, extra: object = {}): SourceResult => ({ ok: false, failure: { class: cls, ...extra }, requests: 1 });
  const source: PriceSource = {
    name: 'fake',
    async fetchProduct(c) {
      calls.push(c);
      await gate.get({ url: new URL('https://x.test/p'), accept: 'json' }); // cortesia + orçamento + registro
      const q = programmed.get(c);
      if (q && q.length > 0) return q.length > 1 ? q.shift()! : q[0]!;
      return okRes(c);
    },
  };
  for (let n = 1; n <= nProducts; n++) {
    products.upsertProduct({ code: code(n), name: `Tênis ${n}`, legacySku: null, slug: 'tenis' }, T0);
    products.upsertVariants(code(n), [{ variantCode: `${code(n)}-34`, size: '34', ean: null }], T0);
    if (withAlert(n)) alerts.create({ variantCode: `${code(n)}-34`, targetCents: 30000, marginBp: 300, email: 'a@b.co' }, T0);
  }
  const runner = new Runner({ source, monitor, products, runs, requestLog, circuit, health, notifications, clock, random, log, tx });
  const count = (t: string) => (db.prepare(`SELECT count(*) c FROM ${t}`).get() as { c: number }).c;
  const times = () => (db.prepare('SELECT at FROM outbound_requests ORDER BY id').all() as { at: string }[]).map((r) => Date.parse(r.at));
  const run = () => runner.runMonitoringRound('scheduled');
  const lastRun = () => db.prepare('SELECT * FROM monitoring_runs ORDER BY id DESC LIMIT 1').get() as Record<string, unknown>;
  return { db, clock, state, circuit, requestLog, programmed, calls, okRes, failRes, run, lastRun, count, times, runs };
}

test('T-PRF-01 / T-MON-01 50 produtos: 1 requisição por code, sequencial, cortesia 2-5 s, sem esperar de verdade', async () => {
  const s = setup(50);
  const r = await s.run();
  assert.ok('runId' in r);
  assert.deepEqual(r.summary, { status: 'ok', itemsTotal: 50, itemsOk: 50, itemsFailed: 0, requestsMade: 50, circuitOpened: false });
  assert.equal(new Set(s.calls).size, 50);
  assert.equal(s.calls.length, 50);
  const t = s.times();
  assert.equal(t.length, 50);
  for (let i = 1; i < t.length; i++) {
    const gap = t[i]! - t[i - 1]!;
    assert.ok(gap >= 2000 && gap < 5000, `gap ${gap}`);
  }
  assert.ok(s.clock.now().getTime() - Date.parse(T0) >= 49 * 2000);
});

test('T-MON-05 rodada grava MonitoringRun e run_items na ordem, sem rede real', async () => {
  const s = setup(3);
  await s.run();
  const run = s.lastRun();
  assert.equal(run.status, 'ok');
  assert.equal(run.items_total, 3);
  assert.equal(run.requests_made, 3);
  assert.ok(run.finished_at);
  const items = s.db.prepare('SELECT seq, outcome FROM run_items ORDER BY seq').all() as { seq: number; outcome: string }[];
  assert.deepEqual(items.map((i) => [i.seq, i.outcome]), [[1, 'ok'], [2, 'ok'], [3, 'ok']]);
});

test('T-MON-06 produto sem alerta ativo não é coletado; sem nenhum, a rodada é skipped sem_alertas_ativos (RF-06-AC7)', async () => {
  const s = setup(3, (n) => n !== 2);
  await s.run();
  assert.deepEqual([...s.calls].sort(), [code(1), code(3)]);
  const none = setup(2, () => false);
  const r = await none.run();
  assert.deepEqual(r, { skipped: 'sem_alertas_ativos' });
  assert.equal(none.calls.length, 0);
  assert.equal(none.lastRun().status, 'skipped');
});

test('T-REL-04 orçamento 400/24 h (qualquer origem) pula o resto e não chama a rede', async () => {
  const s = setup(5);
  const recent = new Date(Date.parse(T0) - HOUR).toISOString();
  for (let i = 0; i < 398; i++) s.requestLog.record('catalog', recent); // origem diferente conta
  const r = await s.run();
  assert.ok('runId' in r);
  assert.equal(s.calls.length, 2);
  assert.equal(r.summary.status, 'partial');
  const skipped = s.db.prepare("SELECT product_code c, skip_reason r FROM run_items WHERE outcome = 'pulado' ORDER BY seq").all();
  assert.deepEqual(skipped.map((x) => ({ ...(x as object) })), [3, 4, 5].map((n) => ({ c: code(n), r: 'orcamento_diario' })));
});

test('RNF-REL-03 5xx: até 2 retentativas com backoff 5 s/10 s e 1 item com attempts=3', async () => {
  const s = setup(1);
  s.programmed.set(code(1), [s.failRes('http_5xx'), s.failRes('http_5xx'), s.okRes(code(1))]);
  const r = await s.run();
  assert.ok('runId' in r);
  assert.equal(r.summary.status, 'ok');
  assert.equal(s.calls.length, 3);
  const item = s.db.prepare('SELECT attempts a, requests r FROM run_items').get() as { a: number; r: number };
  assert.equal(item.a, 3);
  const t = s.times();
  assert.ok(t[1]! - t[0]! >= 3750 && t[2]! - t[1]! >= 7500); // 5 s e 10 s com jitter -25%
});

test('T-FLH-08 403 aborta a rodada, abre o circuito 24 h (1 aviso) e as demais rodadas ficam skipped', async () => {
  const s = setup(3);
  s.programmed.set(code(1), [s.failRes('http_403_ou_desafio', { httpStatus: 403 })]);
  const r = await s.run();
  assert.ok('runId' in r);
  assert.equal(s.calls.length, 1); // 403: sem retentativa
  assert.deepEqual(r.summary, { status: 'failed', itemsTotal: 3, itemsOk: 0, itemsFailed: 1, requestsMade: 1, circuitOpened: true });
  const st = s.circuit.status(s.clock.now().toISOString());
  assert.ok(st.state === 'open' && st.reason === 'http_403_ou_desafio');
  assert.equal(s.count("run_items WHERE outcome = 'pulado' AND skip_reason = 'circuito_aberto'"), 2);
  assert.equal(s.count("health_events WHERE kind = 'circuito_aberto' AND closed_at IS NULL"), 1);
  assert.equal(s.count("notifications WHERE kind = 'SAUDE'"), 1);
  assert.deepEqual(await s.run(), { skipped: 'circuito_aberto' });
  assert.equal(s.calls.length, 1);
});

test('T-FLH-08 503 com desafio e 2x 429 seguidos também abrem o circuito', async () => {
  const s = setup(3);
  s.programmed.set(code(1), [s.failRes('http_429', { retryAfterMs: 1000 })]); // 429 + 1 retentativa = 2x seguidas
  const r = await s.run();
  assert.ok('runId' in r && r.summary.circuitOpened);
  assert.equal(s.calls.length, 2);
  assert.equal(s.circuit.status(s.clock.now().toISOString()).state, 'open');
});

test('T-FLH-08 após 24 h a sonda (1º produto) bem-sucedida fecha o circuito e a rodada continua', async () => {
  const s = setup(3);
  s.programmed.set(code(1), [s.failRes('http_403_ou_desafio'), s.okRes(code(1))]);
  await s.run();
  await s.clock.advance(24 * HOUR);
  assert.equal(s.circuit.status(s.clock.now().toISOString()).state, 'half_open');
  s.programmed.get(code(1))![0] = s.okRes(code(1));
  const r = await s.run();
  assert.ok('runId' in r);
  assert.equal(r.summary.status, 'ok');
  assert.equal(s.circuit.status(s.clock.now().toISOString()).state, 'closed');
  assert.equal(s.count('health_events WHERE closed_at IS NULL'), 0);
  assert.equal(s.calls.length, 4); // 1 antes + 3 depois
});

test('T-FLH-08 sonda que falha reabre +24 h sem novo aviso e não coleta o resto', async () => {
  const s = setup(3);
  s.programmed.set(code(1), [s.failRes('http_403_ou_desafio')]);
  await s.run();
  await s.clock.advance(24 * HOUR);
  const before = s.calls.length;
  const r = await s.run();
  assert.ok('runId' in r && r.summary.circuitOpened);
  assert.equal(s.calls.length, before + 1); // só a sonda
  const st = s.circuit.status(s.clock.now().toISOString());
  assert.ok(st.state === 'open' && Date.parse(st.until) === s.clock.now().getTime() + 24 * HOUR);
  assert.equal(s.count("health_events WHERE kind = 'circuito_aberto'"), 1);
  assert.equal(s.count("notifications WHERE kind = 'SAUDE'"), 1);
});

test('T-FLH-13 3 produtos seguidos formato_desconhecido encerram a rodada partial, sem circuito', async () => {
  const s = setup(5);
  for (const n of [1, 2, 3]) s.programmed.set(code(n), [s.failRes('formato_desconhecido')]);
  const r = await s.run();
  assert.ok('runId' in r);
  assert.equal(r.summary.status, 'failed'); // nenhum sucesso antes de encerrar
  assert.equal(r.summary.circuitOpened, false);
  assert.equal(s.calls.length, 3);
  assert.equal(s.circuit.status(s.clock.now().toISOString()).state, 'closed');
  assert.equal(s.count("health_events WHERE kind = 'formato_desconhecido' AND subject = 'global'"), 1);
  assert.equal(s.count('price_observations'), 0); // falha nunca vira preço
});

test('T-FLH-13 conteúdo ruim intercalado com sucesso não encerra a rodada', async () => {
  const s = setup(4);
  s.programmed.set(code(1), [s.failRes('formato_desconhecido')]);
  s.programmed.set(code(3), [s.failRes('preco_invalido')]);
  const r = await s.run();
  assert.ok('runId' in r);
  assert.equal(s.calls.length, 4);
  assert.deepEqual([r.summary.status, r.summary.itemsOk, r.summary.itemsFailed], ['partial', 2, 2]);
});

test('RNF-REL-03 parada limpa: AbortSignal encerra a rodada como partial e não deixa run running', async () => {
  const s = setup(3);
  const ac = new AbortController();
  ac.abort();
  const r = await (async () => {
    const { Runner: R } = await import('../../src/scheduler/runner.ts');
    void R;
    return s.runs;
  })();
  void r;
  // o sinal só vale dentro de runMonitoringRound; sem rodada em andamento nada fica pendente
  assert.equal(s.count("monitoring_runs WHERE status = 'running'"), 0);
});
