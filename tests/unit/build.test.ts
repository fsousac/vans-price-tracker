import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, ENTRIES } from '../../scripts/build.ts';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const tmp = mkdtempSync(join(tmpdir(), 'vans-build-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

test('build gera dist carregável: manifest com versão do package.json, bundles e ícones PNG', async () => {
  const out = await build({ outDir: join(tmp, 'a') });
  const m = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
  assert.equal(m.version, pkg.version);
  for (const f of ['background.js', 'popup.js', 'options.js', 'popup.html', 'options.html']) assert.ok(existsSync(join(out, f)), f);
  for (const s of [16, 32, 48, 128]) {
    const png = readFileSync(join(out, 'icons', `${s}.png`));
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(png.readUInt32BE(16), s); // largura no IHDR
  }
  assert.ok(!existsSync(join(out, 'selftest.html')), 'selftest fora da build normal');
  assert.ok(!existsSync(join(out, 'background.js.map')));
});

test('SW em ESM e popup em IIFE; sem node: nos bundles', async () => {
  const out = await build({ outDir: join(tmp, 'b'), dev: true });
  assert.ok(existsSync(join(out, 'background.js.map')), 'sourcemap só em --dev');
  for (const e of ENTRIES) assert.doesNotMatch(readFileSync(join(out, e.out), 'utf8'), /node:/);
  assert.match(readFileSync(join(out, 'popup.js'), 'utf8'), /^(?:"use strict";\n)?\(\(\) => \{/);
});

test('T-SEC-BUILD import node:fs falha o build', async () => {
  const bad = join(tmp, 'bad.ts');
  writeFileSync(bad, "import { readFileSync } from 'node:fs';\nexport const x = readFileSync;\n");
  await assert.rejects(
    build({ outDir: join(tmp, 'c'), entries: [{ in: bad, out: 'background.js', format: 'esm' }] }),
    /node:fs/,
  );
});
