import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DIR = new URL('../fixtures/vans/', import.meta.url);

/** Lê tests/fixtures/vans/<name>, independente do CWD. */
export function fixtureText(name: string): string {
  return readFileSync(fileURLToPath(new URL(name, DIR)), 'utf8');
}

export function fixture<T = any>(name: string): T {
  return JSON.parse(fixtureText(name)) as T;
}

// Construtores sintéticos: cópia profunda + edição mínima (nunca gravam arquivo).
type Json = any;
type Opt = { price?: Json; discountPrice?: Json; sellable?: boolean };

const clone = (o: Json): Json => structuredClone(o);
const money = (v: unknown): Json => ({ currencyIso: 'BRL', value: v, formattedValue: String(v) });

/** Altera preço no topo e em todas as variantes (baseOptions[0].options). */
export function withPrices(occ: Json, { price, discountPrice }: Opt): Json {
  const o = clone(occ);
  const apply = (n: Json) => {
    if (price !== undefined) n.price = money(price);
    if (discountPrice !== undefined) n.discountPrice = money(discountPrice);
  };
  apply(o);
  for (const v of o.baseOptions?.[0]?.options ?? []) {
    if (price !== undefined) v.priceData = money(price);
    if (discountPrice !== undefined) v.discountPrice = money(discountPrice);
  }
  return o;
}

export const withZeroPrice = (occ: Json): Json => withPrices(occ, { price: 0, discountPrice: 0 });
export const withNegativePrice = (occ: Json): Json => withPrices(occ, { price: -1, discountPrice: -1 });
export const withBadPrice = (occ: Json, bad: unknown): Json => withPrices(occ, { price: bad, discountPrice: bad });
/** discountPrice > price (inconsistente). */
export const withDiscountAbovePrice = (occ: Json): Json => withPrices(occ, { price: 10000, discountPrice: 20000 });
export const withPriceVariations = (occ: Json): Json => {
  const o = clone(occ);
  o.hasPriceVariations = true;
  return o;
};
export const withoutBaseOptions = (occ: Json): Json => {
  const o = clone(occ);
  if (o.baseOptions?.[0]) delete o.baseOptions[0].options;
  return o;
};
