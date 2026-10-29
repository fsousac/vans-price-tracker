import { classifyBand, type Band } from '../../../shared/price-compare.ts';
import { freshness } from '../../../shared/freshness.ts';
import { brl, badge, formatSp, type Tone } from '../format.ts';

// Modelo de visão puro da aba Monitoramentos (RF-09, RN-17). Sem DOM nem chrome.
// Contrato assumido de `alerts.list`: { alerts: AlertRow[]; intervalHours: number }.

export interface AlertRow {
  id: number;
  productName: string;
  size: string;
  targetCents: number;
  marginBp: number;
  status: 'ATIVO' | 'PAUSADO';
  /** Último preço CONFIRMADO; null = nunca (leitura não confirmada não entra aqui). */
  priceCents: number | null;
  lastConfirmedAt: string | null;
  available: boolean | null;
}
export interface AlertsList { alerts: AlertRow[]; intervalHours: number }

export interface Chip { text: string; tone: Tone }
export interface AlertCard {
  id: number;
  title: string;
  size: string;
  target: string;
  margin: string;
  price: string;
  lastRead: string;
  band: Chip;
  fresh: Chip;
  state: Chip;
  availability: Chip;
  paused: boolean;
  toggle: { action: 'alert.pause' | 'alert.resume'; label: string };
  editTarget: string;
  editMargin: string;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null;
const int = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;

/** Guarda: linha malformada é descartada, nunca vira preço. */
export function parseAlertsList(data: unknown): AlertsList | null {
  if (!isObj(data) || !Array.isArray(data.alerts) || !int(data.intervalHours) || data.intervalHours < 1) return null;
  const alerts: AlertRow[] = [];
  for (const r of data.alerts) {
    if (!isObj(r) || !int(r.id) || r.id < 1 || typeof r.productName !== 'string' || typeof r.size !== 'string') continue;
    if (!int(r.targetCents) || !int(r.marginBp) || (r.status !== 'ATIVO' && r.status !== 'PAUSADO')) continue;
    alerts.push({
      id: r.id, productName: r.productName, size: r.size, targetCents: r.targetCents, marginBp: r.marginBp, status: r.status,
      priceCents: int(r.priceCents) ? r.priceCents : null,
      lastConfirmedAt: typeof r.lastConfirmedAt === 'string' ? r.lastConfirmedAt : null,
      available: typeof r.available === 'boolean' ? r.available : null,
    });
  }
  return { alerts, intervalHours: data.intervalHours };
}

export const formatMargin = (bp: number): string => `${(bp / 100).toString().replace('.', ',')}%`;
const BAND: Record<Band, Chip> = {
  ATINGIDO: { text: 'Alvo atingido', tone: 'ok' },
  PROXIMO: { text: 'Próximo do alvo', tone: 'warn' },
  ACIMA: { text: 'Acima do alvo', tone: 'neutral' },
};

export function toCard(r: AlertRow, now: Date, intervalHours: number): AlertCard {
  const paused = r.status === 'PAUSADO';
  const fr = freshness(r.lastConfirmedAt, now, intervalHours * 3_600_000);
  // Sem preço confirmado: faixa desconhecida, jamais "atingido".
  const band: Chip = r.priceCents === null ? { text: 'Sem leitura', tone: 'neutral' } : BAND[classifyBand(r.priceCents, r.targetCents, r.marginBp)];
  const av = r.available === null ? 'sem_dados' : r.available ? 'disponivel' : 'indisponivel';
  return {
    id: r.id,
    title: r.productName,
    size: r.size,
    target: brl(r.targetCents),
    margin: formatMargin(r.marginBp),
    price: brl(r.priceCents),
    lastRead: formatSp(r.lastConfirmedAt),
    band,
    fresh: badge(fr),
    state: badge(paused ? 'pausado' : 'ativo'),
    availability: badge(av),
    paused,
    toggle: paused ? { action: 'alert.resume', label: 'Retomar' } : { action: 'alert.pause', label: 'Pausar' },
    editTarget: (r.targetCents / 100).toFixed(2).replace('.', ','),
    editMargin: (r.marginBp / 100).toString().replace('.', ','),
  };
}

/** Ativos primeiro, depois nome e tamanho (ordem estável e previsível). */
export function toCards(list: AlertsList, now: Date): AlertCard[] {
  return [...list.alerts]
    .sort((a, b) => Number(a.status === 'PAUSADO') - Number(b.status === 'PAUSADO')
      || a.productName.localeCompare(b.productName, 'pt-BR')
      || a.size.localeCompare(b.size, 'pt-BR', { numeric: true })
      || a.id - b.id)
    .map((r) => toCard(r, now, list.intervalHours));
}

export const BROWSER_BANNER = 'A extensão só monitora com o navegador aberto. Com ele fechado, nenhuma leitura é feita e nenhum alerta é enviado.';
export const EMPTY = {
  title: 'Nenhum monitoramento ainda',
  body: 'Abra uma página de produto em vans.com.br e use o ícone da extensão, ou procure um produto na aba Catálogo.',
};
export const confirmDelete = (c: Pick<AlertCard, 'title' | 'size'>): string =>
  `Excluir o monitoramento de "${c.title}" (tamanho ${c.size})? Esta ação não pode ser desfeita.`;
