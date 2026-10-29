import type { Clock } from '../shared/clock.ts';
import { sha256Hex } from '../shared/hash.ts';
import { err, ok, type Result } from '../shared/result.ts';
import type { Cents, ProductCode, VariantCode } from '../shared/types.ts';
import type { NotificationRepo } from '../notifications/ports.ts';
import type { ObservationRepo, ObservationRow } from '../price-history/ports.ts';
import type { ProductRepo, Tx } from '../price-monitor/ports.ts';
import { AlertDuplicate, VariantNotFound, type AlertRepo, type AlertRow, type Decision } from './ports.ts';
import { type AlertInput, type FieldErrors, validateAlertInput } from './validation.ts';

export const MAX_ACTIVE_PRODUCTS = 50; // RF-06-AC3

export type AlertError =
  | { kind: 'validacao'; fields: FieldErrors }
  | { kind: 'sem_variante' } // RF-03-AC4
  | { kind: 'variante_inexistente' }
  | { kind: 'limite_produtos'; message: string } // RF-06-AC3
  | { kind: 'duplicado'; message: string } // RF-09-AC7
  | { kind: 'nao_encontrado' };
// Aviso (não erro) quando o alvo está acima do preço confirmado atual (RN-10 / RF-04-AC4).
export interface AlertSaved {
  id: number;
  warning: { code: 'alvo_acima_do_preco_atual'; currentCents: Cents } | null;
}

const LIMIT_MSG = `Limite de ${MAX_ACTIVE_PRODUCTS} produtos com alerta ativo atingido (carga de requisições da loja). Pause ou exclua alertas de outro produto.`;
const DUP_MSG = 'Alerta idêntico já existe.';
// variant_code = "{product_code}-{size}"; o código do produto é alfanumérico (sem '-').
const productOf = (v: VariantCode): ProductCode => v.slice(0, v.indexOf('-'));

export interface AlertServiceDeps {
  alerts: AlertRepo;
  notifications: NotificationRepo;
  observations: ObservationRepo;
  products: ProductRepo;
  clock: Clock;
  tx: Tx;
  mode: 'real' | 'teste';
  maxActiveProducts?: number;
}

export class AlertService {
  readonly #d: AlertServiceDeps;
  constructor(deps: AlertServiceDeps) {
    this.#d = deps;
  }

  #now = (): string => this.#d.clock.now().toISOString();

  // Produtos distintos com alerta ATIVO, mais o que seria criado/retomado.
  #overLimit(extra: VariantCode): boolean {
    const set = new Set(this.#d.alerts.list().filter((a) => a.status === 'ATIVO').map((a) => productOf(a.variantCode)));
    set.add(productOf(extra));
    return set.size > (this.#d.maxActiveProducts ?? MAX_ACTIVE_PRODUCTS);
  }

  #warning(variant: VariantCode, target: Cents): AlertSaved['warning'] {
    const cur = this.#d.observations.latestConfirmed(variant)?.currentCents;
    return cur !== undefined && target > cur ? { code: 'alvo_acima_do_preco_atual', currentCents: cur } : null;
  }

  // Não dispara nada (D-09): a avaliação ocorre na próxima observação confirmada.
  create(variantCode: VariantCode | undefined, input: AlertInput): Result<AlertSaved, AlertError> {
    if (!variantCode?.includes('-')) return err({ kind: 'sem_variante' });
    const v = validateAlertInput(input);
    if (!v.ok) return err({ kind: 'validacao', fields: v.error });
    return this.#d.tx(() => {
      if (this.#overLimit(variantCode)) return err({ kind: 'limite_produtos', message: LIMIT_MSG });
      try {
        const id = this.#d.alerts.create({ variantCode, ...v.value }, this.#now());
        return ok({ id, warning: this.#warning(variantCode, v.value.targetCents) });
      } catch (e) {
        if (e instanceof AlertDuplicate) return err({ kind: 'duplicado', message: DUP_MSG });
        if (e instanceof VariantNotFound) return err({ kind: 'variante_inexistente' });
        throw e;
      }
    });
  }

  // RN-14: o repo incrementa revision e reabre travas só se alvo/margem mudarem.
  edit(id: number, input: AlertInput): Result<AlertSaved, AlertError> {
    const v = validateAlertInput(input);
    if (!v.ok) return err({ kind: 'validacao', fields: v.error });
    return this.#d.tx(() => {
      const cur = this.#d.alerts.get(id);
      if (!cur) return err({ kind: 'nao_encontrado' });
      try {
        this.#d.alerts.update(id, v.value, this.#now());
      } catch (e) {
        if (e instanceof AlertDuplicate) return err({ kind: 'duplicado', message: DUP_MSG });
        throw e;
      }
      return ok({ id, warning: this.#warning(cur.variantCode, v.value.targetCents) });
    });
  }

  // Pausar não cria notificação; PENDENTE retida/descartada é do job de notifications (RN-15).
  pause(id: number): Result<void, AlertError> {
    return this.#d.tx(() => {
      if (!this.#d.alerts.get(id)) return err({ kind: 'nao_encontrado' });
      this.#d.alerts.update(id, { status: 'PAUSADO' }, this.#now());
      return ok(undefined);
    });
  }

  // RN-15 + RF-06-AC3: retomar também respeita o limite de 50; travas ficam como estavam.
  resume(id: number): Result<void, AlertError> {
    return this.#d.tx(() => {
      const a = this.#d.alerts.get(id);
      if (!a) return err({ kind: 'nao_encontrado' });
      if (a.status === 'ATIVO') return ok(undefined);
      if (this.#overLimit(a.variantCode)) return err({ kind: 'limite_produtos', message: LIMIT_MSG });
      this.#d.alerts.update(id, { status: 'ATIVO' }, this.#now());
      return ok(undefined);
    });
  }

  // D-14: remoção física; notificações saem por cascade, histórico de preço permanece.
  delete(id: number): boolean {
    return this.#d.tx(() => {
      const found = this.#d.alerts.get(id) !== null;
      if (found) this.#d.alerts.delete(id);
      return found;
    });
  }

  // Persiste a decisão de evaluateAlert e, se disparou, enfileira a notificação (idempotente, RN-12).
  // Chamar dentro da TX do processResult (tx é reentrante).
  apply(alert: AlertRow, decision: Decision, obs: ObservationRow): { notificationId: number | null } {
    const now = this.#now();
    return this.#d.tx(() => {
      this.#d.alerts.applyDecision(alert.id, decision.next, decision.fire, now);
      const f = decision.fire;
      if (!f) return { notificationId: null };
      const code = productOf(obs.variantCode);
      const product = this.#d.products.get(code);
      const size = this.#d.products.listVariants(code).find((x) => x.variantCode === obs.variantCode)?.size ?? null;
      const { id } = this.#d.notifications.insertIfAbsent({
        alertId: alert.id,
        healthEventId: null,
        observationId: obs.id,
        kind: f.kind,
        idempotencyKey: sha256Hex(`${alert.id}|${alert.revision}|${f.kind}|${f.episode}`),
        mode: this.#d.mode,
        productCode: code,
        productName: product?.name ?? null,
        productSlug: product?.lastSlug ?? null,
        size,
        priceCents: obs.currentCents,
        targetCents: alert.targetCents,
        marginBp: alert.marginBp,
        observedAt: obs.observedAt,
        source: obs.source,
        degraded: obs.degraded,
        alreadyInBand: f.alreadyInBand,
        now,
      });
      return { notificationId: id };
    });
  }
}
