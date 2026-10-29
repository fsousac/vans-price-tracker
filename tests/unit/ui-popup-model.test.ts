import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultVariant, parseInspect, popupState, sizeOptions, tabUrlToRequestUrl, validateForm, type Inspect } from '../../src/ext/ui/popup/model.ts';
import { errResponse, okResponse } from '../../src/ext/messages.ts';

const URL_OK = 'https://www.vans.com.br/old-skool/p/1003800580026U';
const data = {
  code: '1003800580026U', name: 'Tênis Old Skool',
  variants: [
    { variantCode: '1003800580026U-34', size: '34', priceCents: 39999, available: false },
    { variantCode: '1003800580026U-35', size: '35', priceCents: 39999, available: true },
    { variantCode: '1003800580026U-36', size: '36', priceCents: null, available: true },
  ],
  monitored: [{ id: 1, variantCode: '1003800580026U-35', targetCents: 35000, marginBp: 300, state: 'ativo' }],
};
const insp = (): Inspect => {
  const r = parseInspect(data);
  assert.ok(r.ok);
  return r.value;
};

test('RF-02 URL não Vans ou sem URL = estado "abra um produto", sem requisição', () => {
  for (const u of [undefined, '', 'https://example.com/p/1003800580026U', 'http://www.vans.com.br/x/p/1003800580026U', 'https://www.vans.com.br/']) {
    assert.equal(tabUrlToRequestUrl(u).ok, false);
    assert.equal(popupState(u, okResponse(data)).kind, 'nao_produto');
  }
  assert.equal(tabUrlToRequestUrl(URL_OK).ok, true);
});

test('RF-02 estados: produto, erro, circuito aberto (RF-11), resposta malformada', () => {
  assert.equal(popupState(URL_OK, okResponse(data)).kind, 'produto');
  assert.equal(popupState(URL_OK, errResponse('circuito_aberto', 'Pausado.')).kind, 'circuito');
  assert.equal(popupState(URL_OK, errResponse('falha_externa', 'Falha.')).kind, 'erro');
  assert.equal(popupState(URL_OK, null).kind, 'erro');
  assert.equal(popupState(URL_OK, okResponse({ code: 'x' })).kind, 'erro');
});

test('RN falha de extração nunca vira preço: preço inválido rejeita; ausente fica null', () => {
  for (const p of [-1, 1.5, '10', NaN]) {
    assert.equal(parseInspect({ ...data, variants: [{ ...data.variants[0], priceCents: p }] }).ok, false);
  }
  assert.equal(insp().variants[2]!.priceCents, null);
});

test('RF-03 tamanhos mostram disponibilidade em texto e marcam já monitorado', () => {
  const o = sizeOptions(insp());
  assert.match(o[0]!.label, /indisponível/);
  assert.match(o[1]!.label, /disponível.*já monitorado/);
  assert.match(o[2]!.label, /— — disponível/);
  assert.equal(defaultVariant(insp()), '1003800580026U-36');
});

test('RF-04/05 alvo com 3 casas = erro por campo; margem inválida = erro; nada de request', () => {
  const r = validateForm(insp(), { variantCode: '1003800580026U-34', target: '299,999', margin: '60' });
  assert.ok(r.errors.target && r.errors.margin);
  assert.equal(r.request, undefined);
  assert.ok(validateForm(insp(), { variantCode: '', target: '299,99', margin: '' }).errors.variant);
});

test('RF-05 margem vazia = padrão do SW; válida segue; tamanho já monitorado é erro', () => {
  const a = validateForm(insp(), { variantCode: '1003800580026U-34', target: ' 299,99 ', margin: '' });
  assert.deepEqual(a.request, { type: 'alert.create', variantCode: '1003800580026U-34', target: '299,99' });
  const b = validateForm(insp(), { variantCode: '1003800580026U-34', target: '299,99', margin: '5' });
  assert.equal(b.request?.margin, '5');
  assert.ok(validateForm(insp(), { variantCode: '1003800580026U-35', target: '299,99', margin: '' }).errors.variant);
});

test('RF-04 alvo >= preço atual = aviso, não erro; preço nulo sem aviso', () => {
  const a = validateForm(insp(), { variantCode: '1003800580026U-34', target: '400,00', margin: '' });
  assert.ok(a.request && a.warning);
  assert.equal(validateForm(insp(), { variantCode: '1003800580026U-34', target: '300,00', margin: '' }).warning, undefined);
  const c = validateForm(insp(), { variantCode: '1003800580026U-36', target: '400,00', margin: '' });
  assert.ok(c.request && !c.warning);
});
