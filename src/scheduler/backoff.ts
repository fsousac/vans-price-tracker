import type { Random } from '../shared/random.ts';
import type { FailureClass } from '../shared/types.ts';

// Atrasos de retentativa e cortesia (architecture.md 5). Puro: sem relógio, sem rede.

export const BASE_DELAY_MS = 5_000; // 5 s, 10 s
export const JITTER = 0.25;
export const RETRY_AFTER_CAP_MS = 60_000;
export const RETRY_AFTER_DEFAULT_MS = 30_000; // 429 sem Retry-After
export const COURTESY_MIN_MS = 2_000;
export const COURTESY_MAX_MS = 5_000;

// Retentativas por item, por classe (RN-18: no máximo 2 por rodada).
export function maxRetries(c: FailureClass): number {
  if (c === 'rede_timeout' || c === 'http_5xx') return 2;
  if (c === 'http_429') return 1;
  return 0; // 403/desafio, conteúdo ruim, host não autorizado: nunca retenta (RNF-LEG-02)
}

// Atraso antes da retentativa nº `retry` (1 = primeira), ou null se não há retentativa.
export function retryDelayMs(
  f: { class: FailureClass; retryAfterMs?: number },
  retry: number,
  rnd: Random,
): number | null {
  if (retry < 1 || retry > maxRetries(f.class)) return null;
  if (f.class === 'http_429') return capRetryAfter(f.retryAfterMs ?? RETRY_AFTER_DEFAULT_MS);
  const exp = BASE_DELAY_MS * 2 ** (retry - 1);
  const delay = Math.round(exp * (1 + JITTER * (2 * rnd.next() - 1)));
  // 5xx/timeout com Retry-After: respeita (teto 60 s), sem encurtar o backoff
  return f.retryAfterMs === undefined ? delay : Math.max(delay, capRetryAfter(f.retryAfterMs));
}

export function capRetryAfter(ms: number): number {
  return Math.min(Math.max(0, ms), RETRY_AFTER_CAP_MS);
}

// Cortesia entre requisições: uniforme em [2 s, 5 s) (o jitter já está no sorteio).
export function courtesyMs(rnd: Random): number {
  return COURTESY_MIN_MS + Math.floor(rnd.next() * (COURTESY_MAX_MS - COURTESY_MIN_MS));
}
