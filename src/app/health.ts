import { freshness } from '../shared/freshness.ts';
import type { Clock } from '../shared/clock.ts';
import type { HealthEventRepo, KvRepo, RequestLog } from '../store/ports.ts';
import type { HealthReadStore } from '../store/health.store.ts';
import { DAILY_BUDGET } from './rate-gate.ts';

export interface HealthDeps {
  read: HealthReadStore;
  kv: KvRepo;
  events: HealthEventRepo;
  requests: RequestLog;
  clock: Clock;
  version: string;
  intervalMs: number; // I
  installedAt: Date; // referência quando nunca rodou (RF-12-AC2)
  emailMode: 'real' | 'teste' | 'desligado';
}

const DAY_MS = 24 * 3_600_000;

// Payload de saúde (RF-12-AC1): só contadores e estados; sem e-mail, chave, nome, URL ou corpo de loja (RNF-OBS).
export async function buildHealth(d: HealthDeps) {
  const now = d.clock.now();
  const [until, reason, lastTick, lastRun, active, confirmed, runs, items, bySource, notifs, lastObs, open, used] = await Promise.all([
    d.kv.get('circuit_open_until'), d.kv.get('circuit_reason'), d.kv.get('last_tick_at'),
    d.read.lastFinishedRun(), d.read.activeAlertCount(), d.read.activeAlertLastConfirmed(),
    d.read.runsByStatus(), d.read.itemsSince(new Date(now.getTime() - DAY_MS).toISOString()),
    d.read.observationsBySource(), d.read.notificationsByStatus(), d.read.lastObservationAt(),
    d.events.listOpen(), d.requests.countSince(new Date(now.getTime() - DAY_MS).toISOString()),
  ]);
  const circuitOpen = until !== null && Date.parse(until) > now.getTime();
  const ref = lastRun ? Date.parse(lastRun.finishedAt) : d.installedAt.getTime();
  const late = active > 0 && now.getTime() - ref > 2 * d.intervalMs;

  const fresh = { fresco: 0, defasado: 0, sem_dados: 0 };
  for (const at of confirmed) fresh[freshness(at, now, d.intervalMs)]++;

  return {
    version: d.version,
    now: now.toISOString(),
    scheduler: {
      status: circuitOpen ? 'pausado_circuito' : late ? 'atrasado' : 'ok',
      lastRun,
      lastTickAt: lastTick,
    },
    circuit: { open: circuitOpen, reason: circuitOpen ? reason : null, until: circuitOpen ? until : null },
    freshness: fresh,
    budget24h: { used, limit: DAILY_BUDGET, remaining: Math.max(0, DAILY_BUDGET - used) },
    openEvents: open.map((e) => ({ id: e.id, kind: e.kind, subject: e.subject, openedAt: e.openedAt })),
    emailMode: d.emailMode,
    counters: {
      runsByStatus: runs,
      items24h: { ok: items.ok, failedByClass: items.failedByClass },
      observationsBySource: bySource,
      notificationsByStatus: notifs,
      lastObservationAgeS: lastObs ? Math.max(0, Math.floor((now.getTime() - Date.parse(lastObs)) / 1000)) : null,
    },
  };
}
