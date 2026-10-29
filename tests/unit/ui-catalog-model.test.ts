import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkUrl, errorText, parseInspect, parseSearch, refreshState, storeUrl, UNSUPPORTED } from '../../src/ext/ui/options/catalog-model.ts';

const NOW = Date.parse('2026-10-15T12:00:00Z');

test('T-CAT-02 RF-01 atualizar: nunca feito libera; < 24 h bloqueia com data; >= 24 h libera', () => {
  assert.deepEqual(refreshState(null, NOW), { allowed: true, nextAt: null });
  assert.deepEqual(refreshState('lixo', NOW), { allowed: true, nextAt: null });
  assert.deepEqual(refreshState('2026-10-15T00:00:00Z', NOW), { allowed: false, nextAt: '2026-10-16T00:00:00.000Z' });
  assert.equal(refreshState('2026-10-14T12:00:00Z', NOW).allowed, true);
});

test('T-CAT-01 busca: descarta item sem code/nome, preço inválido vira null', () => {
  const r = parseSearch({
    refreshedAt: '2026-10-15T00:00:00Z',
    items: [{ code: '1003800580026U', name: 'Era', lastSlug: 'tenis-era', priceCents: 29999 },
      { name: 'sem code' }, { code: 'curto', name: 'x' }, { code: '1003800580027U', name: 'Old', priceCents: -1 }],
  });
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[1]!.priceCents, null);
  assert.deepEqual(parseSearch(42), { rows: [], refreshedAt: null });
});

test('RF-01 link da loja montado do code; slug hostil é ignorado; code inválido sem link', () => {
  assert.equal(storeUrl('1003800580026U', 'tenis-era'), 'https://www.vans.com.br/tenis-era/p/1003800580026U');
  assert.equal(storeUrl('1003800580026U', '../x"><'), 'https://www.vans.com.br/p/1003800580026U');
  assert.equal(storeUrl('x"onmouseover=1'), null);
});

test('T-URL RF-02 URL hostil: mensagem e nenhum code (nada vai à rede)', () => {
  for (const u of ['http://www.vans.com.br/p/1003800580026U', 'https://evil.com/p/1003800580026U',
    'https://www.vans.com.br@evil.com/p/1003800580026U', 'javascript:alert(1)', 'https://www.vans.com.br/%2e%2e/p/1003800580026U', ''])
    assert.equal(checkUrl(u).ok, false, u);
  assert.deepEqual(checkUrl('https://www.vans.com.br/tenis/p/1003800580026U?x=1'), { ok: true, code: '1003800580026U' });
});

test('T-URL formato_desconhecido explica "ainda não suportado"; sem estoque numérico', () => {
  const r = parseInspect({ product: { code: '1003800580026U', name: 'X', state: 'formato_desconhecido' }, variants: [] });
  assert.deepEqual(r, { ok: false, message: UNSUPPORTED });
  assert.match(UNSUPPORTED, /ainda não é suportado/);
  assert.match(errorText({ code: 'falha_externa', message: 'formato_desconhecido' }), /ainda não/);
  const ok = parseInspect({ code: '1003800580026U', name: 'Era', variants: [{ code: '1003800580026U-34', size: '34', available: true, stock: 7 }] });
  assert.ok(ok.ok);
  if (ok.ok) assert.deepEqual(ok.value.variants[0], { code: '1003800580026U-34', size: '34', available: true });
  assert.equal(parseInspect({ code: '1003800580026U', name: 'Era', variants: [] }).ok, false);
});
