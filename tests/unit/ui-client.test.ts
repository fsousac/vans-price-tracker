import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeChrome, type FakeChrome } from '../helpers/fake-chrome.ts';
import { send } from '../../src/ext/ui/client.ts';

let f: FakeChrome;
afterEach(() => f?.uninstall());

test('RF-09 send repassa requisição e devolve dado do SW', async () => {
  f = installFakeChrome();
  let got: unknown;
  f.onMessage.addListener((m, _s, r) => {
    got = m;
    r({ ok: true, data: [1, 2] });
    return true;
  });
  const res = await send<number[]>({ type: 'alerts.list' });
  assert.deepEqual(got, { type: 'alerts.list' });
  assert.deepEqual(res, { ok: true, data: [1, 2] });
});

test('RF-09 erro do SW chega tipado, em pt-BR', async () => {
  f = installFakeChrome();
  f.onMessage.addListener((_m, _s, r) => {
    r({ ok: false, error: { code: 'nao_encontrado', message: 'Alerta não encontrado.' } });
    return true;
  });
  assert.deepEqual(await send({ type: 'alert.delete', id: 9 }), {
    ok: false,
    error: { code: 'nao_encontrado', message: 'Alerta não encontrado.' },
  });
});

test('RF-09 sem resposta ou resposta malformada vira erro interno, nunca dado', async () => {
  f = installFakeChrome();
  for (const bad of [undefined, 'x', { ok: true }, { ok: false, error: { code: 'x', message: 'm' } }]) {
    f.onMessage.listeners.length = 0;
    f.onMessage.addListener((_m, _s, r) => {
      r(bad);
      return true;
    });
    const res = await send({ type: 'health.get' });
    assert.equal(res.ok, false);
    assert.equal(!res.ok && res.error.code, 'interno');
  }
});

test('RF-09 falha de transporte não lança nem vaza detalhe', async () => {
  f = installFakeChrome();
  f.onMessage.addListener(() => {
    throw new Error('boom segredo');
  });
  const res = await send({ type: 'health.get' });
  assert.equal(res.ok, false);
  assert.ok(!JSON.stringify(res).includes('segredo'));
});
