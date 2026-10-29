import type { Cents, FailureClass, IsoUtc, ProductCode, SourceName, VariantCode } from '../shared/types.ts';

// Contratos de architecture.md 3.3 e 3.6 (price-monitor). Sem implementação.

export type Tx = <T>(fn: () => T) => T; // db.transaction(fn)(): IMMEDIATE, reentrante via savepoint; bloco síncrono

export interface HttpClient {
  get(req: { url: URL; headers?: Record<string, string>; accept: 'json' | 'html' }): Promise<HttpResult>;
}
export type HttpResult =
  | { ok: true; status: number; body: string; contentType: string; retryAfterMs?: number }
  | { ok: false; failure: FailureClass; status?: number; retryAfterMs?: number; body?: string };

export interface VariantSnapshot {
  variantCode: VariantCode;
  size: string;
  ean: string | null;
  originalCents: Cents;
  currentCents: Cents;
  available: boolean;
}
export interface ProductSnapshot {
  code: ProductCode;
  name: string;
  slug: string | null;
  legacySku: string | null;
  source: SourceName;
  degraded: boolean;
  fetchedAt: IsoUtc;
  variants: VariantSnapshot[];
  skippedVariants: number;
}
export interface Failure {
  class: FailureClass;
  httpStatus?: number;
  retryAfterMs?: number;
  rawBody?: string;
}
export type SourceResult =
  | { ok: true; snapshot: ProductSnapshot; httpStatus: number; requests: number }
  | { ok: false; failure: Failure; requests: number };

export interface PriceSource {
  readonly name: SourceName | 'composite' | 'fake';
  fetchProduct(code: ProductCode): Promise<SourceResult>;
}

export type ProductState = 'ativo' | 'removido' | 'formato_desconhecido';
export type RunKind = 'monitor' | 'catalog';
export type RunTrigger = 'scheduled' | 'recovery' | 'manual';
export type RunStatus = 'running' | 'ok' | 'partial' | 'failed' | 'skipped' | 'interrupted';
export type SkipReason =
  | 'anterior_em_andamento'
  | 'circuito_aberto'
  | 'sem_alertas_ativos'
  | 'intervalo_minimo'
  | 'orcamento_diario';
export type ItemSkipReason = 'intervalo_minimo' | 'orcamento_diario' | 'circuito_aberto';
export type RequestPurpose = 'monitor' | 'catalog' | 'discover' | 'probe';

export interface ProductRow {
  code: ProductCode;
  name: string;
  legacySku: string | null;
  lastSlug: string | null;
  state: ProductState;
  consecutiveFailures: number;
  notFoundStreak: number;
  degradedSince: IsoUtc | null;
  lastAttemptAt: IsoUtc | null;
  lastOkAt: IsoUtc | null;
  createdAt: IsoUtc;
  updatedAt: IsoUtc;
}
export interface VariantRow {
  variantCode: VariantCode;
  productCode: ProductCode;
  size: string;
  ean: string | null;
  lastSeenAt: IsoUtc;
}
export interface RunRow {
  id: number;
  kind: RunKind;
  trigger: RunTrigger;
  status: RunStatus;
  skipReason: SkipReason | null;
  startedAt: IsoUtc;
  finishedAt: IsoUtc | null;
  itemsTotal: number;
  itemsOk: number;
  itemsFailed: number;
  requestsMade: number;
  circuitOpened: boolean;
}
export type RunItemInput =
  | {
      productCode: ProductCode;
      seq: number;
      outcome: 'ok' | 'degradado';
      source: SourceName;
      httpStatus?: number;
      requests: number;
      attempts: number;
      durationMs?: number;
      observationsWritten: number;
      finishedAt: IsoUtc;
    }
  | {
      productCode: ProductCode;
      seq: number;
      outcome: 'falha';
      failureClass: FailureClass;
      httpStatus?: number;
      source?: SourceName;
      requests: number;
      attempts: number;
      durationMs?: number;
      finishedAt: IsoUtc;
    }
  | { productCode: ProductCode; seq: number; outcome: 'pulado'; skipReason: ItemSkipReason; finishedAt: IsoUtc };
export interface RunSummary {
  status: 'ok' | 'partial' | 'failed';
  itemsTotal: number;
  itemsOk: number;
  itemsFailed: number;
  requestsMade: number;
  circuitOpened: boolean;
}

export interface ProductRepo {
  upsertProduct(
    p: { code: ProductCode; name: string; legacySku: string | null; slug: string | null },
    now: IsoUtc,
  ): void;
  upsertVariants(
    code: ProductCode,
    vs: { variantCode: VariantCode; size: string; ean: string | null }[],
    now: IsoUtc,
  ): void;
  get(code: ProductCode): ProductRow | null;
  listVariants(code: ProductCode): VariantRow[];
  dueForCollection(now: IsoUtc, minIntervalMs: number): ProductCode[];
  recordSuccess(code: ProductCode, o: { degraded: boolean; now: IsoUtc }): void;
  recordFailure(
    code: ProductCode,
    f: { class: FailureClass; now: IsoUtc },
  ): { consecutiveFailures: number; notFoundStreak: number; state: ProductState };
  setState(code: ProductCode, s: ProductState, now: IsoUtc): void;
  saveFailureSample(
    code: ProductCode,
    s: { runId: number; capturedAt: IsoUtc; httpStatus?: number; contentType?: string; body: string },
  ): void;
  clearFailureSample(code: ProductCode): void;
}
export interface RunRepo {
  tryStart(kind: RunKind, trigger: RunTrigger, now: IsoUtc): { runId: number } | { skipped: 'anterior_em_andamento' };
  recordSkipped(kind: RunKind, trigger: RunTrigger, reason: SkipReason, now: IsoUtc): void;
  addItem(runId: number, item: RunItemInput): void;
  finish(runId: number, summary: RunSummary, now: IsoUtc): void;
  markInterruptedOnStartup(now: IsoUtc): number;
  lastFinished(kind: RunKind): RunRow | null;
  lastSuccessfulItemAt(code: ProductCode): IsoUtc | null;
}
// Tabela outbound_requests; escrita só pelo withRateGate. Teto 400/24 h de qualquer origem (RNF-REL-04).
export interface RequestLog {
  record(purpose: RequestPurpose, now: IsoUtc): void;
  countSince(since: IsoUtc): number;
}
