import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applySettings, defaultSettings, parseSettings, publicSettings, toStored } from '../../src/settings/settings.ts';

const KEY = 're_secret123';
const real = { mode: 'real' as const, enabled: true, to: 'a@b.com', from: 'x@y.com', apiKey: KEY };

test('RF-08 padrões: 4 h, e-mail desligado em modo teste', () => {
  const d = parseSettings(undefined);
  assert.equal(d.intervalHours, 4);
  assert.deepEqual(d.email, { mode: 'teste', enabled: false, to: '', from: '', apiKey: '' });
  assert.deepEqual(parseSettings({ v: 1 }).email, defaultSettings().email);
});

test('RNF parseSettings tolera lixo e descarta campos inválidos', () => {
  for (const raw of [null, 5, 'x', [], { intervalHours: 99, email: 3 }]) assert.equal(parseSettings(raw).intervalHours, 4);
  const s = parseSettings({ intervalHours: 1.5, email: { to: 'ruim', from: 'x@y.com', mode: 'foo', enabled: 'sim', apiKey: 'a b' } });
  assert.equal(s.intervalHours, 4);
  assert.deepEqual(s.email, { mode: 'teste', enabled: false, to: '', from: 'x@y.com', apiKey: '' });
  assert.equal(parseSettings({ intervalHours: 6 }).intervalHours, 6);
});

test('RNF intervalo aceita só inteiros de 2 a 6 h', () => {
  for (const n of [2, 3, 6]) assert.ok(applySettings(defaultSettings(), { intervalHours: n }).ok);
  for (const n of [1, 7, 0, 2.5, NaN, -4]) {
    const r = applySettings(defaultSettings(), { intervalHours: n });
    assert.ok(!r.ok && r.error.intervalHours, String(n));
  }
});

test('RF-08-AC9 destino e remetente validados por alerts/validation', () => {
  const r = applySettings(defaultSettings(), { email: { to: 'a@b.com,c@d.com', from: 'x\r\nBcc: z@z.com' } });
  assert.ok(!r.ok && r.error.to && r.error.from);
  const good = applySettings(defaultSettings(), { email: { to: ' a@b.com ', from: 'x@y.com' } });
  assert.ok(good.ok && good.value.email.to === 'a@b.com');
});

test('RF-08 ativar exige destino, remetente e (real) chave', () => {
  const r = applySettings(defaultSettings(), { email: { enabled: true, mode: 'real' } });
  assert.ok(!r.ok && r.error.to && r.error.from && r.error.apiKey);
  assert.ok(applySettings(defaultSettings(), { email: { enabled: true, to: 'a@b.com', from: 'x@y.com' } }).ok, 'modo teste não exige chave');
  assert.ok(applySettings(defaultSettings(), { email: real }).ok);
});

test('RNF apiKey: ausente mantém, vazia remove, inválida recusa', () => {
  const r0 = applySettings(defaultSettings(), { email: real });
  assert.ok(r0.ok);
  const cur = r0.value;
  const keep = applySettings(cur, { intervalHours: 3 });
  assert.ok(keep.ok && keep.value.email.apiKey === KEY);
  const del = applySettings(cur, { email: { enabled: false, apiKey: '' } });
  assert.ok(del.ok && del.value.email.apiKey === '');
  const bad = applySettings(cur, { email: { apiKey: 'a b' } });
  assert.ok(!bad.ok && bad.error.apiKey);
  assert.ok(!applySettings(cur, { email: { apiKey: 'x'.repeat(300) } }).ok);
});

test('SEC visão pública sem apiKey (apiKeySet) e toJSON redigido', () => {
  const s = parseSettings({ email: real });
  const pub = publicSettings(s);
  assert.equal(pub.email.apiKeySet, true);
  assert.ok(!('apiKey' in pub.email));
  assert.equal(publicSettings(defaultSettings()).email.apiKeySet, false);
  assert.ok(!JSON.stringify(s).includes(KEY));
  assert.ok(!JSON.stringify({ nested: s }).includes(KEY));
  assert.equal(s.email.apiKey, KEY, 'uso interno preserva a chave');
});

test('RNF toStored preserva a chave para persistência e relê igual', () => {
  const s = parseSettings({ intervalHours: 5, email: real });
  const st = toStored(s);
  assert.equal(st.email.apiKey, KEY);
  assert.deepEqual(parseSettings(structuredClone(st)), s);
});
