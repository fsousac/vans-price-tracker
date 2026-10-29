import type { Clock } from '../shared/clock.ts';
import { freshness } from '../shared/freshness.ts';
import type { HealthReadRepo } from './health.repo.ts';
import type { StateRepo } from './ports.ts';

export interface HealthDeps {
  repo: HealthReadRepo;
  state: StateRepo;
  clock: Clock;
  version: string;
  emailMode: 'real' | 'teste';
  intervalMs: number; // I
  startedAt: Date; // início do processo (RF-12-AC2: "nunca" rodou, app no ar há > 2*I)
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Payload de /saude (RF-12-AC1): só contadores e estados; nenhum e-mail, nome, segredo ou corpo de loja.
export function buildHealth(d: HealthDeps) {
  const now = d.clock.now();
  const until = d.state.get('circuit_open_until');
  const circuitOpen = until !== null && new Date(until).getTime() > now.getTime();
  const lastRun = d.repo.lastFinishedRun();
  const ref = lastRun ? new Date(lastRun.finished_at) : d.startedAt;
  const late = d.repo.activeAlertCount() > 0 && now.getTime() - ref.getTime() > 2 * d.intervalMs;

  const fresh = { fresco: 0, defasado: 0, sem_dados: 0 };
  for (const at of d.repo.activeAlertLastConfirmed()) fresh[freshness(at, now, d.intervalMs)]++;

  const items = d.repo.itemsSince(new Date(now.getTime() - DAY_MS).toISOString());
  const lastObs = d.repo.lastObservationAt();
  return {
    version: d.version,
    now: now.toISOString(),
    scheduler: {
      status: circuitOpen ? 'pausado_circuito' : late ? 'atrasado' : 'ok',
      last_run: lastRun,
      heartbeat_at: d.state.get('scheduler_heartbeat_at'),
    },
    circuit: {
      open: circuitOpen,
      reason: circuitOpen ? d.state.get('circuit_reason') : null,
      until: circuitOpen ? until : null,
    },
    freshness: fresh,
    email_mode: d.emailMode,
    counters: {
      runs_by_status: d.repo.runsByStatus(),
      items_24h: { ok: items.ok, failed_by_class: items.failedByClass },
      observations_by_source: d.repo.observationsBySource(),
      notifications_by_status: d.repo.notificationsByStatus(),
      last_observation_age_s: lastObs ? Math.max(0, Math.floor((now.getTime() - new Date(lastObs).getTime()) / 1000)) : null,
    },
  };
}
