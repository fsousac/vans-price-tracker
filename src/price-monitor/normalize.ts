// Normalização pura (RN-01..08), compartilhada por OCC e __NEXT_DATA__ (mesma estrutura de variante).
import { err, ok, type Result } from '../shared/result.ts';
import { valueToCents } from '../shared/money.ts';
import type { Cents, ProductCode } from '../shared/types.ts';
import type { VariantSnapshot } from './ports.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const valueOf = (node: unknown): unknown => (isObj(node) ? node.value : undefined);

// RN-02..04. Nó de desconto ausente, null ou value 0 = sem desconto (OCC omite; SSR traz value:0).
// Qualquer outro valor inválido (NaN, negativo, texto) ou desconto > original é preco_invalido, nunca 0.
export function effectivePrice(
  priceNode: unknown,
  discountNode: unknown,
): Result<{ originalCents: Cents; currentCents: Cents }, 'preco_invalido'> {
  const original = valueToCents(valueOf(priceNode));
  if (!original.ok) return original;
  const dv = valueOf(discountNode);
  if (dv === undefined || dv === null || dv === 0) {
    return ok({ originalCents: original.value, currentCents: original.value });
  }
  const discount = valueToCents(dv);
  if (!discount.ok || discount.value > original.value) return err('preco_invalido');
  return ok({ originalCents: original.value, currentCents: discount.value });
}

// RN-06: sellable e stockLevel > 0. stock/stockLevel ausente = indisponível. Ignora stockLevelStatus/purchasable.
export function isAvailable(variant: Obj): boolean {
  const level = isObj(variant.stock) ? variant.stock.stockLevel : undefined;
  return variant.sellable === true && typeof level === 'number' && level > 0;
}

// Tamanho: displayText; senão qualifier "size"; senão sufixo do code. Nunca a url.
function sizeOf(v: Obj, code: string): string {
  if (typeof v.displayText === 'string' && v.displayText.trim()) return v.displayText.trim();
  const q = Array.isArray(v.variantOptionQualifiers) ? v.variantOptionQualifiers : [];
  const s = q.find((x) => isObj(x) && x.qualifier === 'size');
  if (isObj(s) && typeof s.value === 'string' && s.value.trim()) return s.value.trim();
  return code.slice(code.lastIndexOf('-') + 1);
}

// RN-05: preço da variante (priceData + discountPrice) quando ela tem priceData; senão o do produto.
// Variante com preço inválido é contada em `skipped` e não gravada (RN-04).
// Retorna 'formato_desconhecido' se algum code de variante não começa com `{productCode}-` (RF-11-AC14).
export function normalizeVariants(
  raw: unknown[],
  productCode: ProductCode,
  product: { price: unknown; discountPrice: unknown },
): Result<{ variants: VariantSnapshot[]; skipped: number }, 'formato_desconhecido'> {
  const variants: VariantSnapshot[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const v of raw) {
    if (!isObj(v) || typeof v.code !== 'string' || !v.code.startsWith(`${productCode}-`) || seen.has(v.code)) {
      return err('formato_desconhecido');
    }
    seen.add(v.code);
    const own = v.priceData !== undefined;
    const p = own ? effectivePrice(v.priceData, v.discountPrice) : effectivePrice(product.price, product.discountPrice);
    if (!p.ok) {
      skipped++;
      continue;
    }
    variants.push({
      variantCode: v.code,
      size: sizeOf(v, v.code),
      ean: typeof v.ean === 'string' && v.ean !== '' ? v.ean : null,
      ...p.value,
      available: isAvailable(v),
    });
  }
  return ok({ variants, skipped });
}
