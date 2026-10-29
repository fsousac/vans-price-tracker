// Fonte primária (ADR-0002): GET /arezzocoocc/v2/vans/products/{code}. Sem cookies, sem redirect.
import type { Clock } from '../shared/clock.ts';
import type { FailureClass, ProductCode } from '../shared/types.ts';
import { SystemClock } from '../shared/clock.ts';
import { normalizeVariants } from './normalize.ts';
import type { Failure, HttpClient, PriceSource, ProductSnapshot, SourceResult } from './ports.ts';

const BASE = 'https://www.vans.com.br/arezzocoocc/v2/vans/products/';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function parse(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

export class OccSource implements PriceSource {
  readonly name = 'occ';
  readonly #http: HttpClient;
  readonly #clock: Clock;

  constructor(http: HttpClient, clock: Clock = new SystemClock()) {
    this.#http = http;
    this.#clock = clock;
  }

  async fetchProduct(code: ProductCode): Promise<SourceResult> {
    const res = await this.#http.get({ url: new URL(BASE + encodeURIComponent(code)), accept: 'json' });
    if (!res.ok) {
      // 400 UnknownIdentifierError ou 404 = removido (RN-19); demais 400/3xx seguem a classe do cliente.
      const removed =
        res.failure === 'formato_desconhecido' &&
        (res.status === 404 || (res.status === 400 && hasUnknownIdentifier(res.body)));
      const failure: Failure = { class: removed ? 'produto_removido' : res.failure };
      if (res.status !== undefined) failure.httpStatus = res.status;
      if (res.retryAfterMs !== undefined) failure.retryAfterMs = res.retryAfterMs;
      if (res.body !== undefined && !removed) failure.rawBody = res.body;
      return { ok: false, failure, requests: 1 };
    }
    const r = this.#snapshot(code, res.body);
    if ('class' in r) {
      return { ok: false, failure: { class: r.class, httpStatus: res.status, rawBody: res.body }, requests: 1 };
    }
    return { ok: true, snapshot: r, httpStatus: res.status, requests: 1 };
  }

  #snapshot(code: ProductCode, body: string): ProductSnapshot | { class: FailureClass } {
    const o = parse(body);
    if (!isObj(o) || o.code !== code || typeof o.name !== 'string') return { class: 'formato_desconhecido' };
    const base = Array.isArray(o.baseOptions) ? o.baseOptions[0] : undefined;
    const raw = isObj(base) ? base.options : undefined;
    if (!Array.isArray(raw) || raw.length === 0) return { class: 'formato_desconhecido' };
    const n = normalizeVariants(raw, code, { price: o.price, discountPrice: o.discountPrice });
    if (!n.ok) return { class: n.error };
    if (n.value.variants.length === 0) return { class: 'preco_invalido' }; // nunca lista vazia "ok"
    const slug = typeof o.url === 'string' ? /^\/([a-z0-9-]+)\/p\//.exec(o.url)?.[1] : undefined;
    return {
      code,
      name: o.name,
      slug: slug ?? null,
      legacySku: typeof o.legacySKU === 'string' && o.legacySKU !== '' ? o.legacySKU : null,
      source: 'occ',
      degraded: false,
      fetchedAt: this.#clock.now().toISOString(),
      variants: n.value.variants,
      skippedVariants: n.value.skipped,
    };
  }
}

function hasUnknownIdentifier(body: string | undefined): boolean {
  const o = body === undefined ? undefined : parse(body);
  const errors = isObj(o) ? o.errors : undefined;
  return Array.isArray(errors) && errors.some((e) => isObj(e) && e.type === 'UnknownIdentifierError');
}
