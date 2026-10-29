import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OccSource } from '../../src/price-monitor/occ.source.ts';
import { effectivePrice, isAvailable } from '../../src/price-monitor/normalize.ts';
import type { HttpClient, HttpResult, SourceResult } from '../../src/price-monitor/ports.ts';
import { ManualClock } from '../helpers/clock.ts';
import {
  fixture,
  fixtureText,
  withBadPrice,
  withDiscountAbovePrice,
  withPriceVariations,
  withoutBaseOptions,
  withZeroPrice,
} from '../helpers/fixtures.ts';

const NOW = '2026-10-14T12:00:00.000Z';
const HYLANE = '1003800580026U';
const HYLANE_FIXTURE = 'occ_disc_1003800580026U.json';

class StubHttp implements HttpClient {
  urls: string[] = [];
  readonly res: HttpResult;
  constructor(res: HttpResult) {
    this.res = res;
  }
  async get(req: { url: URL }): Promise<HttpResult> {
    this.urls.push(req.url.href);
    return this.res;
  }
}
const okJson = (body: unknown): HttpResult => ({
  ok: true,
  status: 200,
  body: typeof body === 'string' ? body : JSON.stringify(body),
  contentType: 'application/json',
});
const run = (res: HttpResult, code = HYLANE): Promise<SourceResult> =>
  new OccSource(new StubHttp(res), new ManualClock(NOW)).fetchProduct(code);
const snap = async (body: unknown, code = HYLANE) => {
  const r = await run(okJson(body), code);
  assert.ok(r.ok, JSON.stringify(r));
  return r.snapshot;
};
const fail = async (res: HttpResult, code = HYLANE) => {
  const r = await run(res, code);
  assert.ok(!r.ok);
  return r.failure;
};
const hylane = () => fixture(HYLANE_FIXTURE);

test('T-IDN-01 parse OCC Hylane: produto, 13 variantes, legacySKU, ean, fonte occ', async () => {
  const stub = new StubHttp(okJson(fixtureText(HYLANE_FIXTURE)));
  const r = await new OccSource(stub, new ManualClock(NOW)).fetchProduct(HYLANE);
  assert.equal(stub.urls[0], `https://www.vans.com.br/arezzocoocc/v2/vans/products/${HYLANE}`);
  assert.ok(r.ok);
  assert.equal(r.requests, 1);
  assert.equal(r.httpStatus, 200);
  const s = r.snapshot;
  assert.equal(s.code, HYLANE);
  assert.equal(s.legacySku, 'V1003800580026');
  assert.equal(s.slug, 'tenis-hylane-2-tone-khaki-green');
  assert.equal(s.source, 'occ');
  assert.equal(s.degraded, false);
  assert.equal(s.fetchedAt, NOW);
  assert.equal(s.skippedVariants, 0);
  assert.deepEqual(
    s.variants.map((v) => v.variantCode),
    Array.from({ length: 13 }, (_, i) => `${HYLANE}-${33 + i}`),
  );
  assert.equal(s.variants[0]!.ean, '197804439188');
});

test('T-RN-02 preço efetivo: Hylane 37999/64999, Era True White 14999, Knu 69999 sem desconto', async () => {
  const h = await snap(hylane());
  assert.ok(h.variants.every((v) => v.currentCents === 37999 && v.originalCents === 64999));
  const w = await snap(fixture('occ_white_1002000690063U.json'), '1002000690063U');
  assert.ok(w.variants.every((v) => v.currentCents === 14999 && v.originalCents === 29999));
  const k = await snap(fixture('occ_nodisc_1002002760052U.json'), '1002002760052U');
  assert.ok(k.variants.every((v) => v.currentCents === 69999 && v.originalCents === 69999));
});

test('T-RN-02 Era Navy: ruído de float 99.99000000000001 vira 9999', async () => {
  const n = await snap(fixture('occ_1002000690002U.json'), '1002000690002U');
  assert.ok(n.variants.every((v) => v.currentCents === 9999 && v.originalCents === 27999));
});

