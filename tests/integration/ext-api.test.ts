import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { AlertService } from '../../src/app/alerts.ts';
import { createApi, registerApi, type ApiDeps } from '../../src/ext/background/api.ts';
import { ok, err } from '../../src/shared/result.ts';
import { createAlertStore } from '../../src/store/alerts.store.ts';
import { createObservationRepo } from '../../src/store/history.store.ts';
import { createMemoryDb } from '../../src/store/memory.ts';
import { createProductRepo } from '../../src/store/monitor.store.ts';
import { IdbNotificationRepo } from '../../src/store/notifications.store.ts';
import { createSettingsStore } from '../../src/store/settings.store.ts';
import { createKvStore } from '../../src/store/state.store.ts';
import { ManualClock } from '../helpers/clock.ts';
import { installFakeChrome, type FakeChrome } from '../helpers/fake-chrome.ts';

const T0 = '2026-10-14T12:00:00.000Z';
const CODE = 'P000000001';
const V = `${CODE}-34`;
const URL_OK = `https://www.vans.com.br/old-skool/p/${CODE}`;
const KEY = 're_SEGREDO_123456';

let fc: FakeChrome;
afterEach(() => fc?.uninstall());

async function setup(over: Partial<ApiDeps> = {}) {
  fc = installFakeChrome();
  const db = createMemoryDb();
  const clock = new ManualClock(T0);
  const products = createProductRepo(db);
  await products.upsertProduct({ code: CODE, name: 'Old Skool', legacySku: null, slug: 'old-skool' }, T0);
  await products.upsertVariants(CODE, ['34', '35'].map((s) => ({ variantCode: `${CODE}-${s}`, size: s, ean: null })), T0);
  const alertRepo = createAlertStore(db);
  const observations = createObservationRepo(db);
  const notifications = new IdbNotificationRepo(db);
  const settings = createSettingsStore(createKvStore(db));
  const alerts = new AlertService({
    alerts: alertRepo, observations, notifications, clock, mode: 'teste', products,
    tx: (fn) => db.tx(fn), emailEnabled: async () => false,
  });
  let discovered = 0;
  const calls = { resend: [] as string[], runNow: 0, tests: 0 };
  const deps: ApiDeps = {
    alerts, alertRepo, products, observations, notifications, settings,
    notifier: { reenviar: async (k) => (calls.resend.push(k), k === 'falhou') },
    monitor: {
      discoverProduct: async (code) => {
        discovered++;
        const p = await products.get(code);
        return p ? ok({ product: p, variants: await products.listVariants(code), fromCache: true }) : err({ reason: 'falha' as const, failureClass: 'produto_removido' as never });
      },
      resumeProduct: async (code) => code === CODE,
    },
    health: async () => ({
      version: '0.2.0', now: T0,
      scheduler: { status: 'ok', lastRun: { status: 'ok', trigger: 'scheduled', startedAt: T0, finishedAt: T0, itemsOk: 2, itemsFailed: 1 }, lastTickAt: T0 },
      circuit: { open: true, reason: 'http_429', until: '2026-10-15T12:00:00.000Z' },
      freshness: { fresco: 0, defasado: 0, sem_dados: 0 }, budget24h: { used: 5, limit: 400, remaining: 395 },
      openEvents: [{ id: 1, kind: 'x', subject: 's', openedAt: T0 }], emailMode: 'teste',
      counters: {},
    }) as never,
    catalog: {
      search: async () => [{ code: CODE, name: 'Old Skool', lastSlug: 'old-skool', priceCents: 29999 }],
      refreshedAt: async () => T0,
      refresh: async () => err({ reason: 'intervalo_minimo' as const, nextAllowedAt: T0 }),
    },
    runNow: async () => (calls.runNow++, { result: 'started' }),
    sendTestEmail: async () => (calls.tests++, { kind: 'accepted', providerMessageId: 'sim', simulated: true }),
    hasMailPermission: async () => true,
    ...over,
  };
  const api = createApi(deps);
  const call = (m: unknown) => api.handle(m, fc.sender);
  let seq = 0;
  const addObs = async (v: string, cents: number, confirmed = true) =>
    observations.insert({ variantCode: v, runId: 1, seq: ++seq, observedAt: T0, originalCents: 40000, currentCents: cents, available: true, confirmed, degraded: false, source: 'occ' });
  return { api, call, db, deps, calls, addObs, discovered: () => discovered };
}

