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
import { BudgetExceededError } from '../../src/price-monitor/http/rate-gate.ts';
import { MonitorService } from '../../src/price-monitor/monitor.service.ts';
import { createProductRepo, createRunRepo } from '../../src/price-monitor/monitor.repo.ts';
import type { Failure, PriceSource, ProductSnapshot, SourceResult } from '../../src/price-monitor/ports.ts';
import { FakeSource } from '../../src/price-monitor/fake.source.ts';
import { CircuitStore } from '../../src/scheduler/circuit.ts';
import type { FailureClass, SourceName } from '../../src/shared/types.ts';
import { ManualClock } from '../helpers/clock.ts';
import { makeDb } from '../helpers/db.ts';

const T0 = '2026-10-14T12:00:00.000Z';
const HOUR = 3_600_000;
const CODE = '1003800580026U';
const V34 = `${CODE}-34`;
const V35 = `${CODE}-35`;
const DONE = { status: 'ok', itemsTotal: 1, itemsOk: 1, itemsFailed: 0, requestsMade: 1, circuitOpened: false } as const;

interface SnapOpts {
  c34?: number;
  c35?: number;
  orig?: number;
  source?: SourceName;
  degraded?: boolean;
  name?: string;
  available?: boolean;
}

function setup(opts: { ownerEmail?: string | null; confirmReread?: boolean; source?: PriceSource } = {}) {
  const db = makeDb();
  const clock = new ManualClock(T0);
  const iso = () => clock.now().toISOString();
  const products = {
    ...createProductRepo(db),
    // contrato pedido a T24 (ProductRepo.resetFailures); aqui emulado com SQL
    resetFailures(code: string, now: string) {
      db.prepare('UPDATE products SET consecutive_failures = 0, not_found_streak = 0, updated_at = ? WHERE code = ?').run(now, code);
    },
  };
  const runs = createRunRepo(db);
  const alerts = createAlertRepo(db);
  const observations = new SqliteObservationRepo(db);
  const notifRepo = new SqliteNotificationRepo(db);
  const mailer = new FakeMailer('teste');
  const lines: string[] = [];
  const log = createLogger('monitor', clock, (l) => lines.push(l));
  const notifications = new NotificationService({
    repo: notifRepo, alerts, mailer, clock, log,
    ownerEmail: opts.ownerEmail === undefined ? 'dono@exemplo.com' : opts.ownerEmail,
  });
  const tx = <T>(fn: () => T): T => transaction(db, fn);
  const alertService = new AlertService({ alerts, notifications: notifRepo, observations, products, clock, tx, mode: 'teste' });
  const health = createHealthEventRepo(db);
  const circuit = new CircuitStore(createStateRepo(db));
  const svc = new MonitorService({
    source: opts.source ?? new FakeSource({}),
    products, observations, alerts, alertService, notifications, runs, health, circuit, clock, log, tx,
    confirmReread: opts.confirmReread ?? true,
  });
  const count = (t: string) => (db.prepare(`SELECT count(*) c FROM ${t}`).get() as { c: number }).c;
  const snap = (o: SnapOpts = {}): ProductSnapshot => {
    const orig = o.orig ?? 40000;
    const v = (code: string, size: string, cents: number) => ({
      variantCode: code, size, ean: null, originalCents: orig, currentCents: cents, available: o.available ?? true,
    });
    return {
      code: CODE, name: o.name ?? 'Old Skool', slug: 'old-skool', legacySku: null, source: o.source ?? 'occ',
      degraded: o.degraded ?? false, fetchedAt: iso(), skippedVariants: 0,
      variants: [v(V34, '34', o.c34 ?? 35000), v(V35, '35', o.c35 ?? 35000)],
    };
  };
  const okRes = (o: SnapOpts = {}): SourceResult => ({ ok: true, snapshot: snap(o), httpStatus: 200, requests: 1 });
  const failRes = (cls: FailureClass, extra: Partial<Failure> = {}): SourceResult => ({
    ok: false, failure: { class: cls, ...extra }, requests: 1,
  });
  // abre uma rodada nova, processa e fecha (itens são únicos por rodada e produto)
  const round = (res: SourceResult, o: { seq?: 1 | 2 } = {}) => {
    const r = runs.tryStart('monitor', 'manual', iso());
    assert.ok('runId' in r);
    const out = svc.processResult(r.runId, CODE, res, o);
    runs.finish(r.runId, DONE, iso());
    return { runId: r.runId, out };
  };
  const alert = (variant = V34, target = 30000) => {
    products.upsertProduct({ code: CODE, name: 'Old Skool', legacySku: null, slug: 'old-skool' }, T0);
    products.upsertVariants(CODE, [{ variantCode: V34, size: '34', ean: null }, { variantCode: V35, size: '35', ean: null }], T0);
    return alerts.create({ variantCode: variant, targetCents: target, marginBp: 300, email: 'a@b.co' }, T0);
  };
  const obs = () => db.prepare('SELECT variant_code v, current_cents c, confirmed, seq FROM price_observations ORDER BY id').all() as
    { v: string; c: number; confirmed: number; seq: number }[];
  return { db, clock, svc, products, runs, alerts, observations, notifRepo, mailer, lines, count, snap, okRes, failRes, round, alert, obs, tx, health };
}

