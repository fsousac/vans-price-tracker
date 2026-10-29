// Rodada completa de monitoramento (architecture.md 4). A cortesia 2-5 s NÃO é daqui: vem do RateGate que embrulha a fonte.
import type { MonitorService, ProcessOutcome } from '../price-monitor/monitor.service.ts';
import type { NotificationService } from '../notifications/notifications.service.ts';
import type { HealthEventRepo, HealthKind } from '../observability/ports.ts';
import type { Logger } from '../observability/logger.ts';
import { BudgetExceededError, DAILY_BUDGET } from '../price-monitor/http/rate-gate.ts';
import type {
  PriceSource,
  ProductRepo,
  RequestLog,
  RunRepo,
  RunSummary,
  RunTrigger,
  SkipReason,
  SourceResult,
  Tx,
} from '../price-monitor/ports.ts';
import type { Clock } from '../shared/clock.ts';
import type { Random } from '../shared/random.ts';
import type { FailureClass, ProductCode } from '../shared/types.ts';
import { retryDelayMs } from './backoff.ts';
import { RoundBreaker, type CircuitStore } from './circuit.ts';

export const MIN_PRODUCT_INTERVAL_MS = 2 * 3_600_000; // RF-06: mínimo de 2 h por produto (vale para manual)
const DAY_MS = 24 * 3_600_000;
const TRANSPORT: ReadonlySet<FailureClass> = new Set([
  'rede_timeout',
  'http_5xx',
  'http_429',
  'http_403_ou_desafio',
  'host_nao_autorizado',
]);

export interface RunnerDeps {
  source: PriceSource; // fonte embrulhada no RateGate
  monitor: Pick<MonitorService, 'processResult'>;
  products: Pick<ProductRepo, 'dueForCollection'>;
  runs: RunRepo;
  requestLog: Pick<RequestLog, 'countSince'>;
  circuit: CircuitStore;
  health: HealthEventRepo;
  notifications: Pick<NotificationService, 'enqueue'>;
  clock: Clock;
  random: Random;
  log: Logger;
  tx: Tx;
}
export type RoundResult = { skipped: SkipReason } | { runId: number; summary: RunSummary };

interface Tally {
  ok: number;
  failed: number;
  skipped: number;
  requests: number;
  circuitOpened: boolean;
  partial: boolean;
}

export class Runner {
  readonly #d: RunnerDeps;
  constructor(deps: RunnerDeps) {
    this.#d = deps;
  }

  #now = (): string => this.#d.clock.now().toISOString();

