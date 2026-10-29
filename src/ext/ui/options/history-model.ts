import { percentOff } from '../../../shared/money.ts';
import { brl, formatSp } from '../format.ts';

// Modelo de visão do histórico (RF-07). Puro: ordena, formata, deriva selos. Contrato assumido de `history.get`.
export interface ObservationDto {
  observedAt: string; originalCents: number; currentCents: number; available: boolean;
  source: string; confirmed: boolean; degraded?: boolean;
}
export interface NotificationDto {
  key: string; kind: string; createdAt: string;
  desktop: 'pendente' | 'mostrada' | 'falha';
  email: 'desligado' | 'PENDENTE' | 'ACEITO' | 'FALHA';
  simulated?: boolean;
}
export interface HistoryDto { observations: ObservationDto[]; notifications: NotificationDto[]; hasMore?: boolean }

export interface ObsRow {
  when: string; original: string; current: string; discount: string; available: string; source: string;
  confirmed: boolean; note: string; degraded: boolean;
}
export interface NotifRow { key: string; when: string; kind: string; channels: { label: string; tone: 'ok' | 'warn' | 'bad' | 'neutral' }[] }
export interface HistoryView { rows: ObsRow[]; min: string; max: string; confirmedCount: number; notifs: NotifRow[]; empty: boolean }

const t = (iso: string): number => {
  const n = new Date(iso).getTime();
  return Number.isNaN(n) ? -Infinity : n;
};
const KINDS: Record<string, string> = { ATINGIDO: 'Preço atingido', PROXIMO: 'Próximo do alvo', SAUDE: 'Aviso de saúde' };
const SOURCES: Record<string, string> = { occ: 'API da loja', nextdata: 'Página (reserva)' };

/** RF-08: nunca "entregue". Aceito pelo provedor / simulado / mostrada no navegador. */
export function channelLabels(n: Pick<NotificationDto, 'desktop' | 'email' | 'simulated'>): NotifRow['channels'] {
  const out: NotifRow['channels'] = [];
  if (n.desktop === 'mostrada') out.push({ label: 'Mostrada no navegador', tone: 'ok' });
  else if (n.desktop === 'falha') out.push({ label: 'Falha ao mostrar no navegador', tone: 'bad' });
  else out.push({ label: 'Navegador: pendente', tone: 'warn' });
  if (n.email === 'ACEITO') out.push(n.simulated ? { label: 'E-mail simulado (não enviado)', tone: 'neutral' } : { label: 'E-mail aceito pelo provedor', tone: 'ok' });
  else if (n.email === 'PENDENTE') out.push({ label: 'E-mail pendente', tone: 'warn' });
  else if (n.email === 'FALHA') out.push({ label: 'E-mail com falha', tone: 'bad' });
  return out;
}

export function buildHistory(d: HistoryDto): HistoryView {
  const sorted = [...d.observations].sort((a, b) => t(b.observedAt) - t(a.observedAt));
  // RF-07-AC4/5: mínimo e máximo só de confirmadas.
  const conf = sorted.filter((o) => o.confirmed && o.currentCents > 0);
  const prices = conf.map((o) => o.currentCents);
  const rows = sorted.map((o): ObsRow => ({
    when: formatSp(o.observedAt),
    original: brl(o.originalCents),
    current: brl(o.currentCents),
    discount: `${percentOff(o.originalCents, o.currentCents)}%`, // RF-07-AC2: calculado, não lido da loja
    available: o.available ? 'Disponível' : 'Indisponível',
    source: (Object.hasOwn(SOURCES, o.source) ? SOURCES[o.source] : o.source) + (o.degraded ? ' (degradada)' : ''),
    confirmed: o.confirmed,
    note: o.confirmed ? '' : 'não confirmada',
    degraded: !!o.degraded,
  }));
  const notifs = [...d.notifications].sort((a, b) => t(b.createdAt) - t(a.createdAt)).map((n): NotifRow => ({
    key: n.key, when: formatSp(n.createdAt), kind: Object.hasOwn(KINDS, n.kind) ? KINDS[n.kind]! : n.kind, channels: channelLabels(n),
  }));
  return {
    rows, notifs, empty: rows.length === 0, confirmedCount: conf.length,
    min: prices.length ? brl(Math.min(...prices)) : '—',
    max: prices.length ? brl(Math.max(...prices)) : '—',
  };
}