test('sucesso: observa so variante com alerta, confirma 1a leitura OCC e dispara 1 notificacao (RF-06-AC7, RF-02-AC6)', () => {
  const s = setup();
  const id = s.alert();
  const { out } = s.round(s.okRes({ c34: 29000 }));
  assert.ok(out.ok);
  assert.equal(out.observationsWritten, 1); // V35 sem alerta e nunca observada: fora
  assert.equal(out.notificationsCreated, 1);
  assert.equal(out.needsReread, false);
  assert.deepEqual(s.obs(), [{ v: V34, c: 29000, confirmed: 1, seq: 1 }]);
  const n = s.notifRepo.listForAlert(id);
  assert.equal(n.length, 1);
  assert.equal(n[0]!.kind, 'ATINGIDO');
  assert.equal(n[0]!.priceCents, 29000);
  assert.equal(s.count('product_variants'), 2);
  const item = s.db.prepare('SELECT outcome, observations_written o FROM run_items').get() as { outcome: string; o: number };
  assert.deepEqual({ ...item }, { outcome: 'ok', o: 1 });
});

test('T-FLH-06 sem estoque grava observacao disponivel=false com preco correto, sem alerta e sem remover', () => {
  const s = setup();
  s.alert();
  const { out } = s.round(s.okRes({ c34: 14999, orig: 14999, available: false }));
  assert.ok(out.ok);
  assert.equal(s.obs()[0]!.c, 14999);
  assert.equal(s.count('notifications'), 0);
  assert.equal(s.products.get(CODE)!.state, 'ativo');
});

test('T-FLH-01 / T-HST-02 falha nao cria observacao nem alerta e o ultimo preco confirmado fica (RF-11-AC1, RF-07-AC3)', () => {
  const s = setup();
  s.alert();
  s.round(s.okRes({ c34: 35000 }));
  for (const cls of ['http_403_ou_desafio', 'http_429', 'http_5xx', 'rede_timeout', 'formato_desconhecido', 'preco_invalido'] as const) {
    const { out } = s.round(s.failRes(cls));
    assert.ok(!out.ok && out.failureClass === cls);
  }
  assert.equal(s.obs().length, 1);
  assert.equal(s.observations.latestConfirmed(V34)!.currentCents, 35000);
  assert.equal(s.count('notifications') - s.count('notifications WHERE kind = \'SAUDE\''), 0);
  assert.equal(s.count('run_items WHERE outcome = \'falha\''), 6);
});

