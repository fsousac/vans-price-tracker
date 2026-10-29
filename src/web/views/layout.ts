import { html } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';

// html`` devolve Promise só com filhos assíncronos; aqui tudo é síncrono.
export type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

export interface NavItem { href: string; label: string; current?: boolean }

// CSS só de /static/app.css (CSP style-src 'self'); sem <script> nem style= (S7).
export function layout(opts: { title: string; nav?: NavItem[]; banners?: Html[]; body: Html }): Html {
  const nav = opts.nav ?? [{ href: '/', label: 'Alertas' }, { href: '/catalogo', label: 'Catálogo' }];
  return html`<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${opts.title} - Vans Price Watcher</title>
<link rel="stylesheet" href="/static/app.css">
</head>
<body>
<a class="skip" href="#conteudo">Ir para o conteúdo</a>
<header class="topo"><strong>Vans Price Watcher</strong>
<nav aria-label="Principal">${nav.map((n) => html`<a href="${n.href}"${n.current ? html` aria-current="page"` : ''}>${n.label}</a>`)}</nav></header>
<main id="conteudo" tabindex="-1">
${opts.banners ?? ''}
<h1>${opts.title}</h1>
${opts.body}
</main>
</body>
</html>`;
}
