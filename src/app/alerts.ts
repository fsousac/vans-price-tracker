import type { Clock } from '../shared/clock.ts';
import { err, ok, type Result } from '../shared/result.ts';
import type { Cents, ProductCode, VariantCode } from '../shared/types.ts';
import type { Decision } from '../alerts/ports.ts';
import { type FieldErrors, validateMargin, validateTarget } from '../alerts/validation.ts';
import {
  AlertDuplicate, VariantNotFound,
  type AlertRepo, type AlertRow, type NotificationRepo, type ObservationRepo, type ObservationRow, type ProductRepo, type Tx,
} from '../store/ports.ts';

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
/** Sem e-mail: o destinatário vive em settings (EA seção 8). */
export interface AlertInput {
  target: string;
  margin?: string;
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
  /** settings.email.enabled no momento do disparo; define se a notificação nasce com e-mail PENDENTE. */
  emailEnabled: () => Promise<boolean>;
  maxActiveProducts?: number;
}

function validate(i: AlertInput): Result<{ targetCents: Cents; marginBp: number }, FieldErrors> {
  const t = validateTarget(i.target);
  const m = validateMargin(i.margin);
  if (t.ok && m.ok) return ok({ targetCents: t.value, marginBp: m.value });
  const fields: FieldErrors = {};
  if (!t.ok) fields.target = t.error;
  if (!m.ok) fields.margin = m.error;
  return err(fields);
}

export class AlertService {
  readonly #d: AlertServiceDeps;
  constructor(deps: AlertServiceDeps) {
    this.#d = deps;
  }

  #now = (): string => this.#d.clock.now().toISOString();

  // Produtos distintos com alerta ATIVO, mais o que seria criado/retomado.
  async #overLimit(extra: VariantCode): Promise<boolean> {
    const set = new Set((await this.#d.alerts.list()).filter((a) => a.status === 'ATIVO').map((a) => productOf(a.variantCode)));
    set.add(productOf(extra));
    return set.size > (this.#d.maxActiveProducts ?? MAX_ACTIVE_PRODUCTS);
  }

  async #warning(variant: VariantCode, target: Cents): Promise<AlertSaved['warning']> {
    const cur = (await this.#d.observations.latestConfirmed(variant))?.currentCents;
    return cur !== undefined && target > cur ? { code: 'alvo_acima_do_preco_atual', currentCents: cur } : null;
  }

  // Não dispara nada (D-09): a avaliação ocorre na próxima observação confirmada.
  async create(variantCode: VariantCode | undefined, input: AlertInput): Promise<Result<AlertSaved, AlertError>> {
    if (!variantCode?.includes('-')) return err({ kind: 'sem_variante' });
    const v = validate(input);
    if (!v.ok) return err({ kind: 'validacao', fields: v.error });
    return this.#d.tx(async () => {
      if (await this.#overLimit(variantCode)) return err({ kind: 'limite_produtos', message: LIMIT_MSG });
      try {
        const id = await this.#d.alerts.create({ variantCode, ...v.value }, this.#now());
        return ok({ id, warning: await this.#warning(variantCode, v.value.targetCents) });
      } catch (e) {
        if (e instanceof AlertDuplicate) return err({ kind: 'duplicado', message: DUP_MSG });
        if (e instanceof VariantNotFound) return err({ kind: 'variante_inexistente' });
        throw e;
      }
    });
  }

  // RN-14: o repo incrementa revision e reabre travas só se alvo/margem mudarem.
  async edit(id: number, input: AlertInput): Promise<Result<AlertSaved, AlertError>> {
    const v = validate(input);
    if (!v.ok) return err({ kind: 'validacao', fields: v.error });
    return this.#d.tx(async () => {
      const cur = await this.#d.alerts.get(id);
      if (!cur) return err({ kind: 'nao_encontrado' });
      try {
        await this.#d.alerts.update(id, v.value, this.#now());
      } catch (e) {
        if (e instanceof AlertDuplicate) return err({ kind: 'duplicado', message: DUP_MSG });
        throw e;
      }
      return ok({ id, warning: await this.#warning(cur.variantCode, v.value.targetCents) });
    });
  }

  // Pausar não cria notificação; PENDENTE retida/descartada é do job de notifications (RN-15).
  pause(id: number): Promise<Result<void, AlertError>> {
    return this.#d.tx(async () => {
      if (!(await this.#d.alerts.get(id))) return err({ kind: 'nao_encontrado' });
      await this.#d.alerts.update(id, { status: 'PAUSADO' }, this.#now());
      return ok(undefined);
    });
  }

  // RN-15 + RF-06-AC3: retomar também respeita o limite de 50; travas ficam como estavam.
  resume(id: number): Promise<Result<void, AlertError>> {
    return this.#d.tx(async () => {
      const a = await this.#d.alerts.get(id);
      if (!a) return err({ kind: 'nao_encontrado' });
      if (a.status === 'ATIVO') return ok(undefined);
      if (await this.#overLimit(a.variantCode)) return err({ kind: 'limite_produtos', message: LIMIT_MSG });
      await this.#d.alerts.update(id, { status: 'ATIVO' }, this.#now());
      return ok(undefined);
    });
  }

  // D-14: remoção física; notificações saem por cascata, histórico de preço permanece.
  delete(id: number): Promise<boolean> {
    return this.#d.tx(async () => {
      const found = (await this.#d.alerts.get(id)) !== null;
      if (found) await this.#d.alerts.delete(id);
      return found;
    });
  }

  // Persiste a decisão de evaluateAlert e, se disparou, enfileira a notificação (idempotente, RN-12).
  // Chamar dentro da TX do processResult (tx é reentrante). emailEnabled é lido antes da tx do apply.
  async apply(alert: AlertRow, decision: Decision, obs: ObservationRow): Promise<{ notificationKey: string | null }> {
    const emailEnabled = decision.fire ? await this.#d.emailEnabled() : false;
    const now = this.#now();
    return this.#d.tx(async () => {
      await this.#d.alerts.applyDecision(alert.id, decision.next, decision.fire, now);
      const f = decision.fire;
      if (!f) return { notificationKey: null };
      const code = productOf(obs.variantCode);
      const product = await this.#d.products.get(code);
      const size = (await this.#d.products.listVariants(code)).find((x) => x.variantCode === obs.variantCode)?.size ?? null;
      const key = `${alert.id}|${alert.revision}|${f.kind}|${f.episode}`;
      await this.#d.notifications.insertIfAbsent({
        key, alertId: alert.id, healthEventId: null, observationId: obs.id, kind: f.kind, emailEnabled,
        mode: this.#d.mode, productCode: code, productName: product?.name ?? null, productSlug: product?.lastSlug ?? null,
        size, priceCents: obs.currentCents, targetCents: alert.targetCents, marginBp: alert.marginBp,
        observedAt: obs.observedAt, source: obs.source, degraded: obs.degraded, alreadyInBand: f.alreadyInBand, now,
      });
      return { notificationKey: key };
    });
  }
}
