import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ManualClock } from '../helpers/clock.ts';
import { createMemoryDb } from '../../src/store/memory.ts';
import { createCatalogStore } from '../../src/store/catalog.store.ts';
import type { CircuitStatus } from '../../src/scheduler/circuit.ts';
import type { HttpClient, HttpResult } from '../../src/price-monitor/ports.ts';
import { BudgetExceededError } from '../../src/app/rate-gate.ts';
import { CATALOG_MIN_INTERVAL_MS, createCatalogApp } from '../../src/app/catalog.ts';

const START = '2026-10-14T12:00:00.000Z';
const code = (n: number) => `10000000${String(n).padStart(5, '0')}U`;
const prod = (n: number, name = `Tênis Modelo ${n}`) => ({ code: code(n), name, price: { value: 399.9 }, url: `/m${n}/p/${code(n)}` });
const listing = (page: number, totalPages: number, products: unknown[]): HttpResult => ({
  ok: true, status: 200, contentType: 'application/json',
  body: JSON.stringify({ products, pagination: { currentPage: page, totalPages } }),
});
const pageOf = (u: string) => new URL(u).searchParams.get('currentPage');

// pages[i] = resposta da página i (Error = lança). Cada página "custa" 60 s no relógio manual (cortesia simulada).
function setup(pages: (HttpResult | Error)[], sliceMs = 150_000) {
  const clock = new ManualClock(START);
  const store = createCatalogStore(createMemoryDb());
  const calls: string[] = [];
  const opened: string[] = [];
  let circ: CircuitStatus = { state: 'closed' };
  const http: HttpClient = {
    async get(r) {
      calls.push(r.url.toString());
      const p = pages[Number(r.url.searchParams.get('currentPage'))];
      if (p instanceof Error) throw p;
      await clock.advance(60_000);
      return p ?? { ok: false, failure: 'rede_timeout' };
    },
  };
  const circuit = {
    status: async () => circ,
    open: (r: string) => {
      opened.push(r);
      circ = { state: 'open', until: '2099-01-01T00:00:00.000Z', reason: r };
    },
  };
  const app = createCatalogApp({ store, http, clock, circuit, sliceMs });
  return { app, store, clock, calls, opened, http, circuit };
}

test('T-CAT-02 RF-01-AC1 catálogo vazio: busca e isEmpty não chamam a rede', async () => {
  const { app, calls } = setup([]);
  assert.equal(await app.isEmpty(), true);
  assert.deepEqual(await app.search('era'), []);
  assert.equal(calls.length, 0);
});

test('T-CAT-01 atualização completa troca a geração; busca sem acento/caixa; só URL de categoria', async () => {
  const { app, calls } = setup([listing(0, 2, [prod(1), { name: 'sem code' }]), listing(1, 2, [prod(2, 'Authentic Preto')])]);
  const r = await app.refresh();
  assert.deepEqual(r.ok && r.value, { done: true, pages: 2, skipped: 1, count: 2 });
  assert.equal((await app.search('TENIS')).length, 1);
  assert.equal(await app.lastRefreshAt(), '2026-10-14T12:02:00.000Z');
  assert.ok(calls.every((u) => u.includes('category=SAPATOS') && !/[?&](q|query)=/.test(u) && !u.includes('/search/')));
  assert.deepEqual(calls.map(pageOf), ['0', '1']);
});

test('T-CAT-03 RF-01-AC3 segunda atualização < 24 h recusada com a data; após 24 h passa', async () => {
  const { app, clock, calls } = setup([listing(0, 1, [prod(1)])]);
  assert.ok((await app.refresh()).ok);
  const done = clock.now().getTime();
  await clock.advance(3_600_000);
  const r = await app.refresh();
  assert.deepEqual(!r.ok && r.error, { reason: 'intervalo_minimo', nextAllowedAt: new Date(done + CATALOG_MIN_INTERVAL_MS).toISOString() });
  assert.equal(calls.length, 1);
  await clock.advance(CATALOG_MIN_INTERVAL_MS);
  assert.ok((await app.refresh()).ok);
});

