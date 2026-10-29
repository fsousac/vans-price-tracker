import type { BasisPoints, Cents, FailureClass, IsoUtc, ProductCode, SourceName, VariantCode } from '../shared/types.ts';
import type { AlertRow as OldAlertRow, AlertPatch as OldAlertPatch, NewAlert as OldNewAlert, Decision } from '../alerts/ports.ts';
import type { NotificationKind } from '../notifications/ports.ts';
import type {
  ItemSkipReason, ProductRow, ProductState, RequestPurpose, RunItemInput, RunKind, RunRow as OldRunRow,
  RunSummary, RunTrigger, SkipReason, VariantRow,
} from '../price-monitor/ports.ts';
import type { NewObservation, ObservationRow } from '../price-history/ports.ts';
import type { CatalogItem } from '../catalog/ports.ts';
import type { HealthKind } from '../observability/ports.ts';

// Contratos assíncronos da extensão (extension-architecture.md seções 7-8). Tipos de linha reaproveitados.
export type {
  ProductRow, VariantRow, ProductState, RunItemInput, RunSummary, ItemSkipReason,
  ObservationRow, NewObservation, CatalogItem, Decision,
};
export { AlertDuplicate, VariantNotFound } from '../alerts/ports.ts';

/** Chave/índice único ou invariante (CHECK/FK) violado. */
export class StoreConstraintError extends Error {
  readonly constraint: string;
  constructor(constraint: string, message = constraint) {
    super(message);
    this.name = 'StoreConstraintError';
    this.constraint = constraint;
  }
}

/** Transação ambiente e exclusiva; fn rejeitar = rollback. Dentro dela: só Db e cálculo puro (nunca fetch/sleep/chrome). */
export type Tx = <T>(fn: () => Promise<T>) => Promise<T>;

// ---- produtos ----
export interface ProductRepo {
  upsertProduct(p: { code: ProductCode; name: string; legacySku: string | null; slug: string | null }, now: IsoUtc): Promise<void>;
  upsertVariants(code: ProductCode, vs: { variantCode: VariantCode; size: string; ean: string | null }[], now: IsoUtc): Promise<void>;
  get(code: ProductCode): Promise<ProductRow | null>;
  listVariants(code: ProductCode): Promise<VariantRow[]>;
  getVariant(v: VariantCode): Promise<VariantRow | null>;
  dueForCollection(now: IsoUtc, minIntervalMs: number): Promise<ProductCode[]>; // só com alerta ATIVO
  recordSuccess(code: ProductCode, o: { degraded: boolean; now: IsoUtc }): Promise<void>;
  recordFailure(
    code: ProductCode,
    f: { class: FailureClass; now: IsoUtc },
  ): Promise<{ consecutiveFailures: number; notFoundStreak: number; state: ProductState }>;
  setState(code: ProductCode, s: ProductState, now: IsoUtc): Promise<void>;
  saveFailureSample(
    code: ProductCode,
    s: { runId: number; capturedAt: IsoUtc; httpStatus?: number; contentType?: string; body: string },
  ): Promise<void>;
  clearFailureSample(code: ProductCode): Promise<void>;
}

// ---- rodadas retomáveis (EA seção 6) ----
export interface RunRow extends OldRunRow {
  queue: ProductCode[]; // congelada no início
  heartbeatAt: IsoUtc | null;
  resumeAt: IsoUtc | null;
}
export type ClaimResult =
  | { action: 'started'; run: RunRow }
  | { action: 'resumed'; run: RunRow } // lease vencida e idade <= maxResumeAgeMs
  | { action: 'busy' }; // lease viva
export interface RunRepo {
  /**
   * Atômico: nenhuma 'running' => cria com a fila; lease vencida => retoma; mais velha que
   * maxResumeAgeMs => fecha 'interrupted' e cria nova; lease viva => busy.
   */
  claim(a: {
    kind: RunKind;
    trigger: RunTrigger;
    queue: ProductCode[];
    now: IsoUtc;
    leaseMs: number;
    maxResumeAgeMs: number;
  }): Promise<ClaimResult>;
  heartbeat(runId: number, now: IsoUtc): Promise<void>;
  setResumeAt(runId: number, at: IsoUtc | null): Promise<void>;
  recordSkipped(kind: RunKind, trigger: RunTrigger, reason: SkipReason, now: IsoUtc): Promise<void>;
  /** Idempotente: (runId, productCode) já presente => false e nada grava. */
  addItem(runId: number, item: RunItemInput): Promise<boolean>;
  doneCodes(runId: number): Promise<ProductCode[]>; // cursor = códigos com item
  finish(runId: number, summary: RunSummary, now: IsoUtc): Promise<void>;
  getRunning(kind: RunKind): Promise<RunRow | null>;
  lastFinished(kind: RunKind): Promise<RunRow | null>;
  lastSuccessfulItemAt(code: ProductCode): Promise<IsoUtc | null>;
}

export interface RequestLog {
  record(purpose: RequestPurpose, now: IsoUtc): Promise<void>;
  countSince(since: IsoUtc): Promise<number>;
}

