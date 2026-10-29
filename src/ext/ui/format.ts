import { formatBrl } from '../../shared/money.ts';

export { formatBrl };

const SP = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

export const brl = (cents: number | null | undefined): string => (cents == null ? '—' : formatBrl(cents));

/** ISO/Date -> '15/10/2026 14:30' em America/Sao_Paulo; inválido/ausente -> '—'. */
export function formatSp(d: Date | string | number | null | undefined): string {
  if (d == null) return '—';
  const t = new Date(d);
  if (Number.isNaN(t.getTime())) return '—';
  return SP.format(t).replace(', ', ' ');
}

// Selos sempre têm texto (não só cor). Estado desconhecido cai em neutro, nunca em "ok".
export type Tone = 'ok' | 'warn' | 'bad' | 'neutral';
const BADGES: Record<string, [string, Tone]> = {
  ativo: ['Ativo', 'ok'], pausado: ['Pausado', 'neutral'], pendente: ['Pendente', 'warn'],
  fresco: ['Atualizado', 'ok'], defasado: ['Defasado', 'warn'], sem_dados: ['Sem dados', 'neutral'],
  disponivel: ['Disponível', 'ok'], indisponivel: ['Indisponível', 'warn'],
  confirmado: ['Confirmado', 'ok'], nao_confirmado: ['Não confirmada', 'warn'],
  fechado: ['Circuito fechado', 'ok'], aberto: ['Circuito aberto', 'bad'], meio_aberto: ['Circuito em teste', 'warn'],
  mostrada: ['Mostrada', 'ok'], ACEITO: ['Aceito pelo provedor', 'ok'], PENDENTE: ['Pendente', 'warn'], FALHA: ['Falha', 'bad'],
  falha: ['Falha', 'bad'], desligado: ['Desligado', 'neutral'],
};
export function badge(state: string): { text: string; tone: Tone } {
  const hit = Object.hasOwn(BADGES, state) ? BADGES[state] : undefined;
  const [text, tone] = hit ?? [state === '' ? '—' : state, 'neutral'];
  return { text, tone };
}