test('T-FLH-07 3 falhas seguidas => com_falha e 1 SAUDE por episodio; sucesso fecha o episodio (RF-11-AC7)', () => {
  const s = setup();
  s.alert();
  s.round(s.failRes('http_5xx'));
  s.round(s.failRes('rede_timeout'));
  assert.equal(s.count('notifications'), 0);
  const third = s.round(s.failRes('http_5xx')).out;
  assert.ok(!third.ok && third.consecutiveFailures === 3);
  s.round(s.failRes('http_5xx'));
  assert.equal(s.count('notifications WHERE kind = \'SAUDE\''), 1);
  assert.equal(s.count('health_events WHERE closed_at IS NULL'), 1);
  s.round(s.okRes());
  assert.equal(s.count('health_events WHERE closed_at IS NULL'), 0);
  assert.equal(s.products.get(CODE)!.consecutiveFailures, 0);
});

test('T-FLH-05 produto_removido em 2 rodadas => removido, 1 SAUDE; 1 rodada so nao remove (RF-11-AC5, RN-19)', () => {
  const s = setup();
  s.alert();
  const first = s.round(s.failRes('produto_removido', { httpStatus: 404 })).out;
  assert.ok(!first.ok && first.state === 'ativo');
  s.round(s.okRes()); // zera a sequencia
  s.round(s.failRes('produto_removido'));
  const out = s.round(s.failRes('produto_removido')).out;
  assert.ok(!out.ok && out.state === 'removido');
  assert.equal(s.products.get(CODE)!.state, 'removido');
  assert.equal(s.count('notifications WHERE kind = \'SAUDE\''), 1);
  assert.equal(s.count('health_events WHERE kind = \'produto_removido\''), 1);
});

test('T-FLH-04 fallback: degradada, aviso 1x, 1a leitura nao dispara; 2a concordante de outra rodada confirma e dispara (RF-11-AC4)', () => {
  const s = setup();
  const id = s.alert();
  const a = s.round(s.okRes({ source: 'next_data', degraded: true, c34: 29000 })).out;
  assert.ok(a.ok && a.degraded && !a.needsReread); // fallback nunca e relido na hora
  assert.equal(s.obs()[0]!.confirmed, 0);
  assert.equal(s.notifRepo.listForAlert(id).length, 0);
  assert.equal(s.count('notifications WHERE kind = \'SAUDE\''), 1);
  s.clock.advance(4 * HOUR);
  const b = s.round(s.okRes({ source: 'next_data', degraded: true, c34: 29000 })).out;
  assert.ok(b.ok && b.notificationsCreated === 1);
  assert.equal(s.count('notifications WHERE kind = \'SAUDE\''), 1); // mesmo episodio: sem novo aviso
  const rows = s.db.prepare('SELECT confirmed, confirmed_by, degraded FROM price_observations ORDER BY id').all();
  assert.equal((rows[0] as { confirmed: number }).confirmed, 1);
  assert.equal((rows[0] as { confirmed_by: number }).confirmed_by, 2);
  assert.equal(s.notifRepo.listForAlert(id)[0]!.degraded, true);
  const c = s.round(s.okRes({ c34: 29000 })).out; // OCC volta: fecha o episodio
  assert.ok(c.ok);
  assert.equal(s.count('health_events WHERE kind = \'parser_degradado\' AND closed_at IS NULL'), 0);
});

