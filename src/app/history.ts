import { freshness, type Freshness } from '../shared/freshness.ts';
import type { Clock } from '../shared/clock.ts';
import type { Cents, VariantCode } from '../shared/types.ts';
import type { ObservationRepo, ObservationRow } from '../store/ports.ts';

export interface SeriesPoint extends ObservationRow {
  discountPct: number; // calculado (RF-07-AC2), nunca lido da loja
}
export interface HistorySummary {
  points: SeriesPoint[]; // decrescente; UTC (fuso só na view)
  minCents: Cents | null; // só confirmadas (RF-07-AC4/5)
  maxCents: Cents | null;
  confirmedCount: number;
  lastConfirmedAt: string | null;
  freshness: Freshness;
}

// ponytail: trunca (649,99 -> 379,99 = 41%, como RF-07-AC2); shared/percentOff arredonda.
export const discountPct = (orig: Cents, cur: Cents): number =>
  orig > 0 && cur < orig ? Math.floor(((orig - cur) * 100) / orig) : 0;

export function createHistoryService(repo: ObservationRepo, clock: Clock) {
  const series = async (v: VariantCode, limit = 100, offset = 0): Promise<SeriesPoint[]> =>
    (await repo.history(v, limit, offset)).map((o) => ({ ...o, discountPct: discountPct(o.originalCents, o.currentCents) }));

  return {
    series,
    async summary(v: VariantCode, intervalMs: number, limit = 100, offset = 0): Promise<HistorySummary> {
      const [stats, last, points] = await Promise.all([repo.stats(v), repo.latestConfirmed(v), series(v, limit, offset)]);
      return {
        points,
        minCents: stats?.minCents ?? null,
        maxCents: stats?.maxCents ?? null,
        confirmedCount: stats?.count ?? 0,
        lastConfirmedAt: last?.observedAt ?? null,
        freshness: freshness(last?.observedAt, clock.now(), intervalMs),
      };
    },
    /** RN-09c: leitura pendente passa a confirmada pela que concordou. */
    confirmLater: (pendingId: number, confirmedBy: number) => repo.confirm(pendingId, confirmedBy),
  };
}
