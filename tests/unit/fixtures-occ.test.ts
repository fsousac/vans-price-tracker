import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sanitizeBody } from '../../src/price-monitor/sanitize.ts';

const load = (f: string) => readFileSync(new URL(`../fixtures/vans/${f}`, import.meta.url), 'utf8');
const CASES = [
  ['occ_1002000690002U.json', '1002000690002U'],
  ['occ_dynamic_1002002760052U.json', '1002002760052U'],
] as const;

for (const [file, code] of CASES) {
  test(`T-TST-03 fixture ${file} presente, é OCC válido com preço e já sanitizada`, () => {
    const raw = load(file);
    const p = JSON.parse(raw);
    assert.equal(p.code, code);
    assert.equal(typeof p.price?.value, 'number');
    assert.equal(sanitizeBody(raw), raw); // idempotente: nada de cookie/utm/fbclid/token
  });
}
