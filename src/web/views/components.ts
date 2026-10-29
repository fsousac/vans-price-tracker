import { html } from 'hono/html';
import type { Html } from './layout.ts';
import type { Cents } from '../../shared/types.ts';

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const DATE = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
});

// centavos inteiros -> 'R$ 1.234,56' (espaço comum no lugar do NBSP do Intl)
export function formatBrl(cents: Cents): string {
  return BRL.format(cents / 100).replace(/ /g, ' ');
}

// ISO UTC -> 'dd/mm/aaaa HH:MM' em America/Sao_Paulo
export function formatDateTime(iso: string): string {
  return DATE.format(new Date(iso)).replace(',', '');
}

export type Tone = 'ok' | 'aviso' | 'erro' | 'neutro';

// O estado vai em texto; a cor só reforça (WCAG 1.4.1).
export function badge(label: string, tone: Tone = 'neutro'): Html {
  return html`<span class="selo selo-${tone}">${label}</span>`;
}

export function banner(tone: Exclude<Tone, 'neutro'>, message: string | Html): Html {
  // erro interrompe o leitor de tela; demais são avisos educados
  const role = tone === 'erro' ? 'alert' : 'status';
  return html`<div class="banner banner-${tone}" role="${role}">${message}</div>`;
}

export interface FieldOpts {
  id: string; name: string; label: string; type?: string; value?: string;
  hint?: string; error?: string; required?: boolean; attrs?: Record<string, string>;
}

// Rótulo associado; dica e erro ligados por aria-describedby; erro em texto.
export function field(o: FieldOpts): Html {
  const hintId = `${o.id}-dica`;
  const errId = `${o.id}-erro`;
  const described = [o.hint ? hintId : '', o.error ? errId : ''].filter(Boolean).join(' ');
  const extra = Object.entries(o.attrs ?? {}).map(([k, v]) => html` ${k}="${v}"`);
  return html`<div class="campo${o.error ? ' campo-erro' : ''}">
<label for="${o.id}">${o.label}${o.required ? html` <span aria-hidden="true">*</span>` : ''}</label>
${o.hint ? html`<p class="dica" id="${hintId}">${o.hint}</p>` : ''}
<input id="${o.id}" name="${o.name}" type="${o.type ?? 'text'}" value="${o.value ?? ''}"${o.required ? html` required` : ''}${o.error ? html` aria-invalid="true"` : ''}${described ? html` aria-describedby="${described}"` : ''}${extra}>
${o.error ? html`<p class="erro" id="${errId}"><strong>Erro:</strong> ${o.error}</p>` : ''}
</div>`;
}

// Tabela com legenda e th scope; células já são Html ou texto (escapado).
export function table(o: { caption: string; headers: string[]; rows: (string | Html)[][]; empty?: string | Html }): Html {
  if (o.rows.length === 0 && o.empty) return emptyState(o.empty);
  return html`<div class="tabela-rolagem"><table>
<caption>${o.caption}</caption>
<thead><tr>${o.headers.map((h) => html`<th scope="col">${h}</th>`)}</tr></thead>
<tbody>${o.rows.map((r) => html`<tr>${r.map((c) => html`<td>${c}</td>`)}</tr>`)}</tbody>
</table></div>`;
}

// Estado vazio explica o próximo passo (RNF-UX-01).
export function emptyState(message: string | Html): Html {
  return html`<p class="vazio">${message}</p>`;
}
