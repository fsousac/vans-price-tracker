import type { Db } from '../db/connection.ts';
import type { IsoUtc } from '../shared/types.ts';

export interface LastRun {
  status: string;
  trigger: string;
  started_at: IsoUtc;
  finished_at: IsoUtc;
  items_ok: number;
  items_failed: number;
}

// Única exceção de fronteira (implementation-plan): leituras SOMENTE LEITURA que agregam tabelas de outros módulos.
export interface HealthReadRepo {
  lastFinishedRun(): LastRun | null; // última rodada de monitor não pulada e concluída
  activeAlertCount(): number;
  activeAlertLastConfirmed(): (IsoUtc | null)[]; // por alerta ATIVO: última observação confirmada da variante
  runsByStatus(): Record<string, number>;
  itemsSince(since: IsoUtc): { ok: number; failedByClass: Record<string, number> };
  observationsBySource(): Record<string, number>;
  notificationsByStatus(): Record<string, number>;
  lastObservationAt(): IsoUtc | null;
}

export function createHealthReadRepo(db: Db): HealthReadRepo {
  const rows = (sql: string, ...p: unknown[]) => db.prepare(sql).all(...(p as never[])) as Record<string, unknown>[];
  const one = (sql: string) => db.prepare(sql).get() as Record<string, unknown> | undefined;
  const tally = (sql: string, ...p: unknown[]): Record<string, number> =>
    Object.fromEntries(rows(sql, ...p).map((r) => [String(r.k), Number(r.n)]));
  return {
    lastFinishedRun: () =>
      (one(`SELECT status, trigger, started_at, finished_at, items_ok, items_failed FROM monitoring_runs
            WHERE kind = 'monitor' AND finished_at IS NOT NULL AND status <> 'skipped'
            ORDER BY finished_at DESC, id DESC LIMIT 1`) as unknown as LastRun | undefined) ?? null,
    activeAlertCount: () => Number(one("SELECT count(*) AS n FROM price_alerts WHERE status = 'ATIVO'")?.n ?? 0),
    activeAlertLastConfirmed: () =>
      rows(`SELECT (SELECT max(o.observed_at) FROM price_observations o
                    WHERE o.variant_code = a.variant_code AND o.confirmed = 1) AS at
            FROM price_alerts a WHERE a.status = 'ATIVO'`).map((r) => (r.at as IsoUtc | null) ?? null),
    runsByStatus: () => tally('SELECT status AS k, count(*) AS n FROM monitoring_runs GROUP BY status'),
    itemsSince(since) {
      const by = tally(
        `SELECT coalesce(failure_class, outcome) AS k, count(*) AS n FROM run_items
         WHERE finished_at >= ? AND outcome IN ('ok','degradado','falha') GROUP BY k`,
        since,
      );
      const ok = (by.ok ?? 0) + (by.degradado ?? 0);
      delete by.ok;
      delete by.degradado;
      return { ok, failedByClass: by };
    },
    observationsBySource: () => tally('SELECT source AS k, count(*) AS n FROM price_observations GROUP BY source'),
    notificationsByStatus: () => tally('SELECT status AS k, count(*) AS n FROM notifications GROUP BY status'),
    lastObservationAt: () => (one('SELECT max(observed_at) AS at FROM price_observations')?.at as IsoUtc | null) ?? null,
  };
}
