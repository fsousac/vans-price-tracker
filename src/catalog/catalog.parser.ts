import { err, ok, type Result } from '../shared/result.ts';
import { valueToCents } from '../shared/money.ts';
import type { CatalogItem } from './ports.ts';

// Listagem OCC (/products/search?category=SAPATOS) -> CatalogItem[]. Item sem `code` válido, nome ou
// preço válido é ignorado e contado (RF-01-AC4); preço inválido nunca vira preço. `stock` é ignorado.

export interface Listing {
  items: CatalogItem[];
  skipped: number;
  currentPage: number;
  totalPages: number;
}

const CODE = /^[A-Za-z0-9]{8,20}$/;
const SLUG = /^\/([a-z0-9-]{1,200})\/p\/[A-Za-z0-9]{8,20}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

export function parseListing(raw: string): Result<Listing, 'formato_desconhecido'> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return err('formato_desconhecido');
  }
  if (!isObj(json) || !Array.isArray(json.products) || !isObj(json.pagination)) return err('formato_desconhecido');
  const { currentPage, totalPages } = json.pagination;
  if (!isInt(currentPage) || !isInt(totalPages)) return err('formato_desconhecido');

  const items: CatalogItem[] = [];
  let skipped = 0;
  for (const p of json.products) {
    const item = isObj(p) ? toItem(p) : null;
    if (item) items.push(item);
    else skipped++;
  }
  return ok({ items, skipped, currentPage, totalPages });
}

function toItem(p: Record<string, unknown>): CatalogItem | null {
  const { code, name, url } = p;
  if (typeof code !== 'string' || !CODE.test(code)) return null; // RF-01-AC6: identidade é o code
  if (typeof name !== 'string' || name.trim() === '' || name.length > 300) return null;
  const price = valueToCents(isObj(p.price) ? p.price.value : undefined);
  if (!price.ok) return null;
  const lastSlug = typeof url === 'string' ? (SLUG.exec(url)?.[1] ?? null) : null;
  return { code, name: name.trim(), lastSlug, priceCents: price.value };
}
