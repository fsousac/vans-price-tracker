import { test } from 'node:test';
import assert from 'node:assert/strict';
import { html } from 'hono/html';
import { layout } from '../../src/web/views/layout.ts';
import { badge, banner, field, table, emptyState, formatBrl, formatDateTime } from '../../src/web/views/components.ts';
import { render, attr, tags, hasInlineStyleOrScript, contrast, cssTokens } from '../helpers/html.ts';

const XSS = `<script>alert(1)</script>"'&`;

test('T-WEB-08 layout: lang pt-BR, pular link, link CSS, sem script nem style inline', () => {
  const out = render(layout({
    title: 'Alertas',
    body: html`<p>ok</p>`,
    banners: [banner('aviso', 'x')],
    nav: [{ href: '/', label: 'Alertas', current: true }],
  }));
  assert.match(out, /<html lang="pt-BR">/);
  assert.match(out, /href="\/static\/app\.css"/);
  assert.match(out, /class="skip" href="#conteudo"/);
  assert.match(out, /<main id="conteudo"/);
  assert.match(out, /aria-current="page"/);
  assert.equal(hasInlineStyleOrScript(out), false);
  assert.match(out, /name="viewport"/);
});

test('T-SEC-04 componentes e layout escapam interpolação', () => {
  const outs = [
    layout({ title: XSS, body: html`<p>${XSS}</p>` }),
    field({ id: 'a', name: 'a', label: XSS, value: XSS, hint: XSS, error: XSS }),
    table({ caption: XSS, headers: [XSS], rows: [[XSS]] }),
    badge(XSS), banner('erro', XSS), emptyState(XSS),
  ].map(render);
  for (const o of outs) {
    assert.ok(!o.includes('<script>alert'), o);
    assert.ok(o.includes('&lt;script&gt;'), o);
  }
});

test('T-WEB-08 field: rótulo, aria-invalid e aria-describedby apontam para dica e erro', () => {
  const out = render(field({ id: 'alvo', name: 'alvo', label: 'Preço alvo', hint: 'Em reais', error: 'Informe um valor maior que zero.', required: true }));
  assert.match(out, /<label for="alvo">/);
  const input = tags(out, 'input')[0]!;
  assert.equal(attr(input, 'aria-invalid'), 'true');
  const ids = attr(input, 'aria-describedby')!.split(' ');
  assert.deepEqual(ids, ['alvo-dica', 'alvo-erro']);
  for (const id of ids) assert.ok(out.includes(`id="${id}"`));
  assert.match(out, /<strong>Erro:<\/strong> Informe/);
});

test('T-WEB-08 field sem erro: sem aria-invalid nem aria-describedby', () => {
  const input = tags(render(field({ id: 'e', name: 'e', label: 'E-mail', type: 'email' })), 'input')[0]!;
  assert.equal(attr(input, 'aria-invalid'), undefined);
  assert.equal(attr(input, 'aria-describedby'), undefined);
  assert.equal(attr(input, 'type'), 'email');
});

test('T-UX-01 tabela com legenda/th scope e estado vazio com próximo passo', () => {
  const t = render(table({ caption: 'Histórico', headers: ['Data', 'Preço'], rows: [['a', 'b']] }));
  assert.match(t, /<caption>Histórico<\/caption>/);
  assert.equal(tags(t, 'th').every((x) => attr(x, 'scope') === 'col'), true);
  const v = render(table({ caption: 'x', headers: ['a'], rows: [], empty: 'Nenhum alerta. Crie o primeiro no catálogo.' }));
  assert.match(v, /class="vazio"/);
  assert.ok(!v.includes('<table'));
});

test('T-ACC-01 selo e banner: estado em texto; role alert só para erro', () => {
  assert.match(render(badge('Pausado', 'aviso')), />Pausado<\/span>/);
  assert.match(render(banner('erro', 'Falha')), /role="alert"/);
  assert.match(render(banner('aviso', 'Atrasado')), /role="status"/);
});

test('RNF-I18N-01 moeda em centavos e data em America/Sao_Paulo', () => {
  assert.equal(formatBrl(123456), 'R$ 1.234,56');
  assert.equal(formatBrl(0), 'R$ 0,00');
  assert.equal(formatDateTime('2026-10-14T02:30:00.000Z'), '13/10/2026 23:30');
});

test('T-ACC-01 contraste dos tokens >= 4.5:1 nos temas claro e escuro', () => {
  const { light, dark } = cssTokens();
  const pairs: [string, string][] = [
    ['fg', 'bg'], ['muted', 'bg'], ['muted', 'surface'], ['fg', 'surface'], ['accent', 'bg'], ['accent-fg', 'accent'],
    ['ok-fg', 'ok-bg'], ['warn-fg', 'warn-bg'], ['err-fg', 'err-bg'], ['neutral-fg', 'neutral-bg'], ['err-fg', 'bg'],
  ];
  for (const [name, t] of [['claro', light], ['escuro', { ...light, ...dark }]] as const) {
    for (const [f, b] of pairs) {
      assert.ok(t[f] && t[b], `${name}: token ${f}/${b} ausente`);
      const r = contrast(t[f]!, t[b]!);
      assert.ok(r >= 4.5, `${name}: ${f} sobre ${b} = ${r.toFixed(2)}`);
    }
  }
});

test('T-ACC-01 CSS: foco visível, responsivo, sem url externa nem @import (CSP style-src self)', () => {
  const { css } = cssTokens();
  assert.match(css, /:focus-visible/);
  assert.match(css, /max-width: 480px/);
  assert.ok(!/@import|https?:\/\//.test(css));
});
