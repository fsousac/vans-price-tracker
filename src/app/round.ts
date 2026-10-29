// Rodada retomável (EA seção 6). O SW MV3 é efêmero: todo estado em storage, cursor = run_items, fatias de 150 s.
// Espera longa (> 20 s) não é dormida: vira resumeAt + alarme `resume` e a ativação termina.
import type { Logger } from '../observability/logger.ts';
import type { HealthKind } from '../observability/ports.ts';
import type { PriceSource, RunSummary, RunTrigger, SkipReason, SourceResult } from '../price-monitor/ports.ts';
import { retryDelayMs } from '../scheduler/backoff.ts';
import { RoundBreaker } from '../scheduler/circuit.ts';
import type { Clock } from '../shared/clock.ts';
import type { Random } from '../shared/random.ts';
import type { FailureClass, IsoUtc, ProductCode } from '../shared/types.ts';
import type {
  AlertRepo, HealthEventRepo, KvKey, KvRepo, NotificationRepo, ProductRepo, RequestLog, RunRepo, Tx,
} from '../store/ports.ts';
import type { CircuitStore } from './circuit-store.ts';
import type { MonitorService } from './monitor.ts';
import { BudgetExceededError, DAILY_BUDGET } from './rate-gate.ts';

export const LEASE_MS = 90_000;
export const SLICE_MS = 150_000;
export const MAX_RESUME_AGE_MS = 2 * 3_600_000;
export const MIN_PRODUCT_INTERVAL_MS = 2 * 3_600_000; // RF-06: mínimo de 2 h por produto (vale para manual)
export const LONG_WAIT_MS = 20_000;
export const RESUME_GAP_MS = 30_000; // mínimo do alarme `resume` (e folga entre fatias)
const DAY_MS = 24 * 3_600_000;
const TRANSPORT: ReadonlySet<FailureClass> = new Set([
  'rede_timeout', 'http_5xx', 'http_429', 'http_403_ou_desafio', 'host_nao_autorizado',
]);
// ponytail: chave fora da união KvKey (store/ports.ts é de outro dono); o kv aceita qualquer string. Pedir inclusão.
const RETRY_KEY = 'round_retry' as unknown as KvKey;
// Pulos de agenda não viram linha em `runs` quando automáticos (tick a cada 15 min enchia a tabela).
const RECORDED: ReadonlySet<SkipReason> = new Set(['anterior_em_andamento', 'circuito_aberto', 'orcamento_diario']);

export interface RoundDeps {
  source: PriceSource; // fonte embrulhada no RateGate
  monitor: Pick<MonitorService, 'processResult'>;
  products: Pick<ProductRepo, 'dueForCollection'>;
  alerts: Pick<AlertRepo, 'list'>;
  runs: RunRepo;
  /** Itens já gravados da rodada (contadores sobrevivem às retomadas). Contrato pedido: RunRepo.items(runId). */
  runItems(runId: number): Promise<{ outcome: string; requests: number }[]>;
  requestLog: Pick<RequestLog, 'countSince'>;
  circuit: CircuitStore;
  kv: Pick<KvRepo, 'get' | 'set' | 'delete'>;
  health: HealthEventRepo;
  notifications: Pick<NotificationRepo, 'insertIfAbsent'>;
  emailEnabled(): Promise<boolean>;
  mode: 'real' | 'teste';
  drain(): Promise<unknown>;
  /** Porta do alarme `resume` (when = null remove). */
  schedule(name: 'resume', when: IsoUtc | null): Promise<void>;
  clock: Clock;
  random: Random;
  log: Logger;
  tx: Tx;
}

export type RoundResult =
  | { skipped: SkipReason }
  | { runId: number; summary: RunSummary }
  | { runId: number; paused: true; resumeAt: IsoUtc };

type Fetched =
  | { r: SourceResult; attempts: number; requests: number; classes: (FailureClass | null)[] }
  | { pause: number; cls: FailureClass };

