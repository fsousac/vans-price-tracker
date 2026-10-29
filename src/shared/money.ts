import { err, ok, type Result } from './result.ts';
import type { Cents } from './types.ts';

export type TargetError = 'vazio' | 'formato_invalido' | 'nao_positivo' | 'casas_decimais' | 'acima_do_maximo';

export const MAX_TARGET_CENTS = 9_999_999; // R$ 99.999,99 (RN-10)

// RN-01: round(value*100); se não for decimal de 2 casas (tolerância 1e-6), é falha de extração, nunca preço.
export function valueToCents(value: unknown): Result<Cents, 'preco_invalido'> {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return err('preco_invalido');
  const cents = Math.round(value * 100);
  if (Math.abs(value * 100 - cents) > 1e-6 || !Number.isSafeInteger(cents) || cents <= 0) return err('preco_invalido');
  return ok(cents);
}

// RN-10 / D-07: ',' ou '.' decimal; milhar '.' só com decimal ','; máx. 2 casas; sem arredondar.
export function parseBrlToCents(input: string): Result<Cents, TargetError> {
  const s = input.trim();
  if (s === '') return err('vazio');
  let m: RegExpMatchArray | null;
  let int: string;
  let frac = '';
  if ((m = s.match(/^(\d{1,3}(?:\.\d{3})+),(\d+)$/))) {
    int = m[1]!.replaceAll('.', '');
    frac = m[2]!;
  } else if ((m = s.match(/^(\d+)(?:[.,](\d+))?$/))) {
    int = m[1]!;
    frac = m[2] ?? '';
  } else if (/^-\d+(?:[.,]\d+)?$/.test(s)) {
    return err('nao_positivo');
  } else {
    return err('formato_invalido');
  }
  if (frac.length > 2) return err('casas_decimais');
  const cents = Number(int) * 100 + Number(frac.padEnd(2, '0'));
  if (cents <= 0) return err('nao_positivo');
  if (cents > MAX_TARGET_CENTS) return err('acima_do_maximo');
  return ok(cents);
}

// 123456 -> 'R$ 1.234,56' (espaço comum, sem Intl para saída estável)
export function formatBrl(cents: Cents): string {
  const int = Math.trunc(cents / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `R$ ${int},${String(cents % 100).padStart(2, '0')}`;
}

// Inteiro arredondado; 0 se original inválido ou sem desconto.
export function percentOff(originalCents: Cents, currentCents: Cents): number {
  if (originalCents <= 0 || currentCents >= originalCents) return 0;
  return Math.round(((originalCents - currentCents) * 100) / originalCents);
}
