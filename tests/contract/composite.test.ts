import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CompositeSource } from '../../src/price-monitor/composite.source.ts';
import { FakeHttpClient, FakeSource } from '../../src/price-monitor/fake.source.ts';
import { NextDataSource } from '../../src/price-monitor/nextdata.source.ts';
import { OccSource } from '../../src/price-monitor/occ.source.ts';
import type { HttpResult, PriceSource, SourceResult } from '../../src/price-monitor/ports.ts';
import type { FailureClass } from '../../src/shared/types.ts';
import { ManualClock } from '../helpers/clock.ts';
import { fixtureText } from '../helpers/fixtures.ts';

const NOW = '2026-10-14T12:00:00.000Z';
const CODE = '1003800580026U';
const OCC_URL = `https://www.vans.com.br/arezzocoocc/v2/vans/products/${CODE}`;
const HTML_URL = `https://www.vans.com.br/p/${CODE}`;

const occOk: HttpResult = { ok: true, status: 200, body: fixtureText('occ_disc_1003800580026U.json'), contentType: 'application/json' };
const htmlOk: HttpResult = { ok: true, status: 200, body: fixtureText('product_disc_instock_1003800580026U.html'), contentType: 'text/html' };
const httpFail = (failure: FailureClass, status?: number): HttpResult =>
  status === undefined ? { ok: false, failure } : { ok: false, failure, status };

function real(routes: Record<string, HttpResult>) {
  const http = new FakeHttpClient(routes);
  const clock = new ManualClock(NOW);
  return { http, src: new CompositeSource([new OccSource(http, clock), new NextDataSource(http, clock)]) };
}
const failed = (r: SourceResult) => {
  assert.ok(!r.ok);
  return r;
};

test('T-FLH-04 OCC ok: não consulta o fallback, degraded=false, 1 requisição', async () => {
  const { http, src } = real({ [OCC_URL]: occOk });
  const r = await src.fetchProduct(CODE);
  assert.ok(r.ok);
  assert.equal(r.snapshot.source, 'occ');
  assert.equal(r.snapshot.degraded, false);
  assert.equal(r.requests, 1);
  assert.deepEqual(http.urls, [OCC_URL]);
});

for (const [name, res] of [
  ['rede_timeout', httpFail('rede_timeout')],
  ['http_5xx', httpFail('http_5xx', 503)],
  ['formato_desconhecido', { ...occOk, body: '{"code":"outro"}' } as HttpResult],
] as const) {
  test(`T-FLH-04 OCC ${name}: cai para next_data, degraded=true, requisições somadas (2)`, async () => {
    const { http, src } = real({ [OCC_URL]: res, [HTML_URL]: htmlOk });
    const r = await src.fetchProduct(CODE);
    assert.ok(r.ok);
    assert.equal(r.snapshot.source, 'next_data');
    assert.equal(r.snapshot.degraded, true);
    assert.equal(r.requests, 2);
    assert.deepEqual(http.urls, [OCC_URL, HTML_URL]);
  });
}

for (const [name, res] of [
  ['http_403_ou_desafio', httpFail('http_403_ou_desafio', 403)],
  ['http_429', httpFail('http_429', 429)],
  ['host_nao_autorizado', httpFail('host_nao_autorizado')],
  ['produto_removido (OCC 404)', { ok: false, failure: 'formato_desconhecido', status: 404 } as HttpResult],
] as const) {
  test(`T-FLH-04 T-MNT-01 OCC ${name}: nunca cai para o fallback (zero chamadas ao HTML)`, async () => {
    const { http, src } = real({ [OCC_URL]: res }); // HTML_URL ausente: chamar lançaria
    const r = failed(await src.fetchProduct(CODE));
    assert.equal(r.requests, 1);
    assert.deepEqual(http.urls, [OCC_URL]);
    assert.notEqual(r.failure.class, 'formato_desconhecido');
  });
}

test('T-FLH-04 todas falham: devolve a falha da última fonte com requisições somadas', async () => {
  const { src } = real({ [OCC_URL]: httpFail('http_5xx', 502), [HTML_URL]: httpFail('rede_timeout') });
  const r = failed(await src.fetchProduct(CODE));
  assert.equal(r.failure.class, 'rede_timeout');
  assert.equal(r.requests, 2);
});

test('T-FLH-04 fallback devolve 429: para ali e propaga http_429', async () => {
  const { src } = real({ [OCC_URL]: httpFail('rede_timeout'), [HTML_URL]: httpFail('http_429', 429) });
  const r = failed(await src.fetchProduct(CODE));
  assert.equal(r.failure.class, 'http_429');
  assert.equal(r.requests, 2);
});

test('T-MNT-01 composite sem fontes é erro de montagem', () => {
  assert.throws(() => new CompositeSource([]));
});

// RNF-MNT-01: todo coletor cumpre o mesmo contrato PriceSource, sem rede.
const snapshotOf = async () => {
  const r = await new OccSource(new FakeHttpClient({ [OCC_URL]: occOk }), new ManualClock(NOW)).fetchProduct(CODE);
  assert.ok(r.ok);
  return r.snapshot;
};
const impls: [string, () => Promise<PriceSource>][] = [
  ['OccSource', async () => new OccSource(new FakeHttpClient({ [OCC_URL]: occOk }), new ManualClock(NOW))],
  ['NextDataSource', async () => new NextDataSource(new FakeHttpClient({ [HTML_URL]: htmlOk }), new ManualClock(NOW))],
  ['CompositeSource', async () => real({ [OCC_URL]: occOk }).src],
  ['FakeSource', async () => new FakeSource({ [CODE]: await snapshotOf() })],
];
for (const [name, make] of impls) {
  test(`T-MNT-01 ${name} cumpre PriceSource (RF-06-AC6: sem rede)`, async () => {
    const src = await make();
    assert.equal(typeof src.name, 'string');
    const r = await src.fetchProduct(CODE);
    assert.ok(r.ok);
    assert.equal(r.snapshot.code, CODE);
    assert.ok(r.snapshot.variants.length > 0);
    assert.ok(r.requests >= 0 && Number.isInteger(r.httpStatus));
    for (const v of r.snapshot.variants) {
      assert.ok(Number.isInteger(v.currentCents) && Number.isInteger(v.originalCents)); // centavos inteiros
      assert.ok(v.currentCents > 0);
    }
  });
}

test('T-MNT-01 FakeSource: falha programada, fila em ordem e código não programado lança', async () => {
  const fail503: SourceResult = { ok: false, failure: { class: 'http_5xx', httpStatus: 503 }, requests: 1 };
  const fake = new FakeSource({ [CODE]: [fail503, await snapshotOf()] });
  assert.deepEqual(await fake.fetchProduct(CODE), fail503);
  assert.ok((await fake.fetchProduct(CODE)).ok);
  assert.ok((await fake.fetchProduct(CODE)).ok); // último se repete
  assert.deepEqual(fake.calls, [CODE, CODE, CODE]);
  await assert.rejects(fake.fetchProduct('X'));
});

test('T-MNT-01 FakeHttpClient sem rotas falha se chamado', async () => {
  await assert.rejects(new FakeHttpClient().get({ url: new URL(HTML_URL), accept: 'html' }));
});