// ---- alertas (sem e-mail: passou aos settings) ----
export type AlertRow = Omit<OldAlertRow, 'email'>;
export type NewAlert = Omit<OldNewAlert, 'email'>;
export type AlertPatch = Omit<OldAlertPatch, 'email'>;
export interface AlertRepo {
  create(a: NewAlert, now: IsoUtc): Promise<number>; // lança AlertDuplicate | VariantNotFound
  get(id: number): Promise<AlertRow | null>;
  list(): Promise<AlertRow[]>;
  activeByProduct(code: ProductCode): Promise<AlertRow[]>;
  update(id: number, patch: AlertPatch, now: IsoUtc): Promise<void>;
  applyDecision(id: number, next: Decision['next'], fire: Decision['fire'], now: IsoUtc): Promise<void>;
  delete(id: number): Promise<void>; // cascata em notifications
}

// ---- notificações: canais desktop e e-mail ----
export type DesktopStatus = 'pendente' | 'mostrada' | 'falha';
export type EmailStatus = 'desligado' | 'PENDENTE' | 'ACEITO' | 'FALHA';
export interface NewNotification {
  key: string; // 'alertId|revision|tipo|episodio' ou 'saude|id'
  alertId: number | null;
  healthEventId: number | null;
  observationId: number | null;
  kind: NotificationKind;
  emailEnabled: boolean; // false => email 'desligado'
  mode: 'real' | 'teste';
  productCode: ProductCode | null;
  productName: string | null;
  productSlug: string | null;
  size: string | null;
  priceCents: Cents | null;
  targetCents: Cents | null;
  marginBp: BasisPoints | null;
  observedAt: IsoUtc | null;
  source: SourceName | null;
  degraded: boolean;
  alreadyInBand: boolean;
  now: IsoUtc;
}
export interface NotificationRow extends Omit<NewNotification, 'now' | 'emailEnabled'> {
  desktop: DesktopStatus;
  email: EmailStatus;
  simulated: boolean;
  attempts: number;
  nextAttemptAt: IsoUtc | null;
  providerMessageId: string | null;
  acceptedAt: IsoUtc | null;
  failureReason: string | null;
  createdAt: IsoUtc;
  updatedAt: IsoUtc;
}
export interface NotificationRepo {
  insertIfAbsent(n: NewNotification): Promise<{ created: boolean }>;
  get(key: string): Promise<NotificationRow | null>;
  listPendingDesktop(limit: number): Promise<NotificationRow[]>;
  markDesktop(key: string, s: 'mostrada' | 'falha', reason: string | null, now: IsoUtc): Promise<void>;
  claimDue(now: IsoUtc, limit: number): Promise<NotificationRow[]>; // só e-mail; attempts++ e lease antes de devolver
  markAccepted(key: string, r: { providerMessageId: string; now: IsoUtc; simulated: boolean }): Promise<void>;
  markAttemptFailed(key: string, r: { nextAttemptAt: IsoUtc | null; reason: string; now: IsoUtc }): Promise<void>; // null => FALHA
  resend(key: string, now: IsoUtc): Promise<boolean>;
  listForAlert(alertId: number): Promise<NotificationRow[]>;
  nextAttemptAt(): Promise<IsoUtc | null>; // menor, para o alarme 'outbox'
}

// ---- histórico, catálogo, saúde, kv ----
export interface ObservationRepo {
  insert(o: NewObservation): Promise<number>; // lança StoreConstraintError em [runId, variantCode, seq] repetido
  confirm(id: number, confirmedBy: number): Promise<void>;
  latestConfirmed(v: VariantCode): Promise<ObservationRow | null>;
  latestUnconfirmed(v: VariantCode): Promise<ObservationRow | null>;
  history(v: VariantCode, limit: number, offset: number): Promise<ObservationRow[]>;
  stats(v: VariantCode): Promise<{ minCents: Cents; maxCents: Cents; count: number } | null>; // só confirmadas
}
export interface CatalogRepo {
  putPage(gen: number, items: CatalogItem[]): Promise<void>; // invisível até commitGen
  commitGen(gen: number, now: IsoUtc): Promise<void>; // troca catalog_gen e apaga a geração antiga
  search(q: string, limit: number): Promise<CatalogItem[]>;
  count(): Promise<number>;
}
export interface HealthEventRepo {
  open(kind: HealthKind, subject: string, detail: string | null, now: IsoUtc): Promise<{ id: number; created: boolean }>;
  close(kind: HealthKind, subject: string, now: IsoUtc): Promise<void>;
  listOpen(): Promise<{ id: number; kind: HealthKind; subject: string; detail: string | null; openedAt: IsoUtc }[]>;
}
export type KvKey =
  | 'settings' | 'circuit_open_until' | 'circuit_reason' | 'circuit_probe_pending'
  | 'catalog_gen' | 'catalog_refreshed_at' | 'catalog_cursor' | 'last_tick_at';
export interface KvRepo {
  get(key: KvKey): Promise<string | null>;
  set(key: KvKey, value: string): Promise<void>;
  delete(key: KvKey): Promise<void>;
}
