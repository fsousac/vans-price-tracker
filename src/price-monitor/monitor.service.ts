// Único orquestrador do ciclo de UM produto (architecture.md 4): resultado da fonte -> persistir -> avaliar -> notificar.
import { evaluateAlert } from '../alerts/evaluate.ts';
import type { AlertRepo, AlertRow } from '../alerts/ports.ts';
import type { AlertService } from '../alerts/alerts.service.ts';
import type { NotificationService } from '../notifications/notifications.service.ts';
import type { HealthEventRepo, HealthKind } from '../observability/ports.ts';
import type { Logger } from '../observability/logger.ts';
import type { ObservationRepo, ObservationRow } from '../price-history/ports.ts';
import type { CircuitStore } from '../scheduler/circuit.ts';
import type { Clock } from '../shared/clock.ts';
import { stripControl } from '../shared/mask.ts';
import { err, ok, type Result } from '../shared/result.ts';
import type { FailureClass, IsoUtc, ProductCode } from '../shared/types.ts';
import { decideConfirmation, type ConfirmDecision } from './confirm.ts';
import { BudgetExceededError } from './http/rate-gate.ts';
import type {
  Failure,
  PriceSource,
  ProductRepo,
  ProductRow,
  ProductSnapshot,
  ProductState,
  RunRepo,
  SourceResult,
  Tx,
  VariantRow,
} from './ports.ts';
import { sanitizeBody } from './sanitize.ts';

export const COOLDOWN_MS = 24 * 3_600_000; // D-11 (rearme)
export const DISCOVER_MAX_AGE_MS = 2 * 3_600_000; // RF-02-AC8
const FAILURES_FOR_HEALTH = 3; // RF-11-AC7
const SAMPLE_CLASSES: ReadonlySet<FailureClass> = new Set(['formato_desconhecido', 'preco_invalido', 'http_5xx']);
// Violação causada por DADO da loja (nome > 300, tamanho > 10...). UNIQUE/PK não entram: são bug nosso.
const STORE_DATA_VIOLATIONS: ReadonlySet<string> = new Set([
  'SQLITE_CONSTRAINT_CHECK',
  'SQLITE_CONSTRAINT_FOREIGNKEY',
  'SQLITE_CONSTRAINT_NOTNULL',
]);

// ponytail: resetFailures ainda não existe em ProductRepo (T24); ver contrato pedido no retorno.
export type MonitorProductRepo = ProductRepo & { resetFailures(code: ProductCode, now: IsoUtc): void };

export interface MonitorDeps {
  source: PriceSource; // usado só por discoverProduct; a rodada passa o resultado a processResult
  products: MonitorProductRepo;
  observations: ObservationRepo;
  alerts: AlertRepo;
  alertService: Pick<AlertService, 'apply'>;
  notifications: Pick<NotificationService, 'enqueue'>;
  runs: RunRepo;
  health: HealthEventRepo;
  circuit: CircuitStore;
  clock: Clock;
  log: Logger;
  tx: Tx;
  confirmReread: boolean; // CONFIRM_REREAD
}

export interface ProcessOpts {
  itemSeq?: number; // posição na rodada (run_items.seq); padrão 1
  attempts?: number;
  durationMs?: number;
  seq?: 1 | 2; // 2 = releitura de confirmação: só observações, sem run_item nem contadores
}
export type ProcessOutcome =
  | { ok: true; degraded: boolean; observationsWritten: number; notificationsCreated: number; needsReread: boolean }
  | { ok: false; failureClass: FailureClass; state: ProductState; consecutiveFailures: number };

export interface Discovered {
  product: ProductRow;
  variants: VariantRow[];
  fromCache: boolean;
}
export type DiscoverError =
  | { reason: 'circuito_aberto' }
  | { reason: 'orcamento_diario' }
  | { reason: 'falha'; failureClass: FailureClass };

const isStoreDataViolation = (e: unknown): boolean => STORE_DATA_VIOLATIONS.has((e as { code?: string }).code ?? '');

export class MonitorService {
  readonly #d: MonitorDeps;
  constructor(deps: MonitorDeps) {
    this.#d = deps;
  }

  #now = (): IsoUtc => this.#d.clock.now().toISOString();

  // NENHUM await aqui dentro: uma transação síncrona por chamada; alertas lidos dentro dela.
  processResult(runId: number, code: ProductCode, result: SourceResult, o: ProcessOpts = {}): ProcessOutcome {
    const seq = o.seq ?? 1;
    if (!result.ok) return this.#failure(runId, code, result.failure, result.requests, o);
    try {
      return this.#d.tx(() => this.#success(runId, code, result, seq, o));
    } catch (e) {
      if (!isStoreDataViolation(e)) throw e; // rollback já feito; falha injetada/bug segue para o chamador
      this.#d.log.warn('dado_da_loja_invalido', { run_id: runId, product_code: code, failure_class: 'formato_desconhecido' });
      return this.#failure(runId, code, { class: 'formato_desconhecido', httpStatus: result.httpStatus }, result.requests, o);
    }
  }

