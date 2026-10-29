import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeBody } from '../../src/price-monitor/sanitize.ts';

test('T-PRV-02 remove utm_* e fbclid da query, mantém os demais parâmetros', () => {
  const html = '{"url":"https://www.vans.com.br/x/p/1U?utm_source=facebook&utm_medium=cpc&media_type=image&fbclid=AbC_123"}';
  const out = sanitizeBody(html);
  assert.equal(out, '{"url":"https://www.vans.com.br/x/p/1U?media_type=image"}');
});

test('T-PRV-02 query só de rastreio some junto com o "?"', () => {
  assert.equal(sanitizeBody('<a href="/p/1U?fbclid=zz&amp;utm_id=9">x</a>'), '<a href="/p/1U">x</a>');
  assert.equal(sanitizeBody('"/p/1U?utm_term=a\u0026fbclid=b"'), '"/p/1U"');
});

test('T-PRV-02 remove linhas Set-Cookie/Cookie/Authorization e ids de sessão', () => {
  const h = 'HTTP/1.1 400\r\nSet-Cookie: JSESSIONID=ABC.node2; Path=/\r\nCookie: a=b\r\nAuthorization: Basic xx\r\nServer: cloudflare\r\n';
  assert.equal(sanitizeBody(h), 'HTTP/1.1 400\r\nServer: cloudflare\r\n');
  assert.equal(sanitizeBody('x JSESSIONID=ABC.1 y'), 'x  y');
});

test('T-PRV-02 mascara tokens Bearer', () => {
  assert.equal(sanitizeBody('{"h":"Bearer abc.DEF-1/2="}'), '{"h":"Bearer [redacted]"}');
});

test('T-PRV-02 corpo limpo passa idêntico e é idempotente', () => {
  const clean = '{"price":9999,"code":"1002000690063U"}';
  assert.equal(sanitizeBody(clean), clean);
  const dirty = 'u?utm_a=1&fbclid=2';
  assert.equal(sanitizeBody(sanitizeBody(dirty)), sanitizeBody(dirty));
});

test('T-PRV-02 não corrompe "?" e "&" fora de query de rastreio', () => {
  const s = '<?xml version="1.0"?><p>Quer? "sim" & não</p>{"a":"ok?"}x?y=1&z=2';
  assert.equal(sanitizeBody(s), s);
});