const ms = (iso: string): number => Date.parse(iso);

export class Round {
  readonly #d: RoundDeps;
  constructor(deps: RoundDeps) {
    this.#d = deps;
  }

  #now = (): IsoUtc => this.#d.clock.now().toISOString();

  async #overBudget(): Promise<boolean> {
    return (await this.#d.requestLog.countSince(new Date(this.#d.clock.now().getTime() - DAY_MS).toISOString())) >= DAILY_BUDGET;
  }

  /**
   * Retoma a rodada `running` com lease vencida (<= 2 h), ou inicia uma nova com a fila congelada.
   * `resumeOnly` (alarme `resume`): nunca inicia rodada nova; o intervalo é decisão do tick.
   */
  async resumeOrStart(trigger: RunTrigger, o: { resumeOnly?: boolean; signal?: AbortSignal } = {}): Promise<RoundResult> {
    const { runs, circuit, products } = this.#d;
    const now = this.#now();
    const cur = await runs.getRunning('monitor');
    if (cur && ms(now) - ms(cur.heartbeatAt ?? cur.startedAt) < LEASE_MS) return this.#skip(trigger, 'anterior_em_andamento');
    let queue: ProductCode[] = [];
    if (!(cur && ms(now) - ms(cur.startedAt) <= MAX_RESUME_AGE_MS)) {
      if (o.resumeOnly) return this.#skip(trigger, 'intervalo_minimo');
      if ((await circuit.status(now)).state === 'open') return this.#skip(trigger, 'circuito_aberto');
      queue = await products.dueForCollection(now, MIN_PRODUCT_INTERVAL_MS);
      if (queue.length === 0) {
        const active = (await this.#d.alerts.list()).some((a) => a.status === 'ATIVO');
        return this.#skip(trigger, active ? 'intervalo_minimo' : 'sem_alertas_ativos');
      }
    }
    const c = await runs.claim({ kind: 'monitor', trigger, queue, now, leaseMs: LEASE_MS, maxResumeAgeMs: MAX_RESUME_AGE_MS });
    if (c.action === 'busy') return this.#skip(trigger, 'anterior_em_andamento');
    this.#d.log.info(c.action === 'resumed' ? 'rodada_retomada' : 'rodada_iniciada', { run_id: c.run.id, count: c.run.queue.length });
    return this.#drive(c.run.id, c.run.queue, o.signal);
  }

  async #skip(trigger: RunTrigger, reason: SkipReason): Promise<RoundResult> {
    if (trigger === 'manual' || RECORDED.has(reason)) await this.#d.runs.recordSkipped('monitor', trigger, reason, this.#now());
    else this.#d.log.info('rodada_pulada');
    return { skipped: reason };
  }

