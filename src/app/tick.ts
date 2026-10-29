// Tick do alarme periódico (15 min): drena notificações vencidas e decide se a rodada venceu (EA seção 5).
import type { Settings } from '../settings/settings.ts';
import type { Clock } from '../shared/clock.ts';
import type { KvRepo, RunRepo } from '../store/ports.ts';
import type { Round, RoundResult } from './round.ts';

export const TICK_MS = 15 * 60_000;
export const RECOVERY_GAP_MS = 3 * TICK_MS; // tick atrasado além disso = o computador dormiu: gatilho 'recovery'
export const JITTER_FRAC = 0.1;

// FNV-1a 32 bits: determinístico e sem node:crypto (o bundle do SW não pode importar node:*).
const fnv = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
};

/** Instante em que a próxima rodada vence: início da última rodada não pulada + I, I com jitter +-10% fixo por `startedAt`. */
export function nextRoundAt(lastStartedAt: string, intervalHours: number): number {
  const f = fnv(lastStartedAt) / 4294967296; // [0,1)
  return Math.round(Date.parse(lastStartedAt) + intervalHours * 3_600_000 * (1 + JITTER_FRAC * (2 * f - 1)));
}

export interface TickDeps {
  round: Pick<Round, 'resumeOrStart'>;
  runs: Pick<RunRepo, 'getRunning' | 'lastFinished'>;
  settings: { get(): Promise<Settings> };
  kv: Pick<KvRepo, 'get' | 'set'>;
  notifications: { drain(): Promise<unknown> };
  clock: Clock;
}
export type TickResult = { round: RoundResult | null };

export function createTick(d: TickDeps): () => Promise<TickResult> {
  return async () => {
    const now = d.clock.now().getTime();
    const prev = await d.kv.get('last_tick_at');
    await d.kv.set('last_tick_at', new Date(now).toISOString());
    await d.notifications.drain(); // outbox vencido não espera a rodada

    // Rodada `running` (lease vencida ou viva): quem decide é resumeOrStart; ela nunca coexiste com outra.
    const running = await d.runs.getRunning('monitor');
    const last = running ?? (await d.runs.lastFinished('monitor'));
    if (!running && last) {
      const { intervalHours } = await d.settings.get();
      if (now < nextRoundAt(last.startedAt, intervalHours)) return { round: null };
    }
    // Vencido é um instante, não uma contagem: voltar do sono dispara no máximo 1 rodada.
    const trigger = prev !== null && now - Date.parse(prev) > RECOVERY_GAP_MS ? 'recovery' : 'scheduled';
    return { round: await d.round.resumeOrStart(trigger) };
  };
}
