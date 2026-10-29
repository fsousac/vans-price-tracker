import { err, ok, type Result } from '../shared/result.ts';
import type { FailureClass } from '../shared/types.ts';
import type { HttpClient } from '../price-monitor/ports.ts';
import { parseListing } from './catalog.parser.ts';
import type { CatalogItem } from './ports.ts';

// Listagem OCC por categoria (ADR-0002 item 7). Nunca `query=`/`q=`/`/search*` (robots). A cortesia de
// 2-5 s e o orçamento vêm do RateGate que embrulha o HttpClient (injetar `gate.forPurpose('catalog')`).

export const PAGE_SIZE = 24; // valor que a loja usa; teto real não testado
const MAX_PAGES = 100; // trava contra totalPages absurdo (catálogo tem ~52 páginas)
const BASE = 'https://www.vans.com.br/arezzocoocc/v2/vans/products/search';

export type CatalogFetchError = { failure: FailureClass; httpStatus?: number; retryAfterMs?: number };

// Falha em qualquer página aborta tudo: o chamador mantém o catálogo anterior (RF-01-AC5).
export async function fetchCatalog(
  http: HttpClient,
): Promise<Result<{ items: CatalogItem[]; skipped: number }, CatalogFetchError>> {
  const byCode = new Map<string, CatalogItem>();
  let skipped = 0;
  let totalPages = 1;
  for (let page = 0; page < totalPages && page < MAX_PAGES; page++) {
    const url = new URL(BASE);
    url.searchParams.set('category', 'SAPATOS');
    url.searchParams.set('currentPage', String(page));
    url.searchParams.set('pageSize', String(PAGE_SIZE));
    const res = await http.get({ url, accept: 'json' });
    if (!res.ok) return err({ failure: res.failure, httpStatus: res.status, retryAfterMs: res.retryAfterMs });
    const parsed = parseListing(res.body);
    if (!parsed.ok) return err({ failure: parsed.error, httpStatus: res.status });
    for (const it of parsed.value.items) byCode.set(it.code, it);
    skipped += parsed.value.skipped;
    totalPages = parsed.value.totalPages;
  }
  return ok({ items: [...byCode.values()], skipped });
}
