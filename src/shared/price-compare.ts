import type { BasisPoints, Cents } from './types.ts';

export type Band = 'ATINGIDO' | 'PROXIMO' | 'ACIMA';

// Aritmética inteira (sem float): P*10000 <= T*(10000+bp). Máx. ~1e11, seguro em Number.
export function classifyBand(priceCents: Cents, targetCents: Cents, marginBp: BasisPoints): Band {
  if (![priceCents, targetCents, marginBp].every((n) => Number.isSafeInteger(n) && n >= 0)) {
    throw new RangeError('classifyBand: entradas devem ser inteiros >= 0');
  }
  if (priceCents <= targetCents) return 'ATINGIDO';
  return priceCents * 10000 <= targetCents * (10000 + marginBp) ? 'PROXIMO' : 'ACIMA';
}
