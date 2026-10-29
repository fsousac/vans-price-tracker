// Ciclo de UM produto (EA seção 6.2e): resultado da fonte -> persistir -> avaliar -> notificar, numa única
// transação assíncrona. Versão com await de price-monitor/monitor.service.ts; a lógica de decisão é a mesma.
import { evaluateAlert } from '../alerts/evaluate.ts';
import type { Logger } from '../observability/logger.ts';
import type { HealthKind } from '../observability/ports.ts';
import { decideConfirmation, type ConfirmDecision } from '../price-monitor/confirm.ts';
import type { Failure, PriceSource, ProductRow, ProductSnapshot, ProductState, SourceResult, VariantRow } from '../price-monitor/ports.ts';
import { sanitizeBody } from '../price-monitor/sanitize.ts';
import type { Clock } from '../shared/clock.ts';
import { stripControl } from '../shared/mask.ts';
import { err, ok, type Result } from '../shared/result.ts';
import type { FailureClass, IsoUtc, ProductCode } from '../shared/types.ts';
import {
  StoreConstraintError,
  type AlertRepo, type AlertRow, type Decision, type HealthEventRepo, type NotificationRepo, type ObservationRepo,
  type ObservationRow, type ProductRepo, type RunRepo, type Tx,
} from '../store/ports.ts';
import { BudgetExceededError } from './rate-gate.ts';

export const COOLDOWN_MS = 24 * 3_600_000; // D-11 (rearme)
export const DISCOVER_MAX_AGE_MS = 2 * 3_600_000; // RF-02-AC8
const FAILURES_FOR_HEALTH = 3; // RF-11-AC7
const SAMPLE_CLASSES: ReadonlySet<FailureClass> = new Set(['formato_desconhecido', 'preco_invalido', 'http_5xx']);
// Violações que são BUG nosso (chave repetida, rodada/produto inexistente); o resto vem de dado da loja.
const OUR_BUGS: ReadonlySet<string> = new Set(['run_variant_seq', 'run_seq', 'run_items.seq', 'runs.id', 'products.code']);

// ponytail: resetFailures ainda não existe em ProductRepo; contrato pedido ao dono de store/monitor.store.ts.
export type MonitorProductRepo = ProductRepo & { resetFailures(code: ProductCode, now: IsoUtc): Promise<void> };

export interface MonitorDeps {
  source: PriceSource; // só discoverProduct; a rodada passa o resultado a processResult
  products: MonitorProductRepo;
  observations: ObservationRepo;
  alerts: AlertRepo;
  alertService: { apply(a: AlertRow, d: Decision, o: ObservationRow): Promise<{ notificationKey: string | null }> };
  notifications: NotificationRepo; // avisos SAUDE
  emailEnabled(): Promise<boolean>;
  mode: 'real' | 'teste';
  runs: RunRepo;
  health: HealthEventRepo;
  circuit: { status(now: IsoUtc): Promise<{ state: string }> | { state: string } };
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
  | { ok: true; degraded: boolean; observationsWritten: number; notificationsCreated: number; needsReread: boolean; duplicate?: true }
  | { ok: false; failureClass: FailureClass; state: ProductState; consecutiveFailures: number; duplicate?: true };

export interface Discovered {
  product: ProductRow;
  variants: VariantRow[];
  fromCache: boolean;
}
export type DiscoverError =
  | { reason: 'circuito_aberto' }
  | { reason: 'orcamento_diario' }
  | { reason: 'falha'; failureClass: FailureClass };

const isStoreDataViolation = (e: unknown): boolean => e instanceof StoreConstraintError && !OUR_BUGS.has(e.constraint);

export class MonitorService {
  readonly #d: MonitorDeps;
  constructor(deps: MonitorDeps) {
    this.#d = deps;
  }

  #now = (): IsoUtc => this.#d.clock.now().toISOString();

  // Uma tx por chamada; alertas lidos dentro dela. Só o resultado já lido entra: nenhum fetch/sleep aqui.
  async processResult(runId: number, code: ProductCode, result: SourceResult, o: ProcessOpts = {}): Promise<ProcessOutcome> {
    const seq = o.seq ?? 1;
    if (!result.ok) return this.#failure(runId, code, result.failure, result.requests, o);
    try {
      return await this.#d.tx(() => this.#success(runId, code, result, seq, o));
    } catch (e) {
      if (!isStoreDataViolation(e)) throw e; // rollback já feito; falha injetada/bug segue para o chamador
      this.#d.log.warn('dado_da_loja_invalido', { run_id: runId, product_code: code, failure_class: 'formato_desconhecido' });
      return this.#failure(runId, code, { class: 'formato_desconhecido', httpStatus: result.httpStatus }, result.requests, o);
    }
  }

