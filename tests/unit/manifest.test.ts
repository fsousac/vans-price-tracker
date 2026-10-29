import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const m = JSON.parse(readFileSync(new URL('../../extension/manifest.json', import.meta.url), 'utf8'));

test('T-SEC-MANIFEST permissões e hosts exatos (RNF minimo privilégio)', () => {
  assert.equal(m.manifest_version, 3);
  assert.deepEqual([...m.permissions].sort(), ['activeTab', 'alarms', 'notifications', 'unlimitedStorage']);
  assert.deepEqual(m.host_permissions, ['https://www.vans.com.br/*']);
  assert.deepEqual(m.optional_host_permissions, ['https://api.resend.com/*']); // RF-08 e-mail opcional
  assert.equal(m.optional_permissions, undefined);
});

test('T-SEC-MANIFEST sem superfícies extras', () => {
  for (const k of ['content_scripts', 'externally_connectable', 'web_accessible_resources', 'update_url'])
    assert.equal(m[k], undefined, k);
  for (const p of ['tabs', 'scripting', 'cookies', 'webRequest', 'declarativeNetRequest', 'storage', 'history', '<all_urls>'])
    assert.ok(!m.permissions.includes(p), p);
});

test('T-SEC-CSP estrita: sem eval, inline, código remoto', () => {
  const csp: string = m.content_security_policy.extension_pages;
  const d = Object.fromEntries(csp.split(';').map((s) => s.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));
  assert.deepEqual(d['default-src'], ["'none'"]);
  assert.deepEqual(d['script-src'], ["'self'"]);
  assert.deepEqual(d['object-src'], ["'none'"]);
  assert.deepEqual(d['connect-src'], ["'self'", 'https://www.vans.com.br', 'https://api.resend.com']);
  assert.doesNotMatch(csp, /unsafe-|wasm-unsafe|\*|http:|data:|blob:/);
});

test('manifest aponta para arquivos que o build gera', () => {
  assert.equal(m.background.service_worker, 'background.js');
  assert.equal(m.background.type, 'module');
  assert.equal(m.action.default_popup, 'popup.html');
  assert.equal(m.options_ui.page, 'options.html');
  assert.deepEqual(Object.keys(m.icons), ['16', '32', '48', '128']);
});
