// Fallback 1 (ADR-0002): GET /p/{code} (a loja responde 301, seguido pelo cliente) e leitura de
// __NEXT_DATA__.props.pageProps.product. Cache de até ~5 min: todo resultado é degraded=true (RN-09a).
import type { Clock } from '../shared/clock.ts';
import type { FailureClass, ProductCode } from '../shared/types.ts';
import { SystemClock } from '../shared/clock.ts';
import { normalizeVariants } from './normalize.ts';
import type { Failure, HttpClient, PriceSource, ProductSnapshot, SourceResult } from './ports.ts';

const BASE = 'https://www.vans.com.br/p/';
const OPEN = '<script id="__NEXT_DATA__"';
const CLOSE = '</script>';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

// Extração por delimitadores (sem parser de HTML). O Next escapa "<" no JSON, então "</script>" não aparece dentro.
function nextData(html: string): unknown {
  const start = html.indexOf(OPEN);
  if (start < 0) return undefined;
  const from = html.indexOf('>', start);
  const end = from < 0 ? -1 : html.indexOf(CLOSE, from);
  if (end < 0) return undefined;
  try {
    return JSON.parse(html.slice(from + 1, end));
  } catch {
    return undefined;
  }
}

export class NextDataSource implements PriceSource {
  readonly name = 'next_data';
  readonly #http: HttpClient;
  readonly #clock: Clock;

  constructor(http: HttpClient, clock: Clock = new SystemClock()) {
    this.#http = http;
    this.#clock = clock;
  }

  async fetchProduct(code: ProductCode): Promise<SourceResult> {
    const res = await this.#http.get({ url: new URL(BASE + encodeURIComponent(code)), accept: 'html' });
    if (!res.ok) {
      const removed = res.failure === 'formato_desconhecido' && res.status === 404; // RN-19
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

  #snapshot(code: ProductCode, html: string): ProductSnapshot | { class: FailureClass } {
    const d = nextData(html);
    const props = isObj(d) ? d.props : undefined;
    const pageProps = isObj(props) ? props.pageProps : undefined;
    const p = isObj(pageProps) ? pageProps.product : undefined;
    if (!isObj(p) || p.code !== code || typeof p.name !== 'string') return { class: 'formato_desconhecido' };
    const raw = p.variantOptions;
    if (!Array.isArray(raw) || raw.length === 0) return { class: 'formato_desconhecido' };
    // percentualOfDiscount ("" no SSR) e variantOptions[].url ("") são ignorados: preço e tamanho vêm de value/displayText.
    const n = normalizeVariants(raw, code, { price: p.price, discountPrice: p.discountPrice });
    if (!n.ok) return { class: n.error };
    if (n.value.variants.length === 0) return { class: 'preco_invalido' };
    const slug = typeof p.url === 'string' ? /^\/([a-z0-9-]+)\/p\//.exec(p.url)?.[1] : undefined;
    return {
      code,
      name: p.name,
      slug: slug ?? null,
      legacySku: typeof p.legacySKU === 'string' && p.legacySKU !== '' ? p.legacySKU : null,
      source: 'next_data',
      degraded: true,
      fetchedAt: this.#clock.now().toISOString(),
      variants: n.value.variants,
      skippedVariants: n.value.skipped,
    };
  }
}
