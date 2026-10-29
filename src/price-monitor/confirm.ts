import type { Cents, IsoUtc, SourceName } from '../shared/types.ts';

// RN-09 / RN-09a. Função pura, aritmética inteira (sem float).
export interface ConfirmInput {
  candidate: { currentCents: Cents; source: SourceName; observedAt: IsoUtc };
  lastConfirmed: { currentCents: Cents } | null;
  pendingUnconfirmed: { id: number; currentCents: Cents } | null; // leitura anterior ainda não confirmada
}
export type ConfirmDecision =
  | { confirmed: true; confirmsPendingId?: number }
  | { confirmed: false; reason: 'variacao_maior_70pct' | 'fonte_fallback_sem_par' };

// ponytail: coerência da 1ª leitura (preço da variante x produto, desconto <= 70%) não cabe neste contrato;
// o chamador (T24) a verifica e, se incoerente, não confirma sem chamar aqui.
export function decideConfirmation(i: ConfirmInput): ConfirmDecision {
  const { candidate, lastConfirmed, pendingUnconfirmed } = i;
  // (c) par concordante em centavos confirma a pendente e a atual
  if (pendingUnconfirmed && pendingUnconfirmed.currentCents === candidate.currentCents) {
    return { confirmed: true, confirmsPendingId: pendingUnconfirmed.id };
  }
  if (candidate.source !== 'occ') return { confirmed: false, reason: 'fonte_fallback_sem_par' };
  if (!lastConfirmed) return { confirmed: true }; // (b) 1ª leitura OCC
  const { currentCents: old } = lastConfirmed;
  // (a) abs(novo - antigo) * 100 <= 70 * antigo
  return Math.abs(candidate.currentCents - old) * 100 <= 70 * old
    ? { confirmed: true }
    : { confirmed: false, reason: 'variacao_maior_70pct' };
}
