// Captura MANUAL das fixtures OCC faltantes (RNF-TEST-04, T-TST-03). Nunca roda em testes.
// Uso: node scripts/capture-fixtures.ts   (1 requisição por vez, 2-5 s de intervalo)
// Se a loja responder diferente de 200 (403/429...), para: sem retentativa e sem evasão (RNF-LEG-02).
import { writeFileSync } from 'node:fs';
import { sanitizeBody } from '../src/price-monitor/sanitize.ts';

const BASE = 'https://www.vans.com.br/arezzocoocc/v2/vans/products';
const TARGETS = [
  { code: '1002000690002U', file: 'tests/fixtures/vans/occ_1002000690002U.json' }, // Era Navy
  { code: '1002002760052U', file: 'tests/fixtures/vans/occ_dynamic_1002002760052U.json' }, // Knu Skool
];
const UA = 'VansPriceWatcher/0.1 (uso pessoal; captura manual de fixtures)';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

for (const [i, { code, file }] of TARGETS.entries()) {
  if (i > 0) await sleep(2000 + Math.random() * 3000);
  const res = await fetch(`${BASE}/${code}`, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (res.status !== 200) {
    console.error(`parado: ${code} respondeu ${res.status}; nada mais será capturado`);
    process.exit(1);
  }
  const body = await res.text();
  JSON.parse(body); // recusa corpo que não é JSON (nunca grava como fixture)
  writeFileSync(file, sanitizeBody(body));
  console.log(`gravado: ${file} (${body.length} bytes)`);
}