test('T-FLH-03 variacao > 70% fica nao confirmada, pede releitura; seq=2 concordante confirma e dispara (RF-11-AC3, RN-09c)', () => {
  const s = setup();
  const id = s.alert(V34, 10000);
  s.round(s.okRes({ c34: 35000 }));
  const r = s.runs.tryStart('monitor', 'manual', T0);
  assert.ok('runId' in r);
  const first = s.svc.processResult(r.runId, CODE, s.okRes({ c34: 9000 })); // queda de 74%
  assert.ok(first.ok && first.needsReread && first.notificationsCreated === 0);
  assert.equal(s.obs()[1]!.confirmed, 0);
  assert.equal(s.notifRepo.listForAlert(id).length, 0);
  // releitura na mesma rodada: seq=2, sem novo run_item
  const items = s.count('run_items');
  s.clock.advance(3_000);
  const out2 = s.svc.processResult(r.runId, CODE, s.okRes({ c34: 9000 }), { seq: 2 });
  assert.ok(out2.ok && out2.notificationsCreated === 1 && !out2.needsReread);
  assert.equal(s.count('run_items'), items);
  assert.ok(s.obs().some((o) => o.seq === 2 && o.confirmed === 1));
  assert.equal(s.notifRepo.listForAlert(id).length, 1);
});

test('T-FLH-03 releitura discordante nao confirma nem dispara; falha na releitura nao muda estado', () => {
  const s = setup();
  const id = s.alert(V34, 10000);
  s.round(s.okRes({ c34: 35000 }));
  const r = s.runs.tryStart('monitor', 'manual', T0);
  assert.ok('runId' in r);
  s.svc.processResult(r.runId, CODE, s.okRes({ c34: 9000 }));
  s.clock.advance(3_000);
  const fail = s.svc.processResult(r.runId, CODE, s.failRes('http_5xx'), { seq: 2 });
  assert.ok(!fail.ok);
  assert.equal(s.products.get(CODE)!.consecutiveFailures, 0);
  const out = s.svc.processResult(r.runId, CODE, s.okRes({ c34: 8500 }), { seq: 2 });
  assert.ok(out.ok && out.notificationsCreated === 0);
  assert.equal(s.notifRepo.listForAlert(id).length, 0);
  assert.equal(s.observations.latestConfirmed(V34)!.currentCents, 35000);
});

test('CONFIRM_REREAD=0 nao pede releitura (RN-09)', () => {
  const s = setup({ confirmReread: false });
  s.alert(V34, 10000);
  s.round(s.okRes({ c34: 35000 }));
  const out = s.round(s.okRes({ c34: 9000 })).out;
  assert.ok(out.ok && !out.needsReread);
});

test('T-FLH-15 1a leitura com desconto > 70% fica nao confirmada e nao dispara (RF-11-AC15)', () => {
  const s = setup();
  const id = s.alert(V34, 30000);
  const out = s.round(s.okRes({ orig: 100000, c34: 25000 })).out; // 75% de desconto
  assert.ok(out.ok && out.needsReread && out.notificationsCreated === 0);
  assert.equal(s.obs()[0]!.confirmed, 0);
  assert.equal(s.notifRepo.listForAlert(id).length, 0);
  const again = s.round(s.okRes({ orig: 100000, c34: 25000 }), { seq: 2 }).out; // concordante
  assert.ok(again.ok && again.notificationsCreated === 1);
});

test('T-FLH-02 preco_invalido (falha de classe) nunca vira R$ 0: observations so aceita > 0 (RF-11-AC2)', () => {
  const s = setup();
  s.alert();
  s.round(s.failRes('preco_invalido', { rawBody: '{"price":0}' }));
  assert.equal(s.count('price_observations'), 0);
  assert.equal(s.count('failure_samples'), 1);
});

test('T-SM-03 falha injetada no meio da transacao: rollback total, nada parcial persiste (RNF-REL-02)', () => {
  const s = setup();
  s.alert();
  // monta um servico cujo apply explode depois da observacao ser gravada
  const boom = new MonitorService({
    source: new FakeSource({}), products: s.products, observations: s.observations, alerts: s.alerts,
    alertService: { apply: () => { throw new Error('queda injetada'); } },
    notifications: { enqueue: () => null }, runs: s.runs, health: s.health,
    circuit: new CircuitStore(createStateRepo(s.db)), clock: s.clock,
    log: createLogger('t', s.clock, () => {}), tx: s.tx, confirmReread: true,
  });
  const r = s.runs.tryStart('monitor', 'manual', T0);
  assert.ok('runId' in r);
  assert.throws(() => boom.processResult(r.runId, CODE, s.okRes({ c34: 29000 })), /queda injetada/);
  assert.equal(s.count('price_observations'), 0);
  assert.equal(s.count('run_items'), 0);
  assert.equal(s.count('notifications'), 0);
  assert.equal(s.products.get(CODE)!.lastOkAt, null);
  const a = s.alerts.list()[0]!;
  assert.equal(a.evaluatedOnce, false);
});

