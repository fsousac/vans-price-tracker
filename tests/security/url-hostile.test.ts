import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractProductCode } from '../../src/price-monitor/url.ts';

const C = '1003800580026U';
const HOSTILE = [
  `http://www.vans.com.br/p/${C}`,
  `https://vans.com.br/p/${C}`,
  `https://vans.com.br.evil.test/p/${C}`,
  `https://www.vans.com.br.evil.test/p/${C}`,
  `https://www.vans.com.br@evil.test/p/${C}`,
  `https://user:pw@www.vans.com.br/p/${C}`,
  `https://user@www.vans.com.br/p/${C}`,
  `https://www.vans.com.br:8443/p/${C}`,
  `https://www.vans.com.br:80/p/${C}`,
  `https://169.254.169.254/p/${C}`,
  `https://127.0.0.1/p/${C}`,
  `https://[::1]/p/${C}`,
  `file:///etc/passwd`,
  `javascript:alert(1)`,
  `https://www.vans.com.br/`,
  `https://www.vans.com.br/produto/${C}`,
  `https://www.vans.com.br/p/`,
  `https://www.vans.com.br/%2e%2e/p/${C}`,
  `https://www.vans.com.br/a/b/p/${C}`,
  `https://www.vans.com.br/p/${C}/extra`,
  `https://www.vans.com.br\@evil.test/p/${C}`,
  `https://www.vans.com.br./p/${C}`,
  `https://www.vаns.com.br/p/${C}`, // 'а' cirílico
  `//www.vans.com.br/p/${C}`,
  `www.vans.com.br/p/${C}`,
  '',
  'não é url',
];

test('T-URL-02 tabela hostil (S1): toda URL é rejeitada, em pt-BR, sem lançar exceção', () => {
  for (const u of HOSTILE) {
    const r = extractProductCode(u);
    assert.equal(r.ok, false, `deveria rejeitar: ${u}`);
    if (!r.ok) assert.match(r.error.message, /[a-zé]/i);
  }
});

test('T-URL-03 sufixo -40 rejeitado, nunca vira code', () => {
  const r = extractProductCode(`https://www.vans.com.br/x/p/${C}-40`);
  assert.equal(r.ok, false);
});

test('T-URL-02 a função é pura: não usa fetch/rede (zero chamadas)', () => {
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => { calls++; throw new Error('rede proibida'); }) as typeof fetch;
  try {
    for (const u of HOSTILE) extractProductCode(u);
    extractProductCode(`https://www.vans.com.br/p/${C}`);
  } finally {
    globalThis.fetch = orig;
  }
  assert.equal(calls, 0);
});

test('T-URL-05 mensagem de rejeição não ecoa a URL (nem query/credenciais)', () => {
  const r = extractProductCode('https://user:segredo@evil.test/?fbclid=XYZ');
  assert.equal(r.ok, false);
  if (!r.ok) assert.doesNotMatch(JSON.stringify(r.error), /segredo|fbclid|evil/);
});
