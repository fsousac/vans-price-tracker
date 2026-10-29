// Primária -> fallback (architecture 3.3, RN-18). Cai só em falha de rede/5xx/formato; nunca insiste contra bloqueio.
import type { FailureClass, ProductCode } from '../shared/types.ts';
import type { PriceSource, SourceResult } from './ports.ts';

const FALLBACK_ON: ReadonlySet<FailureClass> = new Set(['rede_timeout', 'http_5xx', 'formato_desconhecido']);

export class CompositeSource implements PriceSource {
  readonly name = 'composite';
  readonly #sources: readonly PriceSource[];

  constructor(sources: readonly PriceSource[]) {
    if (sources.length === 0) throw new Error('CompositeSource precisa de ao menos uma fonte');
    this.#sources = sources;
  }

  async fetchProduct(code: ProductCode): Promise<SourceResult> {
    let requests = 0;
    let last!: SourceResult;
    for (const [i, src] of this.#sources.entries()) {
      const r = await src.fetchProduct(code);
      requests += r.requests;
      // Resultado de fallback é sempre degradado (RN-09a); a primária fica como veio.
      last = r.ok ? { ...r, snapshot: i === 0 ? r.snapshot : { ...r.snapshot, degraded: true }, requests } : { ...r, requests };
      if (r.ok || !FALLBACK_ON.has(r.failure.class)) return last;
    }
    return last; // todas falharam: devolve a falha da última, com as requisições somadas
  }
}
