import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALLOWED_HOSTS, MAX_BODY_BYTES, validateOutboundRequest, validateOutboundUrl } from '../../src/price-monitor/http/outbound-url.ts';
import * as safe from '../../src/price-monitor/http/safe-http.ts';

const B = 'https://www.vans.com.br';

test('T-SEC-01 allowlist de host: só www.vans.com.br https 443 sem credencial', () => {
  assert.deepEqual([...ALLOWED_HOSTS], ['www.vans.com.br']);
  assert.equal(validateOutboundUrl(new URL(`${B}/x`)), true);
  for (const u of ['http://www.vans.com.br/x', 'https://vans.com.br/x', 'https://www.vans.com.br.evil.com/x',
    'https://www.vans.com.br:8443/x', 'https://u:p@www.vans.com.br/x', 'https://evil.com/p/1003800580026U'])
    assert.equal(validateOutboundUrl(new URL(u)), false, u);
});

test('T-SEC-01 allowlist de caminho: OCC por code, listagem SAPATOS, página de produto', () => {
  for (const ok of [
    '/arezzocoocc/v2/vans/products/1003800580026U', '/arezzocoocc/v2/vans/products/1003800580026U?fields=FULL',
    '/arezzocoocc/v2/vans/products/search?category=SAPATOS&currentPage=0&pageSize=24',
    '/p/1003800580026U', '/tenis-old-skool/p/1003800580026U',
  ]) assert.equal(validateOutboundRequest(new URL(B + ok)), true, ok);
  for (const bad of [
    '/', '/carrinho', '/checkout', '/arezzocoocc/v2/vans/users/current', '/arezzocoocc/v2/vans/products/search',
    '/arezzocoocc/v2/vans/products/search?category=OUTRA', '/arezzocoocc/v2/vans/products/abc',
    '/arezzocoocc/v2/vans/products/1003800580026U/reviews', '/a/b/p/1003800580026U',
    '/arezzocoocc/v2/vans/products/../users/current',
  ]) assert.equal(validateOutboundRequest(new URL(B + bad)), false, bad);
  assert.equal(validateOutboundRequest(new URL('https://evil.com/p/1003800580026U')), false);
});

test('T-SEC-01 safe-http reexporta o trecho puro', () => {
  assert.equal(safe.validateOutboundUrl, validateOutboundUrl);
  assert.equal(safe.MAX_BODY_BYTES, MAX_BODY_BYTES);
  assert.equal(safe.ALLOWED_HOSTS, ALLOWED_HOSTS);
});
