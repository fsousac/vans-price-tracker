import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NextDataSource } from '../../src/price-monitor/nextdata.source.ts';
import { OccSource } from '../../src/price-monitor/occ.source.ts';
import type { HttpClient, HttpResult, SourceResult } from '../../src/price-monitor/ports.ts';
import { ManualClock } from '../helpers/clock.ts';
import { fixture, fixtureText } from '../helpers/fixtures.ts';

const NOW = '2026-10-14T12:00:00.000Z';
const HYLANE = '1003800580026U';
const WHITE = '1002000690063U';

class StubHttp implements HttpClient {
  reqs: { url: string; accept: string }[] = [];
  readonly res: HttpResult;
  constructor(res: HttpResult) {
    this.res = res;
  }
  async get(req: { url: URL; accept: 'json' | 'html' }): Promise<HttpResult> {
    this.reqs.push({ url: req.url.href, accept: req.accept });
    return this.res;
  }
}
const okHtml = (body: string): HttpResult => ({ ok: true, status: 200, body, contentType: 'text/html' });
const page = (data: unknown) =>
  `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></body></html>`;
const product = (code: string) => fixture(`nextdata_${code}.json`).pageProps.product; // fresh copy each call
const wrap = (p: unknown) => ({ props: { pageProps: { product: p } } });
const run = (res: HttpResult, code = HYLANE): Promise<SourceResult> =>
  new NextDataSource(new StubHttp(res), new ManualClock(NOW)).fetchProduct(code);
const snap = async (html: string, code = HYLANE) => {
  const r = await run(okHtml(html), code);
  assert.ok(r.ok, JSON.stringify(r));
  return r.snapshot;
};
const fail = async (res: HttpResult, code = HYLANE) => {
  const r = await run(res, code);
  assert.ok(!r.ok);
  return r.failure;
};

test('T-IDN-02 HTML real: tamanho por displayText (url vazia), 13 variantes, degraded, fonte next_data', async () => {
  const stub = new StubHttp(okHtml(fixtureText('product_disc_instock_1003800580026U.html')));
  const r = await new NextDataSource(stub, new ManualClock(NOW)).fetchProduct(HYLANE);
  assert.deepEqual(stub.reqs, [{ url: `https://www.vans.com.br/p/${HYLANE}`, accept: 'html' }]);
  assert.ok(r.ok);
  assert.equal(r.requests, 1);
  assert.equal(r.httpStatus, 200);
  const s = r.snapshot;
  assert.equal(s.source, 'next_data');
  assert.equal(s.degraded, true);
  assert.equal(s.fetchedAt, NOW);
  assert.equal(s.legacySku, 'V1003800580026');
  assert.equal(s.slug, 'tenis-hylane-2-tone-khaki-green');
  assert.deepEqual(
    s.variants.map((v) => [v.variantCode, v.size]),
    Array.from({ length: 13 }, (_, i) => [`${HYLANE}-${33 + i}`, String(33 + i)]),
  );
  assert.equal(s.skippedVariants, 0);
});

test('T-IDN-02 tamanho ignora url da variante: displayText ausente cai no sufixo do code', async () => {
  const p = product(HYLANE);
  p.variantOptions[0].url = '/tenis/p/QUALQUER-99';
  delete p.variantOptions[1].displayText;
  const s = await snap(page(wrap(p)));
  assert.equal(s.variants[0]!.size, '33');
  assert.equal(s.variants[1]!.size, '34');
});

test('T-MON-07 concordância SSR x OCC nas fixtures (preços, disponibilidade, tamanhos)', async () => {
  for (const [code, occ] of [
    [HYLANE, `occ_disc_${HYLANE}.json`],
    [WHITE, `occ_white_${WHITE}.json`],
  ] as const) {
    const a = await snap(page(wrap(product(code))), code);
    const o = await new OccSource(
      new StubHttp({ ok: true, status: 200, body: fixtureText(occ), contentType: 'application/json' }),
      new ManualClock(NOW),
    ).fetchProduct(code);
    assert.ok(o.ok);
    const noEan = (vs: typeof a.variants) => vs.map(({ ean: _e, ...v }) => v); // SSR não traz EAN
    assert.deepEqual(noEan(a.variants), noEan(o.snapshot.variants), code);
    assert.equal(a.name, o.snapshot.name);
    assert.equal(a.degraded, true);
    assert.equal(o.snapshot.degraded, false);
  }
  const h = await snap(page(wrap(product(HYLANE))));
  assert.ok(h.variants.every((v) => v.originalCents === 64999 && v.currentCents === 37999));
});

