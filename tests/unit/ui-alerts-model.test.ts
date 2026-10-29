import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BROWSER_BANNER, EMPTY, confirmDelete, formatMargin, parseAlertsList, toCard, toCards, type AlertRow } from '../../src/ext/ui/options/alerts-model.ts';

const NOW = new Date('2026-10-15T12:00:00Z');
const row = (o: Partial<AlertRow> = {}): AlertRow => ({
  id: 1, productName: 'Old Skool', size: '40', targetCents: 37998, marginBp: 300, status: 'ATIVO',
  priceCents: 40000, lastConfirmedAt: '2026-10-15T10:00:00Z', available: true, ...o,
});

test('RF-09/RN-05 faixa por inteiros: atingido, próximo, acima, e texto em cada selo', () => {
  assert.equal(toCard(row({ priceCents: 37998 }), NOW, 4).band.text, 'Alvo atingido');
  assert.equal(toCard(row({ priceCents: 39137 }), NOW, 4).band.text, 'Próximo do alvo'); // = T*1,03
  assert.equal(toCard(row({ priceCents: 39138 }), NOW, 4).band.text, 'Acima do alvo');
});

test('RN-18 sem preço confirmado: faixa "Sem leitura", nunca atingido; preço vira travessão', () => {
  const c = toCard(row({ priceCents: null, lastConfirmedAt: null, available: null }), NOW, 4);
  assert.equal(c.band.text, 'Sem leitura');
  assert.equal(c.price, '—');
  assert.equal(c.fresh.text, 'Sem dados');
  assert.equal(c.lastRead, '—');
  assert.equal(c.availability.text, 'Sem dados');
});

test('RN-17 frescor: fresco até 2x intervalo, defasado até 24 h, depois sem dados', () => {
  assert.equal(toCard(row({ lastConfirmedAt: '2026-10-15T04:00:00Z' }), NOW, 4).fresh.text, 'Atualizado'); // 8 h
  assert.equal(toCard(row({ lastConfirmedAt: '2026-10-15T03:59:00Z' }), NOW, 4).fresh.text, 'Defasado');
  assert.equal(toCard(row({ lastConfirmedAt: '2026-10-13T12:00:00Z' }), NOW, 4).fresh.text, 'Sem dados');
  assert.equal(toCard(row({ lastConfirmedAt: 'lixo' }), NOW, 4).fresh.text, 'Sem dados');
});

test('RF-09 estado em texto e ação pausar/retomar conforme status', () => {
  const a = toCard(row(), NOW, 4);
  assert.deepEqual([a.state.text, a.toggle.action, a.toggle.label], ['Ativo', 'alert.pause', 'Pausar']);
  const p = toCard(row({ status: 'PAUSADO' }), NOW, 4);
  assert.deepEqual([p.state.text, p.toggle.action, p.toggle.label], ['Pausado', 'alert.resume', 'Retomar']);
});

test('RF-09 BRL, margem e valores de edição prontos para validateTarget/validateMargin', () => {
  const c = toCard(row({ marginBp: 350 }), NOW, 4);
  assert.equal(c.target, 'R$ 379,98');
  assert.equal(c.margin, '3,5%');
  assert.equal(c.editTarget, '379,98');
  assert.equal(c.editMargin, '3,5');
  assert.equal(formatMargin(0), '0%');
  assert.equal(formatMargin(5000), '50%');
});

test('RF-09 ordem: ativos antes de pausados, depois nome e tamanho numérico', () => {
  const ids = toCards({ intervalHours: 4, alerts: [
    row({ id: 1, status: 'PAUSADO' }), row({ id: 2, productName: 'Sk8-Hi', size: '9' }),
    row({ id: 3, size: '41' }), row({ id: 4, size: '5' }),
  ] }, NOW).map((c) => c.id);
  assert.deepEqual(ids, [4, 3, 2, 1]);
});

test('parseAlertsList descarta linhas malformadas e rejeita envelope inválido', () => {
  const good = row();
  const l = parseAlertsList({ intervalHours: 4, alerts: [good, { ...good, id: 'x' }, { ...good, status: 'X' }, { ...good, targetCents: -1 }, null, { ...good, id: 2, priceCents: 1.5 }] });
  assert.equal(l?.alerts.length, 2);
  assert.equal(l?.alerts[1]?.priceCents, null); // preço inválido nunca vira número
  for (const x of [null, {}, { alerts: [], intervalHours: 0 }, { alerts: 'x', intervalHours: 4 }]) assert.equal(parseAlertsList(x), null);
});

test('RF-09 estado vazio útil, banner do navegador aberto e confirmação de exclusão', () => {
  assert.match(EMPTY.body, /vans\.com\.br/);
  assert.match(EMPTY.body, /Catálogo/);
  assert.match(BROWSER_BANNER, /navegador aberto/);
  assert.match(confirmDelete({ title: 'Old Skool', size: '40' }), /Excluir.*Old Skool.*40.*não pode ser desfeita/);
});
