import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureText } from '../helpers/fixtures.ts';
import { parseListing } from '../../src/catalog/catalog.parser.ts';
import { fetchCatalog } from '../../src/catalog/catalog.source.ts';
import type { HttpClient, HttpResult } from '../../src/price-monitor/ports.ts';

const page0 = fixtureText('search.sapatos.page0.sample.json');
const tweak = (fn: (j: any) => void): string => {
  const j = JSON.parse(page0);
  fn(j);
  return JSON.stringify(j);
};
const parse = (raw: string) => {
  const r = parseListing(raw);
  assert.ok(r.ok);
  return r.value;
};

test('T-CAT-01 parser lê fixture real: code, nome, slug, centavos; stock {} não quebra', () => {
  const l = parse(page0);
  assert.equal(l.items.length, 3);
  assert.equal(l.skipped, 0);
  assert.deepEqual(l.items[0], {
    code: '1003551190001U',
    name: 'Harbor Mule Vr3 Black',
    lastSlug: 'harbor-mule-vr3-black',
    priceCents: 54999,
  });
  assert.equal(l.totalPages, 52);
});

test('T-CAT-04 item sem code, sem preço ou com preço inválido é ignorado e contado', () => {
  const l = parse(
    tweak((j) => {
      delete j.products[0].code;
      delete j.products[1].price;
      j.products[2].price.value = 0;
      j.products.push(null, { code: 'X', name: 'curto', price: { value: 1 } });
    }),
  );
  assert.equal(l.items.length, 0);
  assert.equal(l.skipped, 5);
});

test('T-CAT-04 preço não decimal de 2 casas nunca vira preço', () => {
  const l = parse(tweak((j) => (j.products[0].price.value = 10.005)));
  assert.equal(l.items.length, 2);
  assert.equal(l.skipped, 1);
});

test('T-CAT-06 identidade é o code; slug vem da url mas é opcional', () => {
  const l = parse(tweak((j) => (j.products[0].url = '/algo-estranho')));
  assert.equal(l.items[0]!.code, '1003551190001U');
  assert.equal(l.items[0]!.lastSlug, null);
});

test('T-CAT-01 corpo fora do formato é formato_desconhecido', () => {
  for (const raw of ['', '<html>', '{}', '[]', tweak((j) => delete j.pagination)]) {
    assert.deepEqual(parseListing(raw), { ok: false, error: 'formato_desconhecido' });
  }
});

test('T-CAT-01 source percorre páginas 0-based e nenhuma URL tem query=:/q=//search*', async () => {
  const urls: URL[] = [];
  const http: HttpClient = {
    async get({ url }) {
      urls.push(url);
      const p = Number(url.searchParams.get('currentPage'));
      const body = tweak((j) => {
        j.pagination.currentPage = p;
        j.pagination.totalPages = 3;
      });
      return { ok: true, status: 200, body, contentType: 'application/json' };
    },
  };
  const r = await fetchCatalog(http);
  assert.ok(r.ok);
  assert.deepEqual(urls.map((u) => u.searchParams.get('currentPage')), ['0', '1', '2']);
  assert.equal(r.value.items.length, 3); // mesmos 3 codes em cada página: deduplicado
  for (const u of urls) {
    assert.equal(u.searchParams.get('category'), 'SAPATOS');
    assert.equal(u.searchParams.get('pageSize'), '24');
    assert.equal(u.searchParams.has('query'), false);
    assert.equal(u.searchParams.has('q'), false);
    assert.doesNotMatch(u.pathname, /\/search\/|\/search\*/);
    assert.doesNotMatch(u.href, /query=:|[?&]q=/);
    assert.equal(u.hostname, 'www.vans.com.br');
  }
});

test('T-CAT-05 falha numa página aborta e devolve a classe (sem itens parciais)', async () => {
  let n = 0;
  const http: HttpClient = {
    async get() {
      const res: HttpResult =
        n++ === 0
          ? { ok: true, status: 200, body: tweak((j) => (j.pagination.totalPages = 5)), contentType: 'application/json' }
          : { ok: false, failure: 'http_429', status: 429, retryAfterMs: 60_000 };
      return res;
    },
  };
  const r = await fetchCatalog(http);
  assert.deepEqual(r, { ok: false, error: { failure: 'http_429', httpStatus: 429, retryAfterMs: 60_000 } });
  assert.equal(n, 2);
});