  // (runId, code) já com run_item: reprocessar é no-op (retomada após morte do SW entre fetch e tx).
  async #done(runId: number, code: ProductCode): Promise<boolean> {
    return (await this.#d.runs.doneCodes(runId)).includes(code);
  }

  async #success(runId: number, code: ProductCode, r: Extract<SourceResult, { ok: true }>, seq: 1 | 2, o: ProcessOpts): Promise<ProcessOutcome> {
    const { products, observations, alerts, health } = this.#d;
    const snap = r.snapshot;
    if (seq === 1 && (await this.#done(runId, code))) {
      return { ok: true, degraded: snap.degraded, observationsWritten: 0, notificationsCreated: 0, needsReread: false, duplicate: true };
    }
    const now = this.#now();
    if (seq === 1) {
      await this.#persistProduct(code, snap, now);
      await products.clearFailureSample(code);
      await health.close('produto_com_falha', code, now);
      if (snap.degraded) await this.#notifyOnce('parser_degradado', code, now);
      else await health.close('parser_degradado', code, now);
    }

    const byVariant = new Map<string, AlertRow[]>();
    for (const a of await alerts.activeByProduct(code)) byVariant.set(a.variantCode, [...(byVariant.get(a.variantCode) ?? []), a]);

    let written = 0;
    let created = 0;
    let needsReread = false;
    for (const v of snap.variants) {
      const mine = byVariant.get(v.variantCode) ?? [];
      const last = await observations.latestConfirmed(v.variantCode);
      let pend = await observations.latestUnconfirmed(v.variantCode);
      if (pend && last && pend.id < last.id) pend = null; // pendente mais velha que a confirmada nunca confirma
      if (seq === 2 && (!pend || (pend.runId === runId && pend.seq === 2))) continue; // nada a reler / releitura já gravada
      if (seq === 1 && mine.length === 0 && !last && !pend) continue; // sem alerta e nunca observada

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
        variantCode: v.variantCode, runId, seq, observedAt: snap.fetchedAt,
        originalCents: v.originalCents, currentCents: v.currentCents, available: v.available,
        confirmed: dec.confirmed, degraded: snap.degraded, source: snap.source, id: 0, confirmedBy: null,
      };
      row.id = await observations.insert(row);
      written++;
      if (!dec.confirmed) {
        needsReread ||= snap.source === 'occ';
        continue;
      }
      if (dec.confirmsPendingId !== undefined) await observations.confirm(dec.confirmsPendingId, row.id);
      for (const a of mine) {
        const d = evaluateAlert(
          a,
          { id: row.id, currentCents: v.currentCents, available: v.available, confirmed: true, observedAt: row.observedAt },
          this.#d.clock.now(), COOLDOWN_MS,
        );
        if ((await this.#d.alertService.apply(a, d, row)).notificationKey !== null) created++;
      }
    }

    if (seq === 1) {
      await this.#d.runs.addItem(runId, {
        productCode: code, seq: o.itemSeq ?? 1, outcome: snap.degraded ? 'degradado' : 'ok', source: snap.source,
        httpStatus: r.httpStatus, requests: r.requests, attempts: o.attempts ?? 1, durationMs: o.durationMs,
        observationsWritten: written, finishedAt: now,
      });
    }
    this.#d.log.info('produto_processado', { run_id: runId, product_code: code, source: snap.source, count: written });
    return {
      ok: true, degraded: snap.degraded, observationsWritten: written, notificationsCreated: created,
      needsReread: seq === 1 && this.#d.confirmReread && needsReread,
    };
  }

