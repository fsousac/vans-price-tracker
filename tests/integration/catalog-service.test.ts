import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from '../helpers/db.ts';
import { ManualClock } from '../helpers/clock.ts';
import { SqliteCatalogRepo } from '../../src/catalog/catalog.repo.ts';
import { CatalogService } from '../../src/catalog/catalog.service.ts';
import { createStateRepo } from '../../src/observability/state.repo.ts';
import { createRunRepo } from '../../src/price-monitor/monitor.repo.ts';
import { CircuitStore } from '../../src/scheduler/circuit.ts';
import type { HttpClient, HttpResult } from '../../src/price-monitor/ports.ts';

const START = '2026-10-14T12:00:00.000Z';
const prod = (n: number, extra: object = {}) => ({
  code: `10000000${String(n).padStart(4, '0')}U`,
  name: `Tênis ${n}`,
  url: `/tenis-${n}/p/10000000${String(n).padStart(4, '0')}U`,
  price: { value: 299.9 },
  ...extra,
});
const page = (n: number, total: number, products: object[]): HttpResult => ({
  ok: true,
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify({ products, pagination: { currentPage: n, totalPages: total } }),
});

function setup(responses: HttpResult[]) {
  const db = makeDb();
  const clock = new ManualClock(START);
  const urls: string[] = [];
  const http: HttpClient = {
    async get(req) {
      urls.push(req.url.toString());
      const r = responses.shift();
      if (!r) throw new Error('rede chamada além do previsto');
      return r;
    },
  };
  const repo = new SqliteCatalogRepo(db);
  const state = createStateRepo(db);
  const circuit = new CircuitStore(state);
  const svc = new CatalogService({ repo, http, state, circuit, runs: createRunRepo(db), clock });
  return { svc, repo, state, circuit, clock, urls };
}

test('T-CAT-02 catálogo vazio: abrir/buscar não chama a rede', () => {
  const { svc, urls } = setup([]); // qualquer get() lançaria
  assert.equal(svc.isEmpty(), true);
  assert.deepEqual(svc.search('era'), []);
  assert.equal(svc.lastRefreshAt(), null);
  assert.equal(urls.length, 0);
});

test('T-CAT-03 atualiza todas as páginas só com category=SAPATOS e conta ignorados (RF-01-AC4)', async () => {
  const { svc, urls, state } = setup([
    page(0, 2, [prod(1), prod(2, { code: undefined })]),
    page(1, 2, [prod(3)]),
  ]);
  const r = await svc.refresh();
  assert.ok(r.ok);
  assert.deepEqual(r.value, { count: 2, skipped: 1 });
  assert.equal(urls.length, 2);
  for (const u of urls) assert.equal(new URL(u).searchParams.get('category'), 'SAPATOS');
  assert.equal(state.get('catalog_last_refresh_at'), START);
  assert.equal(svc.search('tênis 3').length, 1); // busca local pós-atualização
});

test('T-CAT-03 segunda atualização < 24 h é recusada com a data; após 24 h passa', async () => {
  const { svc, clock, urls } = setup([page(0, 1, [prod(1)]), page(0, 1, [prod(1), prod(2)])]);
  assert.ok((await svc.refresh()).ok);
  await clock.advance(23 * 3_600_000);
  const r = await svc.refresh();
  assert.ok(!r.ok);
  assert.deepEqual(r.error, { reason: 'intervalo_minimo', nextAllowedAt: '2026-10-15T12:00:00.000Z' });
  assert.equal(urls.length, 1);
  await clock.advance(3_600_000);
  const r2 = await svc.refresh();
  assert.ok(r2.ok);
  assert.equal(r2.value.count, 2);
});

for (const [failure, status] of [['http_429', 429], ['http_403_ou_desafio', 403]] as const) {
  test(`T-CAT-05 ${status} para, abre o circuito e mantém o catálogo anterior`, async () => {
    const { svc, repo, circuit, clock, state } = setup([
      page(0, 1, [prod(1)]),
      page(0, 2, [prod(9)]), // 1ª página da 2ª tentativa ok
      { ok: false, failure, status },
    ]);
    assert.ok((await svc.refresh()).ok);
    await clock.advance(24 * 3_600_000);
    const r = await svc.refresh();
    assert.ok(!r.ok && r.error.reason === 'falha');
    assert.equal(r.error.failure, failure);
    assert.equal(r.error.circuitOpened, true);
    assert.equal(repo.count(), 1);
    assert.equal(repo.search('tênis 1', 5).length, 1); // anterior intacto
    assert.equal(circuit.status(clock.now().toISOString()).state, 'open');
    assert.equal(state.get('catalog_last_refresh_at'), START);
  });
}

test('T-CAT-05 circuito aberto: recusa sem rede', async () => {
  const { svc, circuit, urls } = setup([]);
  circuit.open('http_429', START);
  const r = await svc.refresh();
  assert.ok(!r.ok && r.error.reason === 'circuito_aberto');
  assert.equal(urls.length, 0);
});

test('T-CAT-05 falha comum (5xx/formato) mantém catálogo, não abre circuito e não consome a janela de 24 h', async () => {
  const { svc, repo, circuit, state, clock } = setup([
    page(0, 1, [prod(1)]),
    { ok: false, failure: 'http_5xx', status: 503 },
    { ok: true, status: 200, contentType: 'application/json', body: 'lixo' },
    page(0, 1, []), // nenhum item válido
  ]);
  assert.ok((await svc.refresh()).ok);
  await clock.advance(24 * 3_600_000);
  for (const failure of ['http_5xx', 'formato_desconhecido', 'formato_desconhecido']) {
    const r = await svc.refresh();
    assert.ok(!r.ok && r.error.reason === 'falha');
    assert.equal(r.error.failure, failure);
    assert.equal(r.error.circuitOpened, false);
  }
  assert.equal(repo.count(), 1);
  assert.equal(circuit.status(clock.now().toISOString()).state, 'closed');
  assert.equal(state.get('catalog_last_refresh_at'), START);
});
