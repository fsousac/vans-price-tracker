// Build da extensão: esbuild (único dev-dep novo) -> dist/. Uso: node scripts/build.ts [--dev]
import { build as esbuild, type Plugin } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeIcons } from './make-icons.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export interface Entry { in: string; out: string; format: 'esm' | 'iife' }
export const ENTRIES: Entry[] = [
  { in: 'src/ext/background/sw.ts', out: 'background.js', format: 'esm' },
  { in: 'src/ext/ui/popup/main.ts', out: 'popup.js', format: 'iife' },
  { in: 'src/ext/ui/options/main.ts', out: 'options.js', format: 'iife' },
];

// Nada de Node no bundle: falha o build em qualquer import node:*.
const noNode: Plugin = {
  name: 'no-node',
  setup(b) {
    b.onResolve({ filter: /^node:/ }, (a) => ({
      errors: [{ text: `import ${a.path} proibido no bundle da extensão (${a.importer})` }],
    }));
  },
};

export async function build(opts: { dev?: boolean; outDir?: string; entries?: Entry[] } = {}): Promise<string> {
  const dev = !!opts.dev;
  const abs = (p: string) => (isAbsolute(p) ? p : resolve(ROOT, p));
  const outDir = abs(opts.outDir ?? 'dist');
  const entries = [...(opts.entries ?? ENTRIES)];

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  // extension/dev/ só entra com --dev (e vai para a raiz de dist)
  cpSync(abs('extension'), outDir, { recursive: true, filter: (s) => !/[\\/]extension[\\/]dev([\\/]|$)/.test(s) });
  if (dev && existsSync(abs('extension/dev'))) cpSync(abs('extension/dev'), outDir, { recursive: true });
  if (dev && existsSync(abs('src/ext/selftest.ts'))) entries.push({ in: 'src/ext/selftest.ts', out: 'selftest.js', format: 'iife' });

  makeIcons(join(outDir, 'icons'));

  const manifestPath = join(outDir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.version = JSON.parse(readFileSync(abs('package.json'), 'utf8')).version;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  for (const e of entries) {
    await esbuild({
      entryPoints: [abs(e.in)],
      outfile: join(outDir, e.out),
      bundle: true,
      platform: 'browser',
      target: 'chrome120',
      format: e.format,
      charset: 'utf8',
      legalComments: 'none',
      minify: false,
      sourcemap: dev,
      plugins: [noNode],
      logLevel: 'silent',
    });
  }
  return outDir;
}

if (import.meta.main) {
  build({ dev: process.argv.includes('--dev') }).then(
    (d) => console.log(`ok -> ${d}`),
    (e: Error) => { console.error(e.message); process.exit(1); },
  );
}
