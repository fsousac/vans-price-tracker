import type { Cents, IsoUtc, ProductCode } from '../shared/types.ts';

export interface CatalogItem {
  code: ProductCode;
  name: string;
  lastSlug: string | null;
  priceCents: Cents | null; // só referência de listagem
}
export interface CatalogRepo {
  replaceAll(items: CatalogItem[], now: IsoUtc): void; // em transação
  search(q: string, limit: number): CatalogItem[];
  count(): number;
}
