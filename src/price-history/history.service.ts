import { freshness, type Freshness } from '../shared/freshness.ts';
import type { Clock } from '../shared/clock.ts';
import type { Cents, VariantCode } from '../shared/types.ts';
import type { ObservationRepo, ObservationRow } from './ports.ts';

export interface SeriesPoint extends ObservationRow {
  discountPct: number; // calculado (RF-07-AC2), nunca lido de percentualOfDiscount
}
export interface HistorySummary {
  points: SeriesPoint[]; // ordem decrescente; horários em UTC (fuso só na borda, na view)
  minCents: Cents | null; // só confirmadas (RF-07-AC4/5)
  maxCents: Cents | null;
  confirmedCount: number;
  lastConfirmedAt: string | null;
  freshness: Freshness;
}

// ponytail: trunca (Hylane 649,99 -> 379,99 = 41,54% -> 41, como em RF-07-AC2); shared/percentOff arredonda (42)
const discountPct = (orig: Cents, cur: Cents): number => (orig > 0 && cur < orig ? Math.floor(((orig - cur) * 100) / orig) : 0);

export class HistoryService {
  readonly #repo: ObservationRepo;
  readonly #clock: Clock;
  constructor(repo: ObservationRepo, clock: Clock) {
    this.#repo = repo;
    this.#clock = clock;
  }

  series(v: VariantCode, limit = 100, offset = 0): SeriesPoint[] {
    return this.#repo.history(v, limit, offset).map((o) => ({ ...o, discountPct: discountPct(o.originalCents, o.currentCents) }));
  }

  summary(v: VariantCode, intervalMs: number, limit = 100, offset = 0): HistorySummary {
    const stats = this.#repo.stats(v);
    const last = this.#repo.latestConfirmed(v);
    return {
      points: this.series(v, limit, offset),
      minCents: stats?.minCents ?? null,
      maxCents: stats?.maxCents ?? null,
      confirmedCount: stats?.count ?? 0,
      lastConfirmedAt: last?.observedAt ?? null,
      freshness: freshness(last?.observedAt, this.#clock.now(), intervalMs),
    };
  }

  // confirmação posterior (RN-09c): leitura pendente passa a confirmada pela que concordou
  confirmLater(pendingId: number, confirmedBy: number): void {
    this.#repo.confirm(pendingId, confirmedBy);
  }
}