const code = (r: unknown) => (r as { ok: false; error: { code: string } }).error.code;
const data = (r: unknown) => (r as { ok: true; data: any }).data; // eslint-disable-line @typescript-eslint/no-explicit-any

test('T-SEC-20 remetente: outro id, pagina web e content script sao recusados sem tocar servicos (RNF-SEC)', async () => {
  const { api, deps } = await setup();
  let touched = 0;
  deps.settings.getPublic = async () => (touched++, null as never);
  const msg = { type: 'settings.get' };
  for (const s of [
    { id: 'outro', url: fc.sender.url },
    { id: fc.sender.id, url: 'https://www.vans.com.br/p/x' },
    { id: fc.sender.id, url: 'chrome-extension://outro/popup.html' },
    { id: fc.sender.id },
    {},
  ]) assert.equal(code(await api.handle(msg, s)), 'remetente_invalido');
  assert.equal(touched, 0);
});

test('T-SEC-20 registerApi: remetente invalido responde sem compor servicos; valido atende por runtime.sendMessage', async () => {
  const { api } = await setup();
  let composed = 0;
  registerApi(() => (composed++, api));
  const bad = (await fc.sendFrom({ type: 'settings.get' }, { id: 'x', url: 'https://evil.example/' })) as never;
  assert.equal(code(bad), 'remetente_invalido');
  assert.equal(composed, 0);
  const good = await chrome.runtime.sendMessage({ type: 'settings.get' });
  assert.equal((good as { ok: boolean }).ok, true);
  assert.equal(composed, 1);
});

test('T-WEB-08 payload invalido: tipo desconhecido, campos fora de forma e alvo ruim viram erro pt-BR (RF-04)', async () => {
  const { call } = await setup();
  for (const m of [null, 'x', { type: 'nope' }, { type: 'alert.pause', id: '1' }, { type: 'alert.create', variantCode: '../x', target: '1' },
    { type: 'alert.create', variantCode: V, target: 'abc' }, { type: 'history.get', alertId: 1, page: -1 }]) {
    const r = await call(m);
    assert.equal(code(r), 'requisicao_invalida');
    assert.ok(typeof (r as { error: { message: string } }).error.message === 'string');
  }
});

test('T-WEB-01 alert.create/list/update/pause/resume/delete de ponta a ponta (RF-03/04/05/09)', async () => {
  const { call, addObs } = await setup();
  await addObs(V, 25000);
  const c = await call({ type: 'alert.create', variantCode: V, target: '199,90', margin: '3' });
  assert.equal(data(c).warning, null); // alvo abaixo do preco atual: sem aviso
  const id = data(c).id;
  assert.equal(code(await call({ type: 'alert.create', variantCode: V, target: '199,90', margin: '3' })), 'duplicado');
  const l = data(await call({ type: 'alerts.list' }));
  assert.equal(l.intervalHours, 4);
  assert.deepEqual(
    { n: l.alerts.length, name: l.alerts[0].productName, size: l.alerts[0].size, price: l.alerts[0].priceCents, st: l.alerts[0].status, t: l.alerts[0].targetCents, m: l.alerts[0].marginBp },
    { n: 1, name: 'Old Skool', size: '34', price: 25000, st: 'ATIVO', t: 19990, m: 300 });
  // update parcial: so o alvo; a margem atual (3%) e preservada
  assert.equal((await call({ type: 'alert.update', id, target: '150,00' })).ok, true);
  const u = data(await call({ type: 'alerts.list' })).alerts[0];
  assert.deepEqual([u.targetCents, u.marginBp], [15000, 300]);
  assert.equal((await call({ type: 'alert.pause', id })).ok, true);
  assert.equal(data(await call({ type: 'alerts.list' })).alerts[0].status, 'PAUSADO');
  assert.equal((await call({ type: 'alert.resume', id })).ok, true);
  assert.equal((await call({ type: 'alert.delete', id })).ok, true);
  assert.equal(code(await call({ type: 'alert.delete', id })), 'nao_encontrado');
  assert.equal(code(await call({ type: 'alert.update', id: 999, target: '1,00' })), 'nao_encontrado');
  assert.equal(code(await call({ type: 'alert.create', variantCode: `${CODE}-99`, target: '10,00' })), 'nao_encontrado');
});

