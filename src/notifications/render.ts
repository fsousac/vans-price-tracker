import { formatBrl } from '../shared/money.ts';
import { stripControl } from '../shared/mask.ts';
import type { NewNotification, OutgoingEmail } from './ports.ts';

export type RenderInput = Omit<NewNotification, 'now'>;

const AVISO_MUDOU = 'O preço pode ter mudado desde a leitura.';
const AVISO_VITRINE = 'Preço de vitrine: Pix, cupom ou carrinho podem diferir.';
const AVISO_DEGRADADO = 'Fonte degradada: a leitura pode ter até ~5 min de defasagem.';
const AVISO_FAIXA = 'O preço já estava dentro da faixa quando o alerta foi criado ou editado.';

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// IsoUtc -> '14/10/2026 09:00' em America/Sao_Paulo (D-28)
export function formatSaoPaulo(iso: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]),
  );
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}

// 500 bp -> '5%', 250 -> '2,5%'
const fmtMargin = (bp: number) => `${String(bp / 100).replace('.', ',')}%`;

export function productUrl(code: string, slug: string | null): string {
  const s = slug ? stripControl(slug).replace(/^\/+|\/+$/g, '') : '';
  return `https://www.vans.com.br/${s ? `${encodeURIComponent(s)}/` : ''}p/${encodeURIComponent(code)}`;
}

export function renderEmail(n: RenderInput, to: string): OutgoingEmail {
  const name = stripControl(n.productName ?? '') || 'produto';
  const lines: string[] = []; // pares "rótulo: valor" + avisos
  let subject: string;
  let intro: string;
  const notes: string[] = [];

  if (n.kind === 'SAUDE') {
    subject = 'Vans Price Watcher: atenção no monitoramento';
    intro = `O monitor encontrou um problema${n.productName || n.productCode ? ` com ${name}` : ''}. Veja o painel para detalhes.`;
    if (n.productCode) lines.push(`Código: ${stripControl(n.productCode)}`);
  } else {
    const hit = n.kind === 'ATINGIDO';
    subject = hit ? `Preço-alvo atingido: ${name}` : `Próximo do alvo: ${name}`;
    intro = hit
      ? `${name} atingiu o seu preço-alvo.`
      : `${name} está próximo do seu preço-alvo.`;
    if (n.size) lines.push(`Tamanho: ${stripControl(n.size)}`);
    if (n.priceCents != null) lines.push(`Preço atual: ${formatBrl(n.priceCents)}`);
    if (n.targetCents != null) lines.push(`Preço-alvo: ${formatBrl(n.targetCents)}`);
    if (!hit && n.marginBp != null) lines.push(`Margem usada: ${fmtMargin(n.marginBp)}`);
    if (n.observedAt) lines.push(`Lido em: ${formatSaoPaulo(n.observedAt)} (horário de Brasília)${n.source ? `, fonte: ${n.source}` : ''}`);
    if (n.alreadyInBand) notes.push(AVISO_FAIXA);
    if (n.degraded) notes.push(AVISO_DEGRADADO);
    notes.push(AVISO_MUDOU, AVISO_VITRINE);
  }
  const link = n.productCode ? productUrl(n.productCode, n.productSlug) : null;
  if (link) lines.push(`Link: ${link}`);

  const text = [intro, '', ...lines, ...(notes.length ? ['', ...notes] : [])].join('\n') + '\n';
  const li = lines.map((l) =>
    l.startsWith('Link: ') ? `<li>Link: <a href="${esc(link!)}">${esc(link!)}</a></li>` : `<li>${esc(l)}</li>`).join('');
  const html =
    `<!doctype html><html lang="pt-BR"><body><p>${esc(intro)}</p><ul>${li}</ul>` +
    notes.map((x) => `<p>${esc(x)}</p>`).join('') + '</body></html>';

  return { to, subject, text, html, idempotencyKey: n.idempotencyKey };
}
