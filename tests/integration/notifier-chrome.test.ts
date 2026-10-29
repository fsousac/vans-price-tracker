import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeChrome, type FakeChrome } from '../helpers/fake-chrome.ts';
import { createChromeNotifier, registerNotificationClicks } from '../../src/ext/notifier.chrome.ts';
import type { NotificationRow } from '../../src/store/ports.ts';

let fc: FakeChrome;
afterEach(() => fc?.uninstall());

const row = (o: Partial<NotificationRow> = {}): NotificationRow =>
  ({
    key: 'k1', alertId: 1, healthEventId: null, observationId: 1, kind: 'ATINGIDO', mode: 'real',
    productCode: 'VN0A5JMQ6BT', productName: 'Old Skool', productSlug: null, size: '40', priceCents: 29900, targetCents: 30000,
    marginBp: null, observedAt: '2026-10-14T12:00:00Z', source: 'occ', degraded: false, alreadyInBand: false,
    desktop: 'pendente', email: 'PENDENTE', simulated: false, attempts: 0, nextAttemptAt: null, providerMessageId: null, acceptedAt: null,
    failureReason: null, createdAt: '2026-10-14T12:00:00Z', updatedAt: '2026-10-14T12:00:00Z', ...o,
  }) as NotificationRow;

test('T-NOT-10 RF-08 texto fixo: nome sem controle e <=80, preço, alvo, tamanho, horário SP; requireInteraction', async () => {
  fc = installFakeChrome();
  const r = await createChromeNotifier().show(row({ productName: 'A\nB' + 'x'.repeat(100) }));
  assert.equal(r, 'mostrada');
  const { id, options } = fc.notificationCalls[0]!;
  assert.equal(id, 'k1');
  assert.equal(options.type, 'basic');
  assert.equal(options.requireInteraction, true);
  assert.match(String(options.iconUrl), /^chrome-extension:\/\/.+\/icons\/128\.png$/);
  assert.equal(options.title, `Preço-alvo atingido: AB${'x'.repeat(78)}`);
  const msg = String(options.message);
  assert.match(msg, /R\$\s?299,00/);
  assert.match(msg, /R\$\s?300,00/);
  assert.match(msg, /Tamanho: 40/);
  assert.match(msg, /14\/10\/2026 09:00/);
});

test('T-NOT-11 SAUDE sem requireInteraction e sem dados de produto', async () => {
  fc = installFakeChrome();
  assert.equal(await createChromeNotifier().show(row({ kind: 'SAUDE', productName: 'Segredo' })), 'mostrada');
  const o = fc.notificationCalls[0]!.options;
  assert.equal(o.requireInteraction, false);
  assert.doesNotMatch(JSON.stringify(o), /Segredo/);
});

test('T-NOT-12 falha de create (ou lastError) vira "falha", sem lançar', async () => {
  fc = installFakeChrome();
  (fc.chrome.notifications as any).create = async () => { throw new Error('boom'); };
  assert.equal(await createChromeNotifier().show(row()), 'falha');
  (fc.chrome.notifications as any).create = async () => { (fc.chrome.runtime as any).lastError = { message: 'x' }; };
  assert.equal(await createChromeNotifier().show(row()), 'falha');
});

test('T-NOT-13 clique abre só a URL reconstruída do code validado', async () => {
  fc = installFakeChrome();
  registerNotificationClicks(async (k) => (k === 'k1' ? 'VN0A5JMQ6BT' : null));
  await createChromeNotifier().show(row());
  await fc.click('k1');
  assert.deepEqual(fc.tabs.map((t) => t.url), ['https://www.vans.com.br/p/VN0A5JMQ6BT']);
});

test('T-NOT-14 SEC-S1 code malicioso ou chave desconhecida não abre aba', async () => {
  fc = installFakeChrome();
  registerNotificationClicks(async (k) => (k === 'k1' ? 'x/../..//evil.com' : null));
  await createChromeNotifier().show(row());
  await createChromeNotifier().show(row({ key: 'k2' }));
  await fc.click('k1');
  await fc.click('k2');
  assert.equal(fc.tabs.length, 0);
});
