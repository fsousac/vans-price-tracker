import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errResponse, okResponse, parseRequest, parseResponse } from '../../src/ext/messages.ts';

const good = (x: unknown) => {
  const r = parseRequest(x);
  assert.equal(r.ok, true, JSON.stringify(x));
  return r.ok ? r.value : null!;
};
const rejects = (x: unknown) => assert.equal(parseRequest(x).ok, false, JSON.stringify(x));

test('RF-03 mensagens sem argumento e só-id aceitas; extras descartados', () => {
  assert.deepEqual(good({ type: 'alerts.list', evil: 1 }), { type: 'alerts.list' });
  assert.deepEqual(good({ type: 'alert.pause', id: 3, x: 'y' }), { type: 'alert.pause', id: 3 });
  for (const id of [0, -1, 1.5, '3', null, NaN, 2 ** 60]) rejects({ type: 'alert.delete', id });
});

test('T-SEC entrada não-objeto, tipo ausente/desconhecido e protótipo são recusados', () => {
  for (const x of [null, undefined, 'x', 5, [], {}, { type: 7 }, { type: 'eval' }, { type: '__proto__' }, { type: 'constructor' }]) rejects(x);
});

test('T-BND-01 alert.create valida alvo e margem pelas regras do formulário (RF-04, RF-05)', () => {
  const v = good({ type: 'alert.create', variantCode: '1003800580026U-34', target: '379,99', margin: '3' });
  assert.equal(v.type, 'alert.create');
  assert.equal(good({ type: 'alert.create', variantCode: '1003800580026U-34', target: '379,99' }).type, 'alert.create');
  rejects({ type: 'alert.create', variantCode: '1003800580026U-34', target: '379,999' });
  rejects({ type: 'alert.create', variantCode: '1003800580026U-34', target: '0' });
  rejects({ type: 'alert.create', variantCode: '1003800580026U-34', target: '10', margin: '51' });
  rejects({ type: 'alert.create', variantCode: '1003800580026U-34' });
  rejects({ type: 'alert.create', variantCode: '../etc', target: '10' });
  rejects({ type: 'alert.create', variantCode: '1003800580026U-34', target: 10 });
});

test('RF-06 alert.update aceita campos parciais e valida os presentes', () => {
  assert.deepEqual(good({ type: 'alert.update', id: 2, margin: '5' }), { type: 'alert.update', id: 2, margin: '5' });
  rejects({ type: 'alert.update', id: 2, target: 'abc' });
  rejects({ type: 'alert.update', id: 'a', target: '10' });
});

test('T-SEC history/product/catalog/notification com limites', () => {
  good({ type: 'history.get', alertId: 1, page: 0 });
  rejects({ type: 'history.get', alertId: 1, page: -1 });
  rejects({ type: 'history.get', alertId: 1, page: 1e9 });
  good({ type: 'product.resume', code: '1003800580026U' });
  rejects({ type: 'product.resume', code: 'curto' });
  rejects({ type: 'product.resume', code: '1003800580026U/../x' });
  good({ type: 'catalog.search', q: 'old skool' });
  rejects({ type: 'catalog.search', q: 'x'.repeat(101) });
  good({ type: 'notification.resend', key: '1|2|ATINGIDO|1' });
  rejects({ type: 'notification.resend', key: 'a\nb' });
  good({ type: 'tab.inspect', url: 'https://www.vans.com.br/old-skool/p/1003800580026U' });
  rejects({ type: 'tab.inspect', url: '' });
  rejects({ type: 'tab.inspect', url: 'h'.repeat(2049) });
});

const settings = (email: Record<string, unknown>, intervalHours: unknown = 4) => ({
  type: 'settings.set',
  settings: { intervalHours, email: { mode: 'teste', enabled: true, to: 'a@b.com', from: 'onboarding@resend.dev', ...email } },
});

test('RF-08 settings.set: e-mail, intervalo e chave', () => {
  good(settings({}));
  good(settings({ enabled: false, to: '' , from: ''}));
  rejects(settings({}, 1));
  rejects(settings({}, 7));
  rejects(settings({}, 3.5));
  rejects(settings({ mode: 'x' }));
  rejects(settings({ to: 'a@b.com, c@d.com' }));
  rejects(settings({ to: 'nope' }));
  rejects(settings({ from: '' }));
  rejects(settings({ from: 'a@b.com\r\nBcc: x@y.z' }));
});

test('T-SEC apiKey: ausente mantém, null remove, string troca; CRLF/vazia recusadas', () => {
  const key = (m: Record<string, unknown>) => {
    const v = good(settings(m));
    return v.type === 'settings.set' ? v.settings.email : null!;
  };
  assert.equal('apiKey' in key({}), false);
  assert.equal(key({ apiKey: null }).apiKey, null);
  assert.equal(key({ apiKey: 're_abc123' }).apiKey, 're_abc123');
  rejects(settings({ apiKey: 're_a\r\nX: y' }));
  rejects(settings({ apiKey: '  ' }));
  rejects(settings({ apiKey: 5 }));
  rejects(settings({ apiKey: 'k'.repeat(257) }));
});

test('parseResponse aceita {ok,data}/{ok:false,error}; formato estranho vira erro', () => {
  assert.deepEqual(parseResponse(okResponse({ a: 1 })), { ok: true, data: { a: 1 } });
  const e = errResponse('duplicado', 'Já existe.');
  assert.deepEqual(parseResponse(e), e);
  for (const x of [undefined, null, 'x', { ok: true }, { ok: false }, { ok: false, error: { code: 'zzz', message: 'm' } }]) {
    const r = parseResponse(x);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, 'interno');
  }
});