test('T-IDN-01 tab.inspect: so produto Vans gera leitura; preco so de leitura confirmada, nunca 0 (RF-02/03)', async () => {
  const { call, addObs, discovered } = await setup();
  assert.equal(code(await call({ type: 'tab.inspect', url: 'https://evil.example/p/' + CODE })), 'requisicao_invalida');
  assert.equal(discovered(), 0);
  await addObs(`${CODE}-35`, 30000, false); // nao confirmada: nao vira preco
  await addObs(V, 28000);
  const d = data(await call({ type: 'tab.inspect', url: URL_OK }));
  assert.equal(d.code, CODE);
  const by = Object.fromEntries(d.variants.map((v: { size: string; priceCents: number | null }) => [v.size, v.priceCents]));
  assert.deepEqual(by, { 34: 28000, 35: null });
  assert.deepEqual(d.monitored, []);
  await call({ type: 'alert.create', variantCode: V, target: '200,00' });
  assert.equal(data(await call({ type: 'tab.inspect', url: URL_OK })).monitored[0].variantCode, V);
});

test('T-IDN-02 tab.inspect: falha da fonte, circuito e orcamento viram erro tipado pt-BR', async () => {
  const mk = (e: unknown) => setup({ monitor: { discoverProduct: async () => err(e as never), resumeProduct: async () => false } });
  assert.equal(code(await (await mk({ reason: 'circuito_aberto' })).call({ type: 'tab.inspect', url: URL_OK })), 'circuito_aberto');
  fc.uninstall();
  assert.equal(code(await (await mk({ reason: 'orcamento_diario' })).call({ type: 'tab.inspect', url: URL_OK })), 'falha_externa');
  fc.uninstall();
  const r = await (await mk({ reason: 'falha', failureClass: 'formato_desconhecido' })).call({ type: 'tab.inspect', url: URL_OK });
  assert.match((r as { error: { message: string } }).error.message, /formato_desconhecido/);
});

test('T-SEC-21 RF-08 settings: apiKey nunca na saida; get so devolve apiKeySet; chave pode ser removida', async () => {
  const { call } = await setup();
  const set = await call({ type: 'settings.set', settings: { intervalHours: 3, email: { mode: 'real', enabled: true, to: 'a@b.com', from: 'c@d.com', apiKey: KEY } } });
  assert.equal(set.ok, true);
  const get = await call({ type: 'settings.get' });
  for (const r of [set, get]) {
    assert.ok(!JSON.stringify(r).includes(KEY));
    assert.equal(data(r).email.apiKeySet, true);
    assert.ok(!('apiKey' in data(r).email));
  }
  assert.equal(data(get).intervalHours, 3);
  const rm = await call({ type: 'settings.set', settings: { intervalHours: 3, email: { mode: 'teste', enabled: false, to: 'a@b.com', from: 'c@d.com', apiKey: null } } });
  assert.equal(data(rm).email.apiKeySet, false);
});

test('T-SEC-21 settings real/ativo sem permissao de host e recusado; modo real sem chave tambem', async () => {
  const { call } = await setup({ hasMailPermission: async () => false });
  const base = { intervalHours: 4, email: { mode: 'real' as const, enabled: true, to: 'a@b.com', from: 'c@d.com', apiKey: KEY } };
  assert.equal(code(await call({ type: 'settings.set', settings: base })), 'permissao_ausente');
  const s2 = await setup();
  assert.equal(code(await s2.call({ type: 'settings.set', settings: { ...base, email: { ...base.email, apiKey: undefined } } })), 'requisicao_invalida');
});

