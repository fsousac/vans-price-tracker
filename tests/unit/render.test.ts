import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderEmail, type RenderInput } from '../../src/notifications/render.ts';

const base: RenderInput = {
  alertId: 1, healthEventId: null, observationId: 5, kind: 'ATINGIDO', idempotencyKey: 'k'.repeat(64),
  mode: 'teste', productCode: '1003800580026U', productName: 'Old Skool', productSlug: 'tenis-old-skool',
  size: '34', priceCents: 37999, targetCents: 38000, marginBp: 500,
  observedAt: '2026-10-14T12:00:00.000Z', source: 'occ', degraded: false, alreadyInBand: false,
};

test('T-NOT-01 ATINGIDO: conteúdo, fuso SP, link, avisos', () => {
  const m = renderEmail(base, 'a@b.com');
  assert.equal(m.subject, 'Preço-alvo atingido: Old Skool');
  assert.equal(m.to, 'a@b.com');
  assert.equal(m.idempotencyKey, base.idempotencyKey);
  assert.equal(
    m.text,
    [
      'Old Skool atingiu o seu preço-alvo.', '',
      'Tamanho: 34', 'Preço atual: R$ 379,99', 'Preço-alvo: R$ 380,00',
      'Lido em: 14/10/2026 09:00 (horário de Brasília), fonte: occ',
      'Link: https://www.vans.com.br/tenis-old-skool/p/1003800580026U', '',
      'O preço pode ter mudado desde a leitura.',
      'Preço de vitrine: Pix, cupom ou carrinho podem diferir.', '',
    ].join('\n'),
  );
  assert.match(m.html, /<a href="https:\/\/www\.vans\.com\.br\/tenis-old-skool\/p\/1003800580026U">/);
  assert.doesNotMatch(m.text, /degradada/);
});

test('T-NOT-01 PROXIMO mostra margem e assunto distinto', () => {
  const m = renderEmail({ ...base, kind: 'PROXIMO', priceCents: 39500, marginBp: 250 }, 'a@b.com');
  assert.equal(m.subject, 'Próximo do alvo: Old Skool');
  assert.match(m.text, /próximo do seu preço-alvo/);
  assert.match(m.text, /Margem usada: 2,5%/);
});

test('T-NOT-01 degradado e already_in_band avisam', () => {
  const m = renderEmail({ ...base, degraded: true, alreadyInBand: true }, 'a@b.com');
  assert.match(m.text, /Fonte degradada/);
  assert.match(m.text, /já estava dentro da faixa/);
  assert.match(m.html, /Fonte degradada/);
});

test('T-NOT-01 SAUDE sem dados de preço', () => {
  const m = renderEmail(
    { ...base, kind: 'SAUDE', alertId: null, healthEventId: 3, priceCents: null, targetCents: null, marginBp: null, observedAt: null, source: null, size: null },
    'dono@x.com',
  );
  assert.match(m.subject, /atenção no monitoramento/);
  assert.doesNotMatch(m.text, /Preço atual|mudado/);
});

test('T-NOT-01 link sem slug usa /p/{code}', () => {
  const m = renderEmail({ ...base, productSlug: null }, 'a@b.com');
  assert.match(m.text, /Link: https:\/\/www\.vans\.com\.br\/p\/1003800580026U\n/);
});

test('T-NOT-01 nome malicioso: HTML escapado e CR/LF neutralizado no assunto', () => {
  const m = renderEmail({ ...base, productName: 'A<script>alert(1)</script>\r\nBcc: x@y.com' }, 'a@b.com');
  assert.doesNotMatch(m.subject, /[\r\n]/);
  assert.doesNotMatch(m.html, /<script>/);
  assert.match(m.html, /&lt;script&gt;/);
  assert.doesNotMatch(m.text, /\r/);
});

test('T-NOT-06 texto não afirma entrega', () => {
  assert.doesNotMatch(renderEmail(base, 'a@b.com').text, /entregue/i);
});