  // Uma tentativa + retentativas (<= 2). `prior`: classe da tentativa anterior, que terminou em espera longa.
  async #fetch(code: ProductCode, prior: FailureClass | null, signal?: AbortSignal): Promise<Fetched | 'orcamento'> {
    const { source, clock, random } = this.#d;
    let last: SourceResult | null = null;
    let n = prior ? 1 : 0; // tentativas já feitas = índice da próxima retentativa
    let requests = 0;
    const classes: (FailureClass | null)[] = []; // desta ativação; o disjuntor conta tentativas
    for (;;) {
      if (last) {
        const delay = last.ok ? null : retryDelayMs(last.failure, n, random);
        if (delay === null || signal?.aborted) return { r: last, attempts: n, requests, classes };
        if (delay > LONG_WAIT_MS) return { pause: delay, cls: (last as { failure: { class: FailureClass } }).failure.class };
        await clock.sleep(delay, signal).catch(() => undefined); // abort: segue e sai na próxima volta
      }
      try {
        last = await source.fetchProduct(code); // fora de tx: o await de rede encerraria a transação
      } catch (e) {
        if (!(e instanceof BudgetExceededError)) throw e;
        return last ? { r: last, attempts: n, requests, classes } : 'orcamento';
      }
      n++;
      requests += last.requests;
      classes.push(last.ok ? null : last.failure.class);
      if (last.ok) return { r: last, attempts: n, requests, classes };
    }
  }

  async #memo(runId: number): Promise<{ code: ProductCode; cls: FailureClass } | null> {
    const [r, code, cls] = ((await this.#d.kv.get(RETRY_KEY)) ?? '').split('|');
    return r === String(runId) && code && cls ? { code, cls: cls as FailureClass } : null;
  }

  async #pause(runId: number, delayMs: number): Promise<RoundResult> {
    const resumeAt = new Date(this.#d.clock.now().getTime() + Math.max(delayMs, RESUME_GAP_MS)).toISOString();
    await this.#d.runs.setResumeAt(runId, resumeAt);
    // Solta a lease: o alarme volta em 30 s e a lease normal (90 s) o trataria como "anterior em andamento".
    await this.#d.runs.heartbeat(runId, new Date(this.#d.clock.now().getTime() - LEASE_MS).toISOString());
    await this.#d.schedule('resume', resumeAt);
    this.#d.log.info('rodada_pausada', { run_id: runId });
    return { runId, paused: true, resumeAt };
  }

  // ponytail: exceção inesperada deixa a rodada `running`: a lease vence e o tick retoma (até 2 h, depois `interrupted`).
  // O RoundBreaker recomeça a cada ativação (só a classe da espera longa é semeada); ceiling: 3 falhas separadas por pausa.
  async #drive(runId: number, queue: ProductCode[], signal?: AbortSignal): Promise<RoundResult> {
    const { runs, circuit, monitor, clock } = this.#d;
    const sliceStart = clock.now().getTime();
    const done = new Set(await runs.doneCodes(runId));
    const breaker = new RoundBreaker();
    const memo = await this.#memo(runId);
    if (memo) breaker.observe(memo.cls);
    const cs = await circuit.status(this.#now());
    let probing = cs.state === 'half_open' && done.size === 0; // 1º produto da rodada é a sonda
    if (probing) await circuit.beginProbe();
    let rereads = 0;
    let circuitOpened = false;
    let partial = false;

    const skipRest = async (from: number, reason: 'orcamento_diario' | 'circuito_aberto'): Promise<void> => {
      for (let j = from; j < queue.length; j++) {
        const c = queue[j]!;
        if (done.has(c)) continue;
        await runs.addItem(runId, { productCode: c, seq: j + 1, outcome: 'pulado', skipReason: reason, finishedAt: this.#now() });
        done.add(c);
      }
    };

    for (let i = 0; i < queue.length; i++) {
      const code = queue[i]!;
      if (done.has(code)) continue;
      if (signal?.aborted) {
        partial = true;
        break;
      }
      if (clock.now().getTime() - sliceStart >= SLICE_MS) return this.#pause(runId, RESUME_GAP_MS);
      await runs.heartbeat(runId, this.#now());
      if (await this.#overBudget()) {
        await skipRest(i, 'orcamento_diario');
        break;
      }
      if ((await circuit.status(this.#now())).state === 'open') {
        await skipRest(i, 'circuito_aberto');
        break;
      }
      const t0 = clock.now().getTime();
      const prior = memo?.code === code ? memo.cls : null;
      const got = await this.#fetch(code, prior, signal);
      if (got === 'orcamento') {
        await skipRest(i, 'orcamento_diario');
        break;
      }
      if ('pause' in got) {
        await this.#d.kv.set(RETRY_KEY, `${runId}|${code}|${got.cls}`);
        return this.#pause(runId, got.pause);
      }
      const out = await monitor.processResult(runId, code, got.r, {
        itemSeq: i + 1, attempts: got.attempts, durationMs: clock.now().getTime() - t0,
      });
      done.add(code);
      if (prior) await this.#d.kv.delete(RETRY_KEY);
      const cls = out.ok ? null : out.failureClass;
      if (out.ok && out.needsReread && !(await this.#overBudget())) rereads += await this.#reread(runId, code);
      if (probing) {
        probing = false;
        if (cls !== null && TRANSPORT.has(cls)) {
          await circuit.probeFailed(this.#now()); // mesmo episódio: sem novo aviso
          circuitOpened = true;
          await skipRest(i + 1, 'circuito_aberto');
          break;
        }
        await this.#closeCircuit(); // a loja respondeu: o episódio acabou
      }
      const dec = got.classes.map((c) => breaker.observe(c)).find((x) => x.action !== 'continue');
      if (dec?.action === 'open_circuit') {
        const c = await circuit.open(dec.reason, this.#now());
        if (c.created) await this.#notify('circuito_aberto', dec.reason);
        circuitOpened = true;
        await skipRest(i + 1, 'circuito_aberto');
        break;
      }
      if (dec?.action === 'end_partial') {
        await this.#notify('formato_desconhecido', null);
        partial = true;
        break;
      }
    }
    return this.#close(runId, queue.length, { circuitOpened, partial, rereads });
  }

  async #close(runId: number, total: number, f: { circuitOpened: boolean; partial: boolean; rereads: number }): Promise<RoundResult> {
    const items = await this.#d.runItems(runId);
    const n = (...o: string[]) => items.filter((x) => o.includes(x.outcome)).length;
    const ok = n('ok', 'degradado');
    const failed = n('falha');
    const bad = failed + n('pulado') > 0 || f.partial;
    const status: RunSummary['status'] = !bad ? 'ok' : ok === 0 && (f.circuitOpened || failed > 0) ? 'failed' : 'partial';
    const summary: RunSummary = {
      status, itemsTotal: total, itemsOk: ok, itemsFailed: failed,
      requestsMade: items.reduce((s, x) => s + x.requests, 0) + f.rereads, circuitOpened: f.circuitOpened,
    };
    await this.#d.runs.finish(runId, summary, this.#now());
    await this.#d.kv.delete(RETRY_KEY);
    await this.#d.schedule('resume', null);
    this.#d.log.info('rodada_concluida', { run_id: runId, count: total });
    await this.#d.drain(); // notificações geradas pela rodada saem agora, sem esperar o tick
    return { runId, summary };
  }

  async #closeCircuit(): Promise<void> {
    await this.#d.circuit.close();
    await this.#d.health.close('circuito_aberto', 'global', this.#now());
  }

  // Releitura de confirmação (RN-09c): 1 requisição extra, seq 2; orçamento esgotado = sem releitura.
  async #reread(runId: number, code: ProductCode): Promise<number> {
    try {
      const r = await this.#d.source.fetchProduct(code);
      await this.#d.monitor.processResult(runId, code, r, { seq: 2 });
      return r.requests;
    } catch (e) {
      if (e instanceof BudgetExceededError) return 0;
      throw e;
    }
  }

  // 1 episódio aberto = 1 aviso SAUDE (health.open só devolve created na abertura).
  async #notify(kind: HealthKind, detail: string | null): Promise<void> {
    const d = this.#d;
    await d.tx(async () => {
      const now = this.#now();
      const h = await d.health.open(kind, 'global', detail, now);
      if (!h.created) return;
      await d.notifications.insertIfAbsent({
        key: `saude|${h.id}`, alertId: null, healthEventId: h.id, observationId: null, kind: 'SAUDE',
        emailEnabled: await d.emailEnabled(), mode: d.mode, productCode: null, productName: null, productSlug: null,
        size: null, priceCents: null, targetCents: null, marginBp: null, observedAt: null, source: null,
        degraded: false, alreadyInBand: false, now,
      });
    });
  }
}
