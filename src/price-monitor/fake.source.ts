// Dublês para testes (testing.md 1.3): sem rede, determinísticos. Código desconhecido = erro do teste, não falha de loja.
import type { ProductCode } from '../shared/types.ts';
import type { HttpClient, HttpResult, PriceSource, ProductSnapshot, SourceResult } from './ports.ts';

type Programmed = SourceResult | ProductSnapshot;
const isSnapshot = (p: Programmed): p is ProductSnapshot => 'variants' in p;

/** Por código: um resultado fixo ou uma fila (consumida em ordem; o último se repete). Snapshot puro vira ok/200/1 req. */
export class FakeSource implements PriceSource {
  readonly name = 'fake';
  readonly calls: ProductCode[] = [];
  readonly #byCode: Map<ProductCode, Programmed[]>;

  constructor(byCode: Record<ProductCode, Programmed | Programmed[]>) {
    this.#byCode = new Map(Object.entries(byCode).map(([c, v]) => [c, Array.isArray(v) ? [...v] : [v]]));
  }

  async fetchProduct(code: ProductCode): Promise<SourceResult> {
    this.calls.push(code);
    const q = this.#byCode.get(code);
    if (!q || q.length === 0) throw new Error(`FakeSource: nada programado para ${code}`);
    const p = q.length > 1 ? q.shift()! : q[0]!;
    return isSnapshot(p) ? { ok: true, snapshot: p, httpStatus: 200, requests: 1 } : p;
  }
}

/** Serve respostas por URL completa (href). URL não programada lança: com `{}` falha se chamado (testes de SSRF/URL hostil). */
export class FakeHttpClient implements HttpClient {
  readonly urls: string[] = [];
  readonly #routes: Map<string, HttpResult | (() => HttpResult)>;

  constructor(routes: Record<string, HttpResult | (() => HttpResult)> = {}) {
    this.#routes = new Map(Object.entries(routes));
  }

  async get(req: Parameters<HttpClient['get']>[0]): Promise<HttpResult> {
    this.urls.push(req.url.href);
    const r = this.#routes.get(req.url.href);
    if (r === undefined) throw new Error(`FakeHttpClient: chamada inesperada ${req.url.href}`);
    return typeof r === 'function' ? r() : r;
  }
}