test('T-CAT-05 RF-01-AC5 429 na 2ª página: mantém catálogo anterior, sinaliza circuito', async () => {
  const s = setup([listing(0, 1, [prod(1, 'Antigo Era')])]);
  assert.ok((await s.app.refresh()).ok);
  await s.clock.advance(CATALOG_MIN_INTERVAL_MS);
  const bad: HttpClient = {
    get: async (r) =>
      Number(r.url.searchParams.get('currentPage')) === 0 ? listing(0, 3, [prod(9, 'Novo')]) : { ok: false, failure: 'http_429', status: 429 },
  };
  const app2 = createCatalogApp({ store: s.store, http: bad, clock: s.clock, circuit: s.circuit });
  const r = await app2.refresh();
  assert.deepEqual(!r.ok && r.error, { reason: 'falha', failure: 'http_429', httpStatus: 429, circuitOpened: true });
  assert.deepEqual(s.opened, ['http_429']);
  assert.deepEqual((await s.store.search('', 50)).map((i) => i.name), ['Antigo Era']);
  assert.equal(await s.store.count(), 1);
});

test('RN-18 403 sinaliza o circuito e o circuito aberto recusa sem rede; 5xx não abre circuito', async () => {
  const s = setup([{ ok: false, failure: 'http_403_ou_desafio', status: 403 }]);
  const r = await s.app.refresh();
  assert.ok(!r.ok && r.error.reason === 'falha' && r.error.circuitOpened);
  assert.deepEqual(s.opened, ['http_403_ou_desafio']);
  const n = s.calls.length;
  const r2 = await s.app.refresh();
  assert.ok(!r2.ok && r2.error.reason === 'circuito_aberto');
  assert.equal(s.calls.length, n);

  const t = setup([{ ok: false, failure: 'http_5xx', status: 503 }]);
  const r3 = await t.app.refresh();
  assert.ok(!r3.ok && r3.error.reason === 'falha' && !r3.error.circuitOpened);
  assert.deepEqual(t.opened, []);
});

test('RF-01-AC4 falha de extração (sem item válido / corpo não-JSON) nunca vira catálogo', async () => {
  const s = setup([listing(0, 1, [{ name: 'x' }])]);
  const r = await s.app.refresh();
  assert.ok(!r.ok && r.error.reason === 'falha' && r.error.failure === 'formato_desconhecido');
  assert.equal(await s.app.isEmpty(), true);
  const b = setup([{ ok: true, status: 200, contentType: 'text/html', body: '<html>' }]);
  const r2 = await b.app.refresh();
  assert.ok(!r2.ok && r2.error.reason === 'falha' && r2.error.failure === 'formato_desconhecido');
});

test('fatias: tempo esgota, nada visível, nova chamada retoma do cursor (sem trava de 24 h) e conclui', async () => {
  const pages = [0, 1, 2, 3].map((p) => listing(p, 4, [prod(p * 2 + 1), prod(p * 2 + 2)]));
  const s = setup(pages, 100_000); // 60 s/página => 2 páginas por fatia
  const r1 = await s.app.refresh();
  assert.deepEqual(r1.ok && r1.value, { done: false, pages: 2, skipped: 0, count: null });
  assert.equal(await s.app.isEmpty(), true);
  assert.deepEqual(await s.store.getCursor(), { gen: 1, page: 2 });
  const r2 = await s.app.refresh();
  assert.deepEqual(r2.ok && r2.value, { done: true, pages: 2, skipped: 0, count: 8 });
  assert.equal(await s.store.getCursor(), null);
  assert.deepEqual(s.calls.map(pageOf), ['0', '1', '2', '3']);
});

test('SW "morto" entre fatias: nova instância retoma do cursor sem duplicar itens', async () => {
  const pages = [0, 1, 2].map((p) => listing(p, 3, [prod(p + 1)]));
  const a = setup(pages, 1); // 1 página por fatia
  assert.ok((await a.app.refresh()).ok);
  const b = createCatalogApp({
    store: a.store, clock: a.clock, circuit: a.circuit,
    http: { get: async (r) => pages[Number(r.url.searchParams.get('currentPage'))] as HttpResult },
  });
  const r = await b.refresh();
  assert.deepEqual(r.ok && r.value, { done: true, pages: 2, skipped: 0, count: 3 });
  assert.equal((await a.store.search('', 50)).length, 3);
});

test('RNF-REL-04 orçamento diário esgotado vira recusa com cursor preservado; chamada concorrente = em_andamento', async () => {
  const s = setup([listing(0, 2, [prod(1)]), new BudgetExceededError()]);
  const r = await s.app.refresh();
  assert.ok(!r.ok && r.error.reason === 'orcamento_esgotado');
  assert.deepEqual(await s.store.getCursor(), { gen: 1, page: 1 });

  const c = setup([listing(0, 1, [prod(1)])]);
  const [x, y] = await Promise.all([c.app.refresh(), c.app.refresh()]);
  assert.ok(x.ok && !y.ok && y.error.reason === 'em_andamento');
});
