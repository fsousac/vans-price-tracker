import { readFileSync } from 'node:fs';

// Renderiza Html (hono) ou string para string.
export function render(h: unknown): string {
  if (h instanceof Promise) throw new TypeError('html assíncrono');
  return String(h);
}

export function attr(tag: string, name: string): string | undefined {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
}

// Tags de abertura de um elemento, ex.: tags(h, 'input').
export function tags(h: string, name: string): string[] {
  return h.match(new RegExp(`<${name}(?=[\\s>])[^>]*>`, 'g')) ?? [];
}

export function hasInlineStyleOrScript(h: string): boolean {
  return /\sstyle\s*=|<script|\son[a-z]+\s*=|<style/i.test(h);
}

function lum(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

// Tokens '--nome: #rrggbb' do bloco claro (antes do @media dark) e do escuro.
export function cssTokens(path = 'public/app.css'): { light: Record<string, string>; dark: Record<string, string>; css: string } {
  const css = readFileSync(path, 'utf8');
  const parse = (s: string) => Object.fromEntries([...s.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1]!, m[2]!]));
  const i = css.indexOf('prefers-color-scheme: dark');
  return { light: parse(css.slice(0, i)), dark: parse(css.slice(i)), css };
}
