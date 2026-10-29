// Contrato do helper fake-chrome (suporta testes T-EXT-*, RF-08 e RNF-SEG: permissões mínimas).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { installFakeChrome, MANIFEST_PATH, type FakeChrome, type Manifest } from '../helpers/fake-chrome.ts';

const manifest: Manifest = {
  permissions: ['alarms', 'notifications', 'activeTab'],
  host_permissions: ['https://www.vans.com.br/*'],
  optional_host_permissions: ['https://api.resend.com/*'],
};
let f: FakeChrome | undefined;
const setup = (m: Manifest = manifest) => (f = installFakeChrome({ manifest: m }));
afterEach(() => f?.uninstall());
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const C = (): any => (globalThis as any).chrome;

test('instala/desinstala globalThis.chrome; lê o manifest real quando existe', (t) => {
  setup();
  assert.ok(C().runtime.id);
  f!.uninstall();
  assert.equal(C(), undefined);
  if (!existsSync(MANIFEST_PATH)) return t.skip('extension/manifest.json ainda não existe');
  f = installFakeChrome();
  assert.ok(f.granted.origins.includes('https://www.vans.com.br/*'));
});

test('API sem permissão declarada falha (RNF-SEG: permissões mínimas)', () => {
  setup({ permissions: ['alarms'] });
  assert.throws(() => C().notifications, /permissão "notifications" não declarada/);
  assert.ok(C().alarms);
});

test('runtime.sendMessage: resposta síncrona, assíncrona (return true) e ausente', async () => {
  setup();
  const l = (m: any, _s: unknown, r: (x?: unknown) => void) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (m.type === 'sync') r({ ok: true });
    if (m.type === 'async') {
      setTimeout(() => r({ ok: 'later' }), 0);
      return true;
    }
  };
  C().runtime.onMessage.addListener(l);
  assert.deepEqual(await C().runtime.sendMessage({ type: 'sync' }), { ok: true });
  assert.deepEqual(await C().runtime.sendMessage({ type: 'async' }), { ok: 'later' });
  assert.equal(await C().runtime.sendMessage({ type: 'none' }), undefined);
  C().runtime.onMessage.removeListener(l);
  assert.equal(f!.onMessage.listeners.length, 0);
});

test('sendFrom entrega remetente forjado ao listener; getURL usa o id', async () => {
  setup();
  let seen: unknown;
  C().runtime.onMessage.addListener((_m: unknown, s: unknown, r: (x?: unknown) => void) => {
    seen = s;
    r(1);
  });
  await f!.sendFrom({}, { id: 'outra', url: 'https://evil.example/' });
  assert.deepEqual(seen, { id: 'outra', url: 'https://evil.example/' });
  assert.equal(C().runtime.getURL('/options.html'), `chrome-extension://${C().runtime.id}/options.html`);
});

test('onInstalled / onStartup disparam listeners', async () => {
  setup();
  const got: string[] = [];
  C().runtime.onInstalled.addListener((d: { reason: string }) => got.push(d.reason));
  C().runtime.onStartup.addListener(() => got.push('startup'));
  await f!.emitInstalled('update');
  await f!.emitStartup();
  assert.deepEqual(got, ['update', 'startup']);
});

test('alarms: create/get/clear, fire e periódico reagendado (RNF-REL: tick retomável)', async () => {
  setup();
  const fired: string[] = [];
  C().alarms.onAlarm.addListener((a: { name: string }) => fired.push(a.name));
  const t0 = f!.clock.now().getTime();
  await C().alarms.create('tick', { periodInMinutes: 15 });
  await C().alarms.create('resume', { delayInMinutes: 1 });
  assert.equal((await C().alarms.get('tick')).scheduledTime, t0 + 15 * 60_000);
  await f!.fire('resume'); // manual: ignora horário
  assert.equal(await C().alarms.get('resume'), undefined); // único removido
  await f!.fire('tick');
  assert.ok(await C().alarms.get('tick')); // periódico permanece
  assert.equal(await C().alarms.clear('tick'), true);
  assert.equal(await C().alarms.clear('tick'), false);
  assert.deepEqual(fired, ['resume', 'tick']);
  await assert.rejects(f!.fire('nada'), /inexistente/);
});

test('advance move o relógio manual e dispara só os vencidos, em ordem', async () => {
  setup();
  const fired: [string, number][] = [];
  C().alarms.onAlarm.addListener((a: { name: string }) => fired.push([a.name, f!.clock.now().getTime()]));
  const t0 = f!.clock.now().getTime();
  await C().alarms.create('tick', { periodInMinutes: 10 });
  await C().alarms.create('once', { delayInMinutes: 5 });
  await C().alarms.create('late', { delayInMinutes: 60 });
  await f!.advance(25 * 60_000);
  assert.deepEqual(fired, [['once', t0 + 5 * 60_000], ['tick', t0 + 10 * 60_000], ['tick', t0 + 20 * 60_000]]);
  assert.equal(f!.clock.now().getTime(), t0 + 25 * 60_000);
  assert.ok(await C().alarms.get('late'));
});

test('notifications: create valida, registra, click dispara onClicked', async () => {
  setup();
  const clicked: string[] = [];
  C().notifications.onClicked.addListener((id: string) => clicked.push(id));
  const opts = { type: 'basic', iconUrl: 'icons/128.png', title: 'Vans', message: 'R$ 199,90' };
  assert.equal(await C().notifications.create('k1', opts), 'k1');
  await assert.rejects(C().notifications.create('k2', { type: 'basic' }), /obrigatório/);
  assert.equal(f!.notificationCalls.length, 1);
  await f!.click('k1');
  assert.deepEqual(clicked, ['k1']);
  assert.equal(await C().notifications.clear('k1'), true);
  assert.throws(() => f!.click('k1'), /inexistente/);
});

test('permissions: opcional pedida/negada; fora do manifest rejeita; onRemoved (RF-08)', async () => {
  setup();
  const resend = { origins: ['https://api.resend.com/*'] };
  assert.equal(await C().permissions.contains(resend), false);
  f!.grantPermissions = false;
  assert.equal(await C().permissions.request(resend), false);
  assert.equal(await C().permissions.contains(resend), false);
  f!.grantPermissions = true;
  assert.equal(await C().permissions.request(resend), true);
  assert.equal(await C().permissions.contains(resend), true);
  await assert.rejects(C().permissions.request({ origins: ['https://evil.example/*'] }), /não declarado/);
  const removed: unknown[] = [];
  C().permissions.onRemoved.addListener((p: unknown) => removed.push(p));
  f!.revoke(resend); // usuário revoga pelo navegador
  assert.deepEqual(removed, [{ permissions: [], origins: resend.origins }]);
  assert.equal(await C().permissions.remove(resend), false);
});

test('tabs: query/create; URL só visível com activeTab na aba ativa ou host permitido', async () => {
  setup();
  f!.tabs.push({ id: 100, url: 'https://www.vans.com.br/p/x', active: true }, { id: 101, url: 'https://outro.example/', active: false });
  const all = await C().tabs.query({});
  assert.equal(all[0].url, 'https://www.vans.com.br/p/x');
  assert.equal(all[1].url, undefined);
  f!.uninstall();
  setup({ permissions: [] });
  f!.tabs.push({ id: 1, url: 'https://www.vans.com.br/p/x', active: true });
  assert.equal((await C().tabs.query({ active: true }))[0].url, undefined);
  const t = await C().tabs.create({ url: 'https://www.vans.com.br/p/y' });
  assert.ok(f!.tabs.some((x) => x.id === t.id));
});