  #success(runId: number, code: ProductCode, r: Extract<SourceResult, { ok: true }>, seq: 1 | 2, o: ProcessOpts): ProcessOutcome {
    const { products, observations, alerts, health } = this.#d;
    const snap = r.snapshot;
    const now = this.#now();
    if (seq === 1) {
      this.#persistProduct(code, snap, now);
      products.clearFailureSample(code);
      health.close('produto_com_falha', code, now);
      if (snap.degraded) this.#notifyOnce('parser_degradado', code, now);
      else health.close('parser_degradado', code, now);
    }

    const byVariant = new Map<string, AlertRow[]>();
    for (const a of alerts.activeByProduct(code)) byVariant.set(a.variantCode, [...(byVariant.get(a.variantCode) ?? []), a]);

    let written = 0;
    let created = 0;
    let needsReread = false;
    for (const v of snap.variants) {
      const mine = byVariant.get(v.variantCode) ?? [];
      const last = observations.latestConfirmed(v.variantCode);
      let pend = observations.latestUnconfirmed(v.variantCode);
      if (pend && last && pend.id < last.id) pend = null; // pendente mais velha que a confirmada nunca confirma
      if (seq === 2 ? !pend : mine.length === 0 && !last && !pend) continue; // sem alerta e nunca observada

      let dec: ConfirmDecision = decideConfirmation({
        candidate: { currentCents: v.currentCents, source: snap.source, observedAt: snap.fetchedAt },
        lastConfirmed: last,
        pendingUnconfirmed: pend,
      });
      // RF-11-AC15: 1ª leitura com desconto > 70% não se confirma sozinha (aritmética inteira)
      const steep = (v.originalCents - v.currentCents) * 100 > 70 * v.originalCents;
      if (dec.confirmed && dec.confirmsPendingId === undefined && !last && steep) {
        dec = { confirmed: false, reason: 'variacao_maior_70pct' };
      }
      const row: ObservationRow = {
        variantCode: v.variantCode,
        runId,
        seq,
        observedAt: snap.fetchedAt,
        originalCents: v.originalCents,
        currentCents: v.currentCents,
        available: v.available,
        confirmed: dec.confirmed,
        degraded: snap.degraded,
        source: snap.source,
        id: 0,
        confirmedBy: null,
      };
      row.id = observations.insert(row);
      written++;
      if (!dec.confirmed) {
        needsReread ||= snap.source === 'occ';
        continue;
      }
      if (dec.confirmsPendingId !== undefined) observations.confirm(dec.confirmsPendingId, row.id);
      for (const a of mine) {
        const d = evaluateAlert(a, { id: row.id, currentCents: v.currentCents, available: v.available, confirmed: true, observedAt: row.observedAt }, this.#d.clock.now(), COOLDOWN_MS);
        if (this.#d.alertService.apply(a, d, row).notificationId !== null) created++;
      }
    }

    if (seq === 1) {
      this.#d.runs.addItem(runId, {
        productCode: code,
        seq: o.itemSeq ?? 1,
        outcome: snap.degraded ? 'degradado' : 'ok',
        source: snap.source,
        httpStatus: r.httpStatus,
        requests: r.requests,
        attempts: o.attempts ?? 1,
        durationMs: o.durationMs,
        observationsWritten: written,
        finishedAt: now,
      });
    }
    this.#d.log.info('produto_processado', { run_id: runId, product_code: code, source: snap.source, count: written });
    return {
      ok: true,
      degraded: snap.degraded,
      observationsWritten: written,
      notificationsCreated: created,
      needsReread: seq === 1 && this.#d.confirmReread && needsReread,
    };
  }

  #persistProduct(code: ProductCode, snap: ProductSnapshot, now: IsoUtc): void {
    const { products } = this.#d;
    products.upsertProduct({ code, name: stripControl(snap.name).trim(), legacySku: snap.legacySku, slug: snap.slug }, now);
    products.upsertVariants(code, snap.variants.map(({ variantCode, size, ean }) => ({ variantCode, size, ean })), now);
    products.recordSuccess(code, { degraded: snap.degraded, now }); // zera contadores
  }

  // Falha: nunca cria observação nem alerta (RF-11-AC1). Releitura (seq 2) que falha não muda estado.
  #failure(runId: number, code: ProductCode, f: Failure, requests: number, o: ProcessOpts): ProcessOutcome {
    const { products } = this.#d;
    if ((o.seq ?? 1) > 1) {
      const p = products.get(code);
      return { ok: false, failureClass: f.class, state: p?.state ?? 'ativo', consecutiveFailures: p?.consecutiveFailures ?? 0 };
    }
    return this.#d.tx(() => {
      const now = this.#now();
      const rf = products.recordFailure(code, { class: f.class, now });
      if (SAMPLE_CLASSES.has(f.class) && f.rawBody) {
        products.saveFailureSample(code, { runId, capturedAt: now, httpStatus: f.httpStatus, body: sanitizeBody(f.rawBody) });
      }
      if (f.class === 'produto_removido' && rf.state === 'removido') this.#notifyOnce('produto_removido', code, now);
      else if (f.class === 'formato_desconhecido' && rf.consecutiveFailures >= FAILURES_FOR_HEALTH) {
        // ponytail: usa o contador geral de falhas (não há sequência por classe); ver pendências
        products.setState(code, 'formato_desconhecido', now);
        this.#notifyOnce('formato_desconhecido', code, now);
        rf.state = 'formato_desconhecido';
      } else if (rf.state === 'ativo' && rf.consecutiveFailures >= FAILURES_FOR_HEALTH) this.#notifyOnce('produto_com_falha', code, now);
      this.#d.runs.addItem(runId, {
        productCode: code,
        seq: o.itemSeq ?? 1,
        outcome: 'falha',
        failureClass: f.class,
        httpStatus: f.httpStatus,
        requests,
        attempts: o.attempts ?? 1,
        durationMs: o.durationMs,
        finishedAt: now,
      });
      this.#d.log.warn('produto_falhou', { run_id: runId, product_code: code, failure_class: f.class, http_status: f.httpStatus });
      return { ok: false, failureClass: f.class, state: rf.state, consecutiveFailures: rf.consecutiveFailures };
    });
  }

  // 1 episódio aberto = 1 aviso SAUDE (índice único em health_events); sem OWNER_EMAIL o enqueue devolve null.
  #notifyOnce(kind: HealthKind, code: ProductCode, now: IsoUtc): void {
    const h = this.#d.health.open(kind, code, null, now);
    if (!h.created) return;
    const p = this.#d.products.get(code);
    this.#d.notifications.enqueue({
      alertId: null,
      healthEventId: h.id,
      observationId: null,
      kind: 'SAUDE',
      productCode: code,
      productName: p?.name ?? null,
      productSlug: p?.lastSlug ?? null,
      size: null,
      priceCents: null,
      targetCents: null,
      marginBp: null,
      observedAt: null,
      source: null,
      degraded: false,
      alreadyInBand: false,
    });
  }

  // RF-02-AC6/AC8: lido há < 2 h usa o banco; senão 1 requisição (RateGate aplica cortesia e orçamento).
  async discoverProduct(code: ProductCode): Promise<Result<Discovered, DiscoverError>> {
    const { products } = this.#d;
    const p = products.get(code);
    if (p?.lastOkAt && Date.parse(this.#now()) - Date.parse(p.lastOkAt) < DISCOVER_MAX_AGE_MS) {
      return ok({ product: p, variants: products.listVariants(code), fromCache: true });
    }
    if (this.#d.circuit.status(this.#now()).state !== 'closed') return err({ reason: 'circuito_aberto' });
    let r: SourceResult;
    try {
      r = await this.#d.source.fetchProduct(code);
    } catch (e) {
      if (e instanceof BudgetExceededError) return err({ reason: 'orcamento_diario' });
      throw e;
    }
    if (!r.ok) return err({ reason: 'falha', failureClass: r.failure.class });
    try {
      this.#d.tx(() => {
        this.#persistProduct(code, r.snapshot, this.#now());
        products.clearFailureSample(code);
      });
    } catch (e) {
      if (!isStoreDataViolation(e)) throw e;
      return err({ reason: 'falha', failureClass: 'formato_desconhecido' });
    }
    return ok({ product: products.get(code)!, variants: products.listVariants(code), fromCache: false });
  }

  // RF-09-AC10: volta a 'ativo' e zera contadores; a próxima rodada coleta. false se não havia o que retomar.
  resumeProduct(code: ProductCode): boolean {
    return this.#d.tx(() => {
      const p = this.#d.products.get(code);
      if (!p || p.state === 'ativo') return false;
      const now = this.#now();
      this.#d.products.setState(code, 'ativo', now);
      this.#d.products.resetFailures(code, now);
      this.#d.health.close('produto_removido', code, now);
      this.#d.health.close('formato_desconhecido', code, now);
      this.#d.health.close('produto_com_falha', code, now);
      return true;
    });
  }
}