test('T-IDN-03 Hylane: 33-36 disponíveis, 37-45 não (13 variantes)', async () => {
  const s = await snap(hylane());
  assert.equal(s.variants.length, 13);
  for (const v of s.variants) {
    const size = Number(v.size);
    assert.equal(v.variantCode, `${HYLANE}-${v.size}`);
    assert.equal(v.available, size >= 33 && size <= 36, v.size);
  }
});

test('T-RN-06 Era True White: indisponível mantém preço (available=false)', async () => {
  const s = await snap(fixture('occ_white_1002000690063U.json'), '1002000690063U');
  assert.ok(s.variants.length > 0 && s.variants.every((v) => !v.available && v.currentCents === 14999));
});

test('T-RN-05 disponível = sellable && stockLevel>0; lowStock com nível 0 é indisponível', async () => {
  assert.equal(isAvailable({ sellable: true, stock: { stockLevel: 5 } }), true);
  assert.equal(isAvailable({ sellable: true, stock: { stockLevel: 0, stockLevelStatus: 'lowStock' } }), false);
  assert.equal(isAvailable({ sellable: false, stock: { stockLevel: 9 }, purchasable: true }), false);
  assert.equal(isAvailable({ sellable: true }), false);
  const k = await snap(fixture('occ_nodisc_1002002760052U.json'), '1002002760052U');
  assert.equal(k.variants.find((v) => v.size === '33')!.available, false);
  const o = hylane();
  const last = o.baseOptions[0].options.at(-1);
  last.sellable = true;
  last.stock = { stockLevel: 0, stockLevelStatus: 'lowStock' };
  assert.equal((await snap(o)).variants.at(-1)!.available, false);
});

test('T-RN-04 variante usa o próprio preço; sem priceData usa o do produto; hasPriceVariations não muda nada', async () => {
  const o = hylane();
  const opts = o.baseOptions[0].options;
  opts[0].priceData = { value: 500 };
  opts[0].discountPrice = { value: 400 };
  delete opts[1].priceData;
  delete opts[1].discountPrice;
  const s = await snap(o);
  assert.deepEqual([s.variants[0]!.originalCents, s.variants[0]!.currentCents], [50000, 40000]);
  assert.deepEqual([s.variants[1]!.originalCents, s.variants[1]!.currentCents], [64999, 37999]);
  const hpv = await snap(withPriceVariations(hylane()));
  assert.equal(hpv.variants.length, 13);
  assert.equal(hpv.variants[0]!.currentCents, 37999);
});

test('T-RN-03 desconto == preço é válido; value 0 ou ausente = sem desconto; negativo/texto inválido', () => {
  const eff = (d: unknown) => effectivePrice({ value: 100 }, d);
  const same = { ok: true, value: { originalCents: 10000, currentCents: 10000 } };
  assert.deepEqual(eff({ value: 100 }), same);
  assert.deepEqual(eff({ value: 0, currencyIso: '' }), same);
  assert.deepEqual(eff(undefined), same);
  assert.deepEqual(eff({ value: -5 }), { ok: false, error: 'preco_invalido' });
  assert.deepEqual(eff({ value: 'x' }), { ok: false, error: 'preco_invalido' });
});

test('T-RN-03 preço inválido (discountPrice>price, 0, NaN, texto): nunca vira preço', async () => {
  for (const bad of [
    withDiscountAbovePrice(hylane()),
    withZeroPrice(hylane()),
    withBadPrice(hylane(), NaN),
    withBadPrice(hylane(), '12,34'),
    withBadPrice(hylane(), 1.005),
  ]) {
    assert.equal((await fail(okJson(bad))).class, 'preco_invalido');
  }
});

test('T-RN-03 uma variante inválida: demais gravadas, inválida contada em skippedVariants', async () => {
  const o = hylane();
  o.baseOptions[0].options[3].priceData = { value: 100 };
  o.baseOptions[0].options[3].discountPrice = { value: 200 };
  const s = await snap(o);
  assert.equal(s.variants.length, 12);
  assert.equal(s.skippedVariants, 1);
  assert.ok(!s.variants.some((v) => v.variantCode === `${HYLANE}-36`));
  assert.ok(s.variants.every((v) => v.currentCents > 0 && v.currentCents <= v.originalCents));
});

