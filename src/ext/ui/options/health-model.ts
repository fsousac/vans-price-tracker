import { freshness, type Freshness } from '../../../shared/freshness.ts';
import { badge, formatSp, type Tone } from '../format.ts';

// Modelo de visão da saúde (RF-12). Puro. Contrato assumido de `health.get`; sem PII.
export interface HealthDto {
  lastRun: { status: string; startedAt: string; finishedAt: string | null; ok: number; failed: number; skipped: number; skipReason?: string | null } | null;
  circuit: { openUntil: string | null; reason: string | null; probePending?: boolean };
  /** Última observação confirmada por variante ativa (ISO) ou null. */
  lastConfirmed: (string | null)[];
  intervalMs: number;
  budget: { used: number; limit: number };
  openEvents: { kind: string; subject: string; since: string }[];
  emailMode: string;
}

const RUN: Record<string, [string, Tone]> = {
  ok: ['Concluída', 'ok'], partial: ['Parcial', 'warn'], failed: ['Falhou', 'bad'],
  skipped: ['Pulada', 'neutral'], interrupted: ['Interrompida', 'warn'], running: ['Em andamento', 'neutral'],
};
const REASONS: Record<string, string> = {
  http_403_ou_desafio: 'a loja bloqueou o acesso (403 ou desafio)',
  http_429: 'a loja pediu para reduzir o ritmo (429)',
  rede_timeout: 'falhas repetidas de rede',
  circuito_aberto: 'circuito aberto', orcamento_diario: 'orçamento diário esgotado',
  sem_alertas_ativos: 'sem alertas ativos', intervalo_minimo: 'intervalo mínimo ainda não passou',
  anterior_em_andamento: 'outra rodada em andamento',
};
const reason = (r: string | null | undefined): string => (!r ? 'motivo não informado' : Object.hasOwn(REASONS, r) ? REASONS[r]! : r);

export interface HealthView {
  banner: string;
  run: { label: string; tone: Tone; started: string; finished: string; counts: string; note: string } | null;
  circuit: { state: 'fechado' | 'aberto' | 'meio_aberto'; text: string; reason: string };
  fresh: Record<Freshness, number>;
  stale: boolean;
  budget: { text: string; percent: number; exhausted: boolean };
  events: { kind: string; subject: string; since: string }[];
  email: string;
}

export function buildHealth(d: HealthDto, now: Date): HealthView {
  const until = d.circuit.openUntil ? new Date(d.circuit.openUntil).getTime() : NaN;
  const open = !Number.isNaN(until) && until > now.getTime();
  const state = open ? 'aberto' : d.circuit.probePending ? 'meio_aberto' : 'fechado';
  const fresh: Record<Freshness, number> = { fresco: 0, defasado: 0, sem_dados: 0 };
  for (const x of d.lastConfirmed) fresh[freshness(x, now, d.intervalMs)]++;
  const { used, limit } = d.budget;
  const run = d.lastRun;
  const [label, tone]: [string, Tone] = run ? (Object.hasOwn(RUN, run.status) ? RUN[run.status]! : [run.status, 'neutral']) : ['', 'neutral'];
  return {
    banner: 'O monitoramento só roda com o navegador aberto; ao abrir, a extensão recupera o que ficou atrasado.',
    run: run && {
      label, tone, started: formatSp(run.startedAt), finished: formatSp(run.finishedAt),
      counts: `${run.ok} ok, ${run.failed} com falha, ${run.skipped} pulados`,
      note: run.status === 'skipped' ? `Motivo: ${reason(run.skipReason)}` : '',
    },
    circuit: {
      state,
      text: badge(state).text,
      reason: open ? `Aberto até ${formatSp(d.circuit.openUntil)}: ${reason(d.circuit.reason)}.`
        : state === 'meio_aberto' ? 'Aguardando uma leitura de teste.' : 'Coleta liberada.',
    },
    fresh,
    stale: fresh.defasado + fresh.sem_dados > 0,
    budget: {
      text: `${used} de ${limit} requisições nas últimas 24 h`,
      percent: limit > 0 ? Math.min(100, Math.round((used * 100) / limit)) : 100,
      exhausted: limit <= 0 || used >= limit,
    },
    events: d.openEvents.map((e) => ({ kind: e.kind, subject: e.subject, since: formatSp(e.since) })),
    email: d.emailMode === 'real' ? 'Real' : 'Teste (não envia)',
  };
}
