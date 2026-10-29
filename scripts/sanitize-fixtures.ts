// Aplica sanitizeBody às fixtures de texto (investigation C10). Uso: node scripts/sanitize-fixtures.ts [dir]
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sanitizeBody } from '../src/price-monitor/sanitize.ts';

const TEXT = /\.(html|json|xml|txt|headers)$/;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
}

const root = process.argv[2] ?? 'tests/fixtures';
for (const file of walk(root).filter((f) => TEXT.test(f))) {
  const before = readFileSync(file, 'utf8');
  const after = sanitizeBody(before);
  if (after !== before) {
    writeFileSync(file, after);
    console.log(`sanitizado: ${file}`);
  }
}