  #overBudget(): boolean {
    return this.#d.requestLog.countSince(new Date(this.#d.clock.now().getTime() - DAY_MS).toISOString()) >= DAILY_BUDGET;
  }

  // Uma tentativa + retentativas com backoff (<= 2). Orçamento esgotado no meio: fica com o último resultado.
  async #fetch(
    code: ProductCode,
    signal?: AbortSignal,
  ): Promise<{ r: SourceResult; attempts: number; requests: number; classes: (FailureClass | null)[] } | 'orcamento'> {
    const { source, clock, random } = this.#d;
    let last: SourceResult | null = null;
    let requests = 0;
    const classes: (FailureClass | null)[] = []; // 1 por tentativa: o disjuntor conta tentativas (429 + retentativa 429 = 2 seguidos)
    for (let n = 0; ; n++) {
      if (last) {
        const delay = last.ok ? null : retryDelayMs(last.failure, n, random);
        if (delay === null || signal?.aborted) return { r: last, attempts: n, requests, classes };
        await clock.sleep(delay, signal).catch(() => undefined); // abort: segue e o laço sai na próxima volta
      }
      try {
        last = await source.fetchProduct(code);
      } catch (e) {
        if (!(e instanceof BudgetExceededError)) throw e;
        return last ? { r: last, attempts: n, requests, classes } : 'orcamento';
      }
      requests += last.requests;
      classes.push(last.ok ? null : last.failure.class);
      if (last.ok) return { r: last, attempts: n + 1, requests, classes };
    }
  }

  async runMonitoringRound(trigger: RunTrigger, signal?: AbortSignal): Promise<RoundResult> {
    const { runs, circuit, products, monitor, clock } = this.#d;
    const start = this.#now();
    const cs = circuit.status(start);
    if (cs.state === 'open') return this.#skip(trigger, 'circuito_aberto');
    const due = products.dueForCollection(start, MIN_PRODUCT_INTERVAL_MS);
    if (due.length === 0) return this.#skip(trigger, 'sem_alertas_ativos');
    const started = runs.tryStart('monitor', trigger, start);
    if ('skipped' in started) return { skipped: started.skipped };
    const { runId } = started;

    const s: Tally = { ok: 0, failed: 0, skipped: 0, requests: 0, circuitOpened: false, partial: false };
    const breaker = new RoundBreaker();
    let probing = cs.state === 'half_open'; // 1º produto é a sonda
    if (probing) circuit.beginProbe(start);

    const skipRest = (from: number, reason: 'orcamento_diario' | 'circuito_aberto'): void => {
      for (let j = from; j < due.length; j++) {
        runs.addItem(runId, { productCode: due[j]!, seq: j + 1, outcome: 'pulado', skipReason: reason, finishedAt: this.#now() });
        s.skipped++;
      }
    };

    try {
      for (let i = 0; i < due.length; i++) {
        const code = due[i]!;
        if (signal?.aborted) {
          s.partial = true;
          break;
        }
        if (this.#overBudget()) {
          skipRest(i, 'orcamento_diario');
          break;
        }
        const t0 = clock.now().getTime();
        const got = await this.#fetch(code, signal);
        if (got === 'orcamento') {
          skipRest(i, 'orcamento_diario');
          break;
        }
        s.requests += got.requests;
        const out: ProcessOutcome = monitor.processResult(runId, code, got.r, {
          itemSeq: i + 1,
          attempts: got.attempts,
          durationMs: clock.now().getTime() - t0,
        });
        const cls = out.ok ? null : out.failureClass;
        if (out.ok) {
          s.ok++;
          if (out.needsReread && !this.#overBudget()) s.requests += await this.#reread(runId, code);
        } else {
          s.failed++;
        }
        if (probing) {
          probing = false;
          if (cls !== null && TRANSPORT.has(cls)) {
            circuit.probeFailed(this.#now()); // mesmo episódio: sem novo aviso
            s.circuitOpened = true;
            skipRest(i + 1, 'circuito_aberto');
            break;
          }
          this.#closeCircuit(); // a loja respondeu: o episódio acabou
        }
        const dec = got.classes.map((c) => breaker.observe(c)).find((d) => d.action !== 'continue') ?? { action: 'continue' as const };
        if (dec.action === 'open_circuit') {
          const c = circuit.open(dec.reason, this.#now());
          if (c.created) this.#notify('circuito_aberto', dec.reason);
          s.circuitOpened = true;
          skipRest(i + 1, 'circuito_aberto');
          break;
        }
        if (dec.action === 'end_partial') {
          this.#notify('formato_desconhecido', null);
          s.partial = true;
          break;
        }
      }
    } catch (e) {
      this.#finish(runId, due.length, s, 'failed');
      throw e;
    }
    const bad = s.failed + s.skipped > 0 || s.partial;
    const status = !bad ? 'ok' : s.ok === 0 && (s.circuitOpened || s.failed > 0) ? 'failed' : 'partial';
    const summary = this.#finish(runId, due.length, s, status);
    this.#d.log.info('rodada_concluida', { run_id: runId, count: due.length });
    return { runId, summary };
  }

  #skip(trigger: RunTrigger, reason: SkipReason): RoundResult {
    this.#d.runs.recordSkipped('monitor', trigger, reason, this.#now());
    return { skipped: reason };
  }

  #finish(runId: number, total: number, s: Tally, status: RunSummary['status']): RunSummary {
    const summary: RunSummary = {
      status,
      itemsTotal: total,
      itemsOk: s.ok,
      itemsFailed: s.failed,
      requestsMade: s.requests,
      circuitOpened: s.circuitOpened,
    };
    this.#d.runs.finish(runId, summary, this.#now());
    return summary;
  }

  #closeCircuit(): void {
    this.#d.circuit.close();
    this.#d.health.close('circuito_aberto', 'global', this.#now());
  }

  // Releitura de confirmação (RN-09c): 1 requisição extra, TX própria com seq 2; orçamento esgotado = sem releitura.
  async #reread(runId: number, code: ProductCode): Promise<number> {
    try {
      const r = await this.#d.source.fetchProduct(code);
      this.#d.monitor.processResult(runId, code, r, { seq: 2 });
      return r.requests;
    } catch (e) {
      if (e instanceof BudgetExceededError) return 0;
      throw e;
    }
  }

  // 1 episódio aberto = 1 aviso SAUDE (índice único); sem OWNER_EMAIL o enqueue devolve null.
  #notify(kind: HealthKind, detail: string | null): void {
    this.#d.tx(() => {
      const h = this.#d.health.open(kind, 'global', detail, this.#now());
      if (!h.created) return;
      this.#d.notifications.enqueue({
        alertId: null,
        healthEventId: h.id,
        observationId: null,
        kind: 'SAUDE',
        productCode: null,
        productName: null,
        productSlug: null,
        size: null,
        priceCents: null,
        targetCents: null,
        marginBp: null,
        observedAt: null,
        source: null,
        degraded: false,
        alreadyInBand: false,
      });
    });
  }
}