test('dado da loja que viola CHECK (nome > 300) vira formato_desconhecido, sem observacao e sem excecao (RF-11-AC14)', () => {
  const s = setup();
  s.alert();
  const { out } = s.round(s.okRes({ name: 'x'.repeat(301), c34: 29000 }));
  assert.ok(!out.ok && out.failureClass === 'formato_desconhecido');
  assert.equal(s.count('price_observations'), 0);
  assert.equal(s.products.get(CODE)!.consecutiveFailures, 1);
  const item = s.db.prepare('SELECT outcome, failure_class f FROM run_items').get() as { outcome: string; f: string };
  assert.deepEqual({ ...item }, { outcome: 'falha', f: 'formato_desconhecido' });
});

test('3 formato_desconhecido seguidos => state formato_desconhecido e 1 SAUDE; resume volta a ativo e zera (RF-09-AC10, T-WEB-09)', () => {
  const s = setup();
  s.alert();
  s.round(s.failRes('formato_desconhecido'));
  s.round(s.failRes('formato_desconhecido'));
  const out = s.round(s.failRes('formato_desconhecido')).out;
  assert.ok(!out.ok && out.state === 'formato_desconhecido');
  assert.equal(s.count('notifications WHERE kind = \'SAUDE\''), 1);
  assert.equal(s.svc.resumeProduct(CODE), true);
  const p = s.products.get(CODE)!;
  assert.deepEqual([p.state, p.consecutiveFailures, p.notFoundStreak], ['ativo', 0, 0]);
  assert.equal(s.count('health_events WHERE closed_at IS NULL'), 0);
  assert.equal(s.svc.resumeProduct(CODE), false); // ja ativo: nada a retomar
  assert.equal(s.svc.resumeProduct('NAOEXISTE123'), false);
});

test('resume de removido volta a ativo e a proxima rodada o coleta (RF-09-AC10)', () => {
  const s = setup();
  s.alert();
  s.round(s.failRes('produto_removido'));
  s.round(s.failRes('produto_removido'));
  assert.equal(s.products.get(CODE)!.state, 'removido');
  assert.deepEqual(s.products.dueForCollection(s.clock.now().toISOString(), 0), []);
  s.svc.resumeProduct(CODE);
  assert.deepEqual(s.products.dueForCollection(s.clock.now().toISOString(), 0), [CODE]);
});

test('T-FLH-11 / T-RN-17 amostra de falha sem cookies/UTM, 1 por produto, limpa no sucesso e fora dos logs (RF-11-AC11, RN-21)', () => {
  const s = setup();
  s.alert();
  const body1 = 'Set-Cookie: sid=SEGREDO1\n<a href="/p/X?utm_source=fb&color=1">x</a>';
  s.round(s.failRes('formato_desconhecido', { rawBody: body1, httpStatus: 200 }));
  s.round(s.failRes('formato_desconhecido', { rawBody: 'Cookie: a=SEGREDO2\n<html>', httpStatus: 200 }));
  const rows = s.db.prepare('SELECT body FROM failure_samples').all() as { body: string }[];
  assert.equal(rows.length, 1);
  assert.ok(!/SEGREDO|utm_source|Cookie/i.test(rows[0]!.body));
  assert.ok(!s.lines.join('').includes('SEGREDO'));
  s.round(s.okRes());
  assert.equal(s.count('failure_samples'), 0);
});