test('T-RN-03 sem preço no produto nem nas variantes: preco_invalido', async () => {
  const o = hylane();
  delete o.price;
  for (const v of o.baseOptions[0].options) delete v.priceData;
  assert.equal((await fail(okJson(o))).class, 'preco_invalido');
});

test('T-FLH-14 occ_404.json (400 UnknownIdentifierError) vira produto_removido', async () => {
  const f = await fail({ ok: false, failure: 'formato_desconhecido', status: 400, body: fixtureText('occ_404.json') });
  assert.equal(f.class, 'produto_removido');
  assert.equal(f.httpStatus, 400);
  assert.equal(f.rawBody, undefined);
  const html404 = { ok: false, failure: 'formato_desconhecido', status: 404, body: '<html>' } as const;
  assert.equal((await fail(html404)).class, 'produto_removido');
});

test('T-FLH-14 400 sem UnknownIdentifierError e 3xx continuam formato_desconhecido', async () => {
  const other = { ok: false, failure: 'formato_desconhecido', status: 400, body: '{"errors":[{"type":"Other"}]}' } as const;
  assert.equal((await fail(other)).class, 'formato_desconhecido');
  const redirect = { ok: false, failure: 'formato_desconhecido', status: 302 } as const;
  assert.equal((await fail(redirect)).class, 'formato_desconhecido');
});

test('T-FLH-14 falhas HTTP passam com classe, status e retryAfter; requests=1', async () => {
  const r = await run({ ok: false, failure: 'http_429', status: 429, retryAfterMs: 30000 });
  assert.ok(!r.ok);
  assert.equal(r.requests, 1);
  assert.deepEqual(r.failure, { class: 'http_429', httpStatus: 429, retryAfterMs: 30000 });
  assert.equal((await fail({ ok: false, failure: 'rede_timeout' })).class, 'rede_timeout');
  assert.equal((await fail({ ok: false, failure: 'http_403_ou_desafio', status: 403 })).class, 'http_403_ou_desafio');
});

test('T-IDN-05 sem baseOptions[0].options, lista vazia ou JSON inválido: formato_desconhecido', async () => {
  const f = await fail(okJson(withoutBaseOptions(hylane())));
  assert.equal(f.class, 'formato_desconhecido');
  assert.ok(f.rawBody);
  const empty = hylane();
  empty.baseOptions[0].options = [];
  assert.equal((await fail(okJson(empty))).class, 'formato_desconhecido');
  for (const body of ['<html>não é json', '[]', '{}']) {
    assert.equal((await fail(okJson(body))).class, 'formato_desconhecido', body);
  }
});

test('T-FLH-14 code da resposta divergente ou variante fora do produto: formato_desconhecido', async () => {
  const a = hylane();
  a.code = '1003800580099U';
  assert.equal((await fail(okJson(a))).class, 'formato_desconhecido');
  const b = hylane();
  b.baseOptions[0].options[0].code = 'OUTRO123456U-33';
  assert.equal((await fail(okJson(b))).class, 'formato_desconhecido');
});

test('T-FLH-14 stockLevel ausente = variante indisponível, sem erro', async () => {
  const o = hylane();
  delete o.baseOptions[0].options[0].stock;
  const s = await snap(o);
  assert.equal(s.variants[0]!.available, false);
  assert.equal(s.variants.length, 13);
});

test('T-IDN-06 T-RN-16 identidade pelo code: slug errado/ausente é decorativo; cor irmã é outro code', async () => {
  const o = hylane();
  o.url = '/slug-qualquer-errado/p/1003800580026U';
  const s = await snap(o);
  assert.equal(s.code, HYLANE);
  assert.ok(s.variants.every((v) => v.variantCode.startsWith(`${HYLANE}-`)));
  assert.ok(Array.isArray(o.colorOptions) && o.colorOptions.length > 0);
  assert.equal((await fail(okJson(o), '1003800580033U')).class, 'formato_desconhecido');
  delete o.url;
  assert.equal((await snap(o)).slug, null);
});
