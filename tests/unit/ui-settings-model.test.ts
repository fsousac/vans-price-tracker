import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSettings, HELP_TEXT, permissionText, removeKeyInput, RESEND_ORIGIN } from '../../src/ext/ui/options/settings-model.ts';

const form = { mode: 'real' as const, enabled: true, to: 'a@b.com', from: 'Vans <alerta@meudominio.com>', apiKey: '' };
const loaded = { intervalHours: 4, apiKeySet: true, granted: true };

test('RF-08 modo real sem permissão não salva', () => {
  const r = buildSettings(form, { ...loaded, granted: false });
  assert.ok(!r.ok && r.error.permission);
});

test('RF-08 modo real sem chave (nova ou guardada) não salva', () => {
  const r = buildSettings(form, { ...loaded, apiKeySet: false });
  assert.ok(!r.ok && r.error.apiKey);
});

test('RF-08 modo real com permissão e chave guardada: apiKey ausente (manter)', () => {
  const r = buildSettings(form, loaded);
  assert.ok(r.ok);
  assert.ok(!('apiKey' in r.value.email));
  assert.equal(r.value.intervalHours, 4);
});

test('RF-08 chave nova digitada vai no envio (aparada)', () => {
  const r = buildSettings({ ...form, apiKey: ' re_x ' }, { ...loaded, apiKeySet: false });
  assert.ok(r.ok && r.value.email.apiKey === 're_x');
});

test('RF-08 modo teste salva sem permissão nem chave', () => {
  const r = buildSettings({ ...form, mode: 'teste' }, { intervalHours: 4, apiKeySet: false, granted: false });
  assert.ok(r.ok && r.value.email.mode === 'teste');
});

test('RF-08 habilitado exige destinatário válido e remetente', () => {
  const r = buildSettings({ ...form, mode: 'teste', to: 'x', from: ' ' }, loaded);
  assert.ok(!r.ok && r.error.to && r.error.from);
});

test('RF-08 desligado aceita destinatário vazio, mas não inválido', () => {
  assert.ok(buildSettings({ ...form, mode: 'teste', enabled: false, to: '', from: '' }, loaded).ok);
  assert.ok(!buildSettings({ ...form, mode: 'teste', enabled: false, to: 'x' }, loaded).ok);
});

test('RNF-SEG remover chave manda apiKey null e desliga o envio', () => {
  const i = removeKeyInput(4, { mode: 'real', to: 'a@b.com', from: 'f' });
  assert.equal(i.email.apiKey, null);
  assert.equal(i.email.enabled, false);
});

test('RF-08 textos: permissão e ajuda (domínio verificado, chave só de envio, sem afirmar entrega)', () => {
  assert.equal(RESEND_ORIGIN, 'https://api.resend.com/*');
  assert.match(permissionText(true), /concedida/);
  assert.match(permissionText(false), /não concedida/i);
  assert.match(HELP_TEXT, /domínio verificado/);
  assert.match(HELP_TEXT, /envio/);
  assert.match(HELP_TEXT, /não entregue/);
});
