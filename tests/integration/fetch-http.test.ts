import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ManualClock } from '../helpers/clock.ts';
import { FetchHttpClient } from '../../src/price-monitor/http/fetch-http.ts';
import { MAX_BODY_BYTES } from '../../src/price-monitor/http/outbound-url.ts';

const PROD = new URL('https://www.vans.com.br/arezzocoocc/v2/vans/products/1003800580026U');
type Call = { url: string; init: RequestInit };

function setup(make: () => Response) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return make();
  }) as unknown as typeof fetch;
  const clock = new ManualClock('2026-10-14T12:00:00.000Z');
  return { calls, http: new FetchHttpClient({ fetch: f, clock }) };
}
const json = (body: string, init: ResponseInit = {}) =>
  new Response(body, { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, ...init });

test('T-HTTP-01 200 json: credentials omit, redirect manual, sem cookie/authorization', async () => {
  const { http, calls } = setup(() => json('{"a":1}'));
  const r = await http.get({ url: PROD, accept: 'json', headers: { Cookie: 'x=1', Authorization: 'b', 'x-ok': '1' } });
  assert.deepEqual(r, { ok: true, status: 200, body: '{"a":1}', contentType: 'application/json; charset=utf-8' });
  const init = calls[0]!.init;
  assert.equal(init.credentials, 'omit');
  assert.equal(init.redirect, 'manual');
  assert.equal(init.referrerPolicy, 'no-referrer');
  const h = init.headers as Record<string, string>;
  assert.deepEqual(Object.keys(h).sort(), ['accept', 'x-ok']);
  assert.equal(h.accept, 'application/json');
});

test('T-SEC-01 URL fora da allowlist nunca chama fetch', async () => {
  const { http, calls } = setup(() => json('{}'));
  for (const u of ['https://evil.com/p/1003800580026U', 'https://www.vans.com.br/carrinho'])
    assert.deepEqual(await http.get({ url: new URL(u), accept: 'html' }), { ok: false, failure: 'host_nao_autorizado' });
  assert.equal(calls.length, 0);
});

test('T-SEC-02 3xx e opaqueredirect = host_nao_autorizado, sem seguir', async () => {
  const a = setup(() => new Response(null, { status: 302, headers: { location: 'https://evil.com/' } }));
  assert.deepEqual(await a.http.get({ url: PROD, accept: 'json' }), { ok: false, failure: 'host_nao_autorizado', status: 302 });
  assert.equal(a.calls.length, 1);
  const r = json('');
  Object.defineProperty(r, 'type', { value: 'opaqueredirect' });
  const b = setup(() => r);
  const res = await b.http.get({ url: PROD, accept: 'json' });
  assert.ok(!res.ok && res.failure === 'host_nao_autorizado');
});

test('T-HTTP-02 mapeia status: 429, 403, 5xx, 404 e Retry-After', async () => {
  const cases: [number, string][] = [[429, 'http_429'], [403, 'http_403_ou_desafio'], [503, 'http_5xx'], [404, 'formato_desconhecido']];
  for (const [status, failure] of cases) {
    const { http } = setup(() => new Response('corpo', { status, headers: { 'retry-after': '120' } }));
    assert.deepEqual(await http.get({ url: PROD, accept: 'json' }), { ok: false, failure, status, body: 'corpo', retryAfterMs: 120_000 });
  }
  const { http } = setup(() => new Response('', { status: 429, headers: { 'retry-after': 'Wed, 14 Oct 2026 12:01:00 GMT' } }));
  const r = await http.get({ url: PROD, accept: 'json' });
  assert.equal(!r.ok && r.retryAfterMs, 60_000);
});

test('T-HTTP-02 cf-mitigated vence o status (200, 404, 503)', async () => {
  for (const status of [200, 404, 503]) {
    const { http } = setup(() => new Response('<html>challenge</html>', { status, headers: { 'cf-mitigated': 'challenge', 'content-type': 'text/html' } }));
    const r = await http.get({ url: PROD, accept: 'html' });
    assert.equal(!r.ok && r.failure, 'http_403_ou_desafio');
  }
});

test('T-HTTP-03 tipo de conteúdo fora de json/html = formato_desconhecido', async () => {
  const { http } = setup(() => new Response('x', { status: 200, headers: { 'content-type': 'image/png' } }));
  assert.deepEqual(await http.get({ url: PROD, accept: 'json' }), { ok: false, failure: 'formato_desconhecido', status: 200 });
  const h = setup(() => new Response('<p>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }));
  assert.equal((await h.http.get({ url: PROD, accept: 'html' })).ok, true);
});

test('T-HTTP-04 corpo acima de 2 MB: 200 falha, erro trunca', async () => {
  const big = 'a'.repeat(MAX_BODY_BYTES + 10);
  const over = setup(() => json(big));
  assert.deepEqual(await over.http.get({ url: PROD, accept: 'json' }), { ok: false, failure: 'formato_desconhecido' });
  const exact = setup(() => json('a'.repeat(MAX_BODY_BYTES)));
  assert.equal((await exact.http.get({ url: PROD, accept: 'json' })).ok, true);
  const er = setup(() => new Response(big, { status: 500 }));
  const r = await er.http.get({ url: PROD, accept: 'json' });
  assert.ok(!r.ok && r.failure === 'http_5xx' && r.body!.length <= MAX_BODY_BYTES);
});

test('T-HTTP-05 timeout aborta e vira rede_timeout; erro de rede idem', async () => {
  const slow = new FetchHttpClient({
    timeoutMs: 20,
    fetch: ((_u: string, init: RequestInit) =>
      new Promise((_res, rej) => init.signal!.addEventListener('abort', () => rej(new Error('abort'))))) as unknown as typeof fetch,
  });
  assert.deepEqual(await slow.get({ url: PROD, accept: 'json' }), { ok: false, failure: 'rede_timeout' });
  const down = new FetchHttpClient({ fetch: (() => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch });
  assert.deepEqual(await down.get({ url: PROD, accept: 'json' }), { ok: false, failure: 'rede_timeout' });
});
