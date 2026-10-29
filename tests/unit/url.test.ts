import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractProductCode } from '../../src/price-monitor/url.ts';

const CODE = '1003800580026U';
const code = (u: string) => {
  const r = extractProductCode(u);
  return r.ok ? r.value : r.error.reason;
};

test('T-URL-01 URL com slug, sem slug, slug errado e porta 443 extraem o code', () => {
  assert.equal(code(`https://www.vans.com.br/tenis-hylane-2-tone-khaki-green/p/${CODE}`), CODE);
  assert.equal(code(`https://www.vans.com.br/p/${CODE}`), CODE);
  assert.equal(code(`https://www.vans.com.br/outro-produto-qualquer/p/${CODE}`), CODE);
  assert.equal(code(`  https://WWW.vans.com.br:443/p/${CODE}  `), CODE);
});

test('T-URL-05 query e fragmento (fbclid, UTM) são descartados e não vazam no resultado', () => {
  const r = extractProductCode(`https://www.vans.com.br/x/p/${CODE}?utm_source=fb&fbclid=AbC#frag`);
  assert.deepEqual(r, { ok: true, value: CODE });
});

test('T-URL-03 URL de variante (sufixo de tamanho) é "produto não encontrado"', () => {
  assert.equal(code(`https://www.vans.com.br/x/p/${CODE}-40`), 'produto_nao_encontrado');
  assert.equal(code(`https://www.vans.com.br/p/${CODE}-40`), 'produto_nao_encontrado');
});

test('T-URL-02 code fora de 8-20 alfanuméricos é rejeitado', () => {
  assert.equal(code('https://www.vans.com.br/p/ABC1234'), 'url_invalida');
  assert.equal(code(`https://www.vans.com.br/p/${'A'.repeat(21)}`), 'url_invalida');
});
