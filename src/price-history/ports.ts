import type { Cents, IsoUtc, SourceName, VariantCode } from '../shared/types.ts';

export interface NewObservation {
  variantCode: VariantCode;
  runId: number;
  seq: number;
  observedAt: IsoUtc;
  originalCents: Cents;
  currentCents: Cents;
  available: boolean;
  confirmed: boolean;
  degraded: boolean;
  source: SourceName;
}
export interface ObservationRow extends NewObservation {
  id: number;
  confirmedBy: number | null;
}

export interface ObservationRepo {
  insert(o: NewObservation): number; // lança em UNIQUE(run_id,variant_code,seq)
  confirm(id: number, confirmedBy: number): void;
  latestConfirmed(v: VariantCode): ObservationRow | null;
  latestUnconfirmed(v: VariantCode): ObservationRow | null;
  history(v: VariantCode, limit: number, offset: number): ObservationRow[];
  stats(v: VariantCode): { minCents: Cents; maxCents: Cents; count: number } | null; // só confirmadas
}