  async #persistProduct(code: ProductCode, snap: ProductSnapshot, now: IsoUtc): Promise<void> {
    const { products } = this.#d;
    await products.upsertProduct({ code, name: stripControl(snap.name).trim(), legacySku: snap.legacySku, slug: snap.slug }, now);
    await products.upsertVariants(code, snap.variants.map(({ variantCode, size, ean }) => ({ variantCode, size, ean })), now);
    await products.recordSuccess(code, { degraded: snap.degraded, now }); // zera contadores
  }

  // Falha: nunca cria observação nem alerta (RF-11-AC1). Releitura (seq 2) que falha não muda estado.
  async #failure(runId: number, code: ProductCode, f: Failure, requests: number, o: ProcessOpts): Promise<ProcessOutcome> {
    const { products } = this.#d;
    const state = async (extra: { duplicate?: true } = {}): Promise<ProcessOutcome> => {
      const p = await products.get(code);
      return { ok: false, failureClass: f.class, state: p?.state ?? 'ativo', consecutiveFailures: p?.consecutiveFailures ?? 0, ...extra };
    };
    if ((o.seq ?? 1) > 1) return state();
    return this.#d.tx(async () => {
      if (await this.#done(runId, code)) return state({ duplicate: true });
      const now = this.#now();
      const rf = await products.recordFailure(code, { class: f.class, now });
      if (SAMPLE_CLASSES.has(f.class) && f.rawBody) {
        await products.saveFailureSample(code, { runId, capturedAt: now, httpStatus: f.httpStatus, body: sanitizeBody(f.rawBody) });
      }
      if (f.class === 'produto_removido' && rf.state === 'removido') await this.#notifyOnce('produto_removido', code, now);
      else if (f.class === 'formato_desconhecido' && rf.consecutiveFailures >= FAILURES_FOR_HEALTH) {
        // ponytail: usa o contador geral de falhas (não há sequência por classe)
        await products.setState(code, 'formato_desconhecido', now);
        await this.#notifyOnce('formato_desconhecido', code, now);
        rf.state = 'formato_desconhecido';
      } else if (rf.state === 'ativo' && rf.consecutiveFailures >= FAILURES_FOR_HEALTH) await this.#notifyOnce('produto_com_falha', code, now);
      await this.#d.runs.addItem(runId, {
        productCode: code, seq: o.itemSeq ?? 1, outcome: 'falha', failureClass: f.class, httpStatus: f.httpStatus,
        requests, attempts: o.attempts ?? 1, durationMs: o.durationMs, finishedAt: now,
      });
      this.#d.log.warn('produto_falhou', { run_id: runId, product_code: code, failure_class: f.class, http_status: f.httpStatus });
      return { ok: false as const, failureClass: f.class, state: rf.state, consecutiveFailures: rf.consecutiveFailures };
    });
  }

  // 1 episódio aberto = 1 aviso SAUDE (health.open só devolve created na abertura).
  async #notifyOnce(kind: HealthKind, code: ProductCode, now: IsoUtc): Promise<void> {
    const h = await this.#d.health.open(kind, code, null, now);
    if (!h.created) return;
    const p = await this.#d.products.get(code);
    await this.#d.notifications.insertIfAbsent({
      key: `saude|${h.id}`, alertId: null, healthEventId: h.id, observationId: null, kind: 'SAUDE',
      emailEnabled: await this.#d.emailEnabled(), mode: this.#d.mode,
      productCode: code, productName: p?.name ?? null, productSlug: p?.lastSlug ?? null, size: null,
      priceCents: null, targetCents: null, marginBp: null, observedAt: null, source: null,
      degraded: false, alreadyInBand: false, now,
    });
  }

  // RF-02-AC6/AC8: lido há < 2 h usa o banco; senão 1 requisição (RateGate aplica cortesia e orçamento).
  async discoverProduct(code: ProductCode): Promise<Result<Discovered, DiscoverError>> {
    const { products } = this.#d;
    const p = await products.get(code);
    if (p?.lastOkAt && Date.parse(this.#now()) - Date.parse(p.lastOkAt) < DISCOVER_MAX_AGE_MS) {
      return ok({ product: p, variants: await products.listVariants(code), fromCache: true });
    }
    if ((await this.#d.circuit.status(this.#now())).state !== 'closed') return err({ reason: 'circuito_aberto' });
    let r: SourceResult;
    try {
      r = await this.#d.source.fetchProduct(code); // fora de tx: o await de rede encerraria a transação
    } catch (e) {
      if (e instanceof BudgetExceededError) return err({ reason: 'orcamento_diario' });
      throw e;
    }
    if (!r.ok) return err({ reason: 'falha', failureClass: r.failure.class });
    const snap = r.snapshot;
    try {
      await this.#d.tx(async () => {
        await this.#persistProduct(code, snap, this.#now());
        await products.clearFailureSample(code);
      });
    } catch (e) {
      if (!isStoreDataViolation(e)) throw e;
      return err({ reason: 'falha', failureClass: 'formato_desconhecido' });
    }
    return ok({ product: (await products.get(code))!, variants: await products.listVariants(code), fromCache: false });
  }

  // RF-09-AC10: volta a 'ativo' e zera contadores; a próxima rodada coleta. false se não havia o que retomar.
  resumeProduct(code: ProductCode): Promise<boolean> {
    return this.#d.tx(async () => {
      const p = await this.#d.products.get(code);
      if (!p || p.state === 'ativo') return false;
      const now = this.#now();
      await this.#d.products.setState(code, 'ativo', now);
      await this.#d.products.resetFailures(code, now);
      for (const k of ['produto_removido', 'formato_desconhecido', 'produto_com_falha'] as const) await this.#d.health.close(k, code, now);
      return true;
    });
  }
}
