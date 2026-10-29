import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = new URL('../fixtures/', import.meta.url);
const walk = (d: string): string[] =>
  readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));

test('T-PRV-02 fixtures versionadas sem fbclid, utm_, Set-Cookie ou Cookie:', () => {
  const bad = /fbclid|utm_|set-cookie|cookie:/i;
  const offenders = walk(DIR.pathname.replace(/^\/([A-Za-z]:)/, '$1'))
    .filter((f) => /\.(html|json|xml|txt|headers)$/.test(f))
    .filter((f) => bad.test(readFileSync(f, 'utf8')));
  assert.deepEqual(offenders, []);
});

test('T-PRV-02 sem duplicatas de C9', () => {
  const names = new Set(readdirSync(join(DIR.pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'vans')));
  assert.ok(!(names.has('product-era-navy.html') && names.has('product_disc_oos_1002000690002U.html')));
  assert.ok(!(names.has('cat-sapatos.html') && names.has('sapatos.raw.html')));
});