test('T-NOT-12 email.test: sem config recusa; simulado informa simulated; falha do provedor sem texto bruto (RF-08)', async () => {
  const s = await setup();
  assert.equal(code(await s.call({ type: 'email.test' })), 'requisicao_invalida');
  await s.call({ type: 'settings.set', settings: { intervalHours: 4, email: { mode: 'teste', enabled: true, to: 'a@b.com', from: 'c@d.com' } } });
  assert.deepEqual(data(await s.call({ type: 'email.test' })), { accepted: true, simulated: true });
  fc.uninstall();
  const f = await setup({ sendTestEmail: async () => ({ kind: 'permanent_error', reason: `401 Bearer ${KEY} <html>` }) });
  await f.call({ type: 'settings.set', settings: { intervalHours: 4, email: { mode: 'teste', enabled: true, to: 'a@b.com', from: 'c@d.com' } } });
  const r = await f.call({ type: 'email.test' });
  assert.equal(code(r), 'falha_externa');
  assert.ok(!JSON.stringify(r).includes(KEY));
});

test('T-WEB-04 history.get pagina (50) com hasMore e notificacoes so na pagina 0 (RF-07)', async () => {
  const { call, addObs } = await setup();
  for (let i = 0; i < 51; i++) await addObs(V, 20000 + i);
  const id = data(await call({ type: 'alert.create', variantCode: V, target: '100,00' })).id;
  const p0 = data(await call({ type: 'history.get', alertId: id, page: 0 }));
  assert.equal(p0.observations.length, 50);
  assert.equal(p0.hasMore, true);
  assert.deepEqual(p0.notifications, []);
  const p1 = data(await call({ type: 'history.get', alertId: id, page: 1 }));
  assert.equal(p1.observations.length, 1);
  assert.equal(p1.hasMore, false);
  assert.equal(code(await call({ type: 'history.get', alertId: 999, page: 0 })), 'nao_encontrado');
});

test('T-OBS-02 health.get no formato do painel, sem PII; monitor.runNow, product.resume, notification.resend, catalog.*', async () => {
  const { call, calls } = await setup();
  const h = data(await call({ type: 'health.get' }));
  assert.deepEqual(h.circuit, { openUntil: '2026-10-15T12:00:00.000Z', reason: 'http_429' });
  assert.deepEqual(h.budget, { used: 5, limit: 400 });
  assert.equal(h.lastRun.ok, 2);
  assert.equal(h.intervalMs, 4 * 3_600_000);
  assert.deepEqual(data(await call({ type: 'monitor.runNow' })), { result: 'started' });
  assert.equal(calls.runNow, 1);
  assert.equal((await call({ type: 'product.resume', code: CODE })).ok, true);
  assert.equal(code(await call({ type: 'product.resume', code: 'ZZZZZZZZZZ' })), 'nao_encontrado');
  assert.equal((await call({ type: 'notification.resend', key: 'falhou' })).ok, true);
  assert.equal(code(await call({ type: 'notification.resend', key: 'ok' })), 'nao_encontrado');
  const cs = data(await call({ type: 'catalog.search', q: 'old' }));
  assert.equal(cs.items[0].priceCents, 29999);
  assert.equal(cs.refreshedAt, T0);
  assert.equal(code(await call({ type: 'catalog.refresh' })), 'requisicao_invalida'); // intervalo minimo
});

test('T-SEC-22 excecao interna: erro generico pt-BR, sem stack/mensagem; log so com o evento', async () => {
  const logged: string[] = [];
  const log = { debug() {}, info() {}, warn() {}, error: (e: string) => void logged.push(e) };
  const { call } = await setup({ runNow: async () => { throw new Error(`falha em C:\\x\\y.ts com ${KEY}`); }, log });
  const r = await call({ type: 'monitor.runNow' });
  assert.equal(code(r), 'interno');
  assert.ok(!/C:|\.ts|at |re_SEGREDO/.test(JSON.stringify(r)));
  assert.deepEqual(logged, ['api_erro']);
});