test('T-MON-07 produto esgotado: HTML OOS mantém preço 149,99 e available=false', async () => {
  const s = await snap(fixtureText('product_disc_oos_1002000690063U.html'), WHITE);
  assert.ok(s.variants.length > 0);
  assert.ok(s.variants.every((v) => !v.available && v.currentCents === 14999));
});

test('T-IDN-02 percentualOfDiscount="" ignorado; sem desconto (value 0) = preço atual igual ao original', async () => {
  assert.equal(product(HYLANE).percentualOfDiscount, '');
  const s = await snap(fixtureText('product_nodisc_instock_1002002760052U.html'), '1002002760052U');
  assert.ok(s.variants.every((v) => v.currentCents === v.originalCents && v.currentCents > 0));
});

test('RN-03 preço inválido nunca vira preço: desconto > preço, texto, zero, negativo = preco_invalido', async () => {
  for (const bad of [
    { price: 100, disc: 200 },
    { price: 'x', disc: 0 },
    { price: 0, disc: 0 },
    { price: -1, disc: 0 },
  ]) {
    const p = product(HYLANE);
    for (const v of p.variantOptions) {
      v.priceData = { value: bad.price };
      v.discountPrice = { value: bad.disc };
    }
    assert.equal((await fail(okHtml(page(wrap(p))))).class, 'preco_invalido', JSON.stringify(bad));
  }
});

test('T-IDN-05 sem __NEXT_DATA__, JSON quebrado, sem product ou sem variantOptions: formato_desconhecido com rawBody', async () => {
  const cases = [
    '<html>sem script</html>',
    '<script id="__NEXT_DATA__" type="application/json">{quebrado</script>',
    '<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{}}}</script>',
    page(wrap({ ...product(HYLANE), variantOptions: [] })),
    fixtureText('product_404.html'),
  ];
  for (const html of cases) {
    const f = await fail(okHtml(html));
    assert.equal(f.class, 'formato_desconhecido');
    assert.equal(f.rawBody, html);
  }
});

test('T-FLH-14 code divergente ou variante fora do produto: formato_desconhecido', async () => {
  const html = page(wrap(product(HYLANE)));
  assert.equal((await fail(okHtml(html), '1003800580033U')).class, 'formato_desconhecido');
  const p = product(HYLANE);
  p.variantOptions[0].code = 'OUTRO123456U-33';
  assert.equal((await fail(okHtml(page(wrap(p))))).class, 'formato_desconhecido');
});

test('T-FLH-14 falhas HTTP: 404 = produto_removido sem rawBody; demais passam com classe/status/retryAfter', async () => {
  const gone = await fail({ ok: false, failure: 'formato_desconhecido', status: 404, body: '<html>' });
  assert.deepEqual(gone, { class: 'produto_removido', httpStatus: 404 });
  const redirect = await fail({ ok: false, failure: 'formato_desconhecido', status: 302 });
  assert.equal(redirect.class, 'formato_desconhecido');
  const r = await run({ ok: false, failure: 'http_429', status: 429, retryAfterMs: 30000 });
  assert.ok(!r.ok);
  assert.equal(r.requests, 1);
  assert.deepEqual(r.failure, { class: 'http_429', httpStatus: 429, retryAfterMs: 30000 });
  assert.equal((await fail({ ok: false, failure: 'rede_timeout' })).class, 'rede_timeout');
  assert.equal((await fail({ ok: false, failure: 'http_403_ou_desafio', status: 403 })).class, 'http_403_ou_desafio');
});