test('amostra de 5xx so com corpo; 403 nao guarda corpo (RN-21)', () => {
  const s = setup();
  s.alert();
  s.round(s.failRes('http_403_ou_desafio', { rawBody: '<html>challenge</html>' }));
  assert.equal(s.count('failure_samples'), 0);
  s.round(s.failRes('http_5xx', { rawBody: 'erro interno', httpStatus: 503 }));
  assert.equal(s.count('failure_samples'), 1);
});

test('logs nao carregam e-mail nem corpo (RNF-PRIV-01)', () => {
  const s = setup();
  s.alert();
  s.round(s.okRes({ c34: 29000 }));
  s.round(s.failRes('http_5xx', { rawBody: 'corpo-secreto' }));
  const all = s.lines.join('');
  assert.ok(all.includes('produto_processado') && all.includes('produto_falhou'));
  assert.ok(!/a@b\.co|dono@exemplo|corpo-secreto/.test(all));
});

test('SAUDE sem OWNER_EMAIL nao e criada, mas o episodio de saude abre', () => {
  const s = setup({ ownerEmail: null });
  s.alert();
  for (let i = 0; i < 3; i++) s.round(s.failRes('http_5xx'));
  assert.equal(s.count('notifications'), 0);
  assert.equal(s.count('health_events'), 1);
});

test('T-URL-04 / RF-02-AC8 discover: 1a vez busca 1x e grava produto+variantes; < 2 h usa o banco; >= 2 h busca de novo', async () => {
  const src = new FakeSource({ [CODE]: { ...setup().snap() } });
  const s = setup({ source: src });
  const a = await s.svc.discoverProduct(CODE);
  assert.ok(a.ok && !a.value.fromCache && a.value.variants.length === 2);
  assert.equal(s.count('price_observations'), 0);
  s.clock.advance(HOUR + 59 * 60_000);
  const b = await s.svc.discoverProduct(CODE);
  assert.ok(b.ok && b.value.fromCache);
  assert.equal(src.calls.length, 1);
  s.clock.advance(2 * 60_000);
  const c = await s.svc.discoverProduct(CODE);
  assert.ok(c.ok && !c.value.fromCache);
  assert.equal(src.calls.length, 2);
});

test('discover: orcamento esgotado, circuito aberto e falha da loja viram erro sem gravar produto (RF-02-AC8, RN-18)', async () => {
  const budget: PriceSource = { name: 'fake', fetchProduct: () => Promise.reject(new BudgetExceededError()) };
  const s1 = setup({ source: budget });
  assert.deepEqual(await s1.svc.discoverProduct(CODE), { ok: false, error: { reason: 'orcamento_diario' } });

  const src = new FakeSource({ [CODE]: { ok: false, failure: { class: 'produto_removido' }, requests: 1 } });
  const s2 = setup({ source: src });
  assert.deepEqual(await s2.svc.discoverProduct(CODE), { ok: false, error: { reason: 'falha', failureClass: 'produto_removido' } });
  assert.equal(s2.count('products'), 0);

  const src3 = new FakeSource({});
  const s3 = setup({ source: src3 });
  new CircuitStore(createStateRepo(s3.db)).open('http_403_ou_desafio', s3.clock.now().toISOString());
  assert.deepEqual(await s3.svc.discoverProduct(CODE), { ok: false, error: { reason: 'circuito_aberto' } });
  assert.equal(src3.calls.length, 0);
});

test('discover: dado da loja invalido vira falha formato_desconhecido sem excecao', async () => {
  const s0 = setup();
  const s = setup({ source: new FakeSource({ [CODE]: s0.snap({ name: 'x'.repeat(301) }) }) });
  assert.deepEqual(await s.svc.discoverProduct(CODE), { ok: false, error: { reason: 'falha', failureClass: 'formato_desconhecido' } });
  assert.equal(s.count('products'), 0);
});
