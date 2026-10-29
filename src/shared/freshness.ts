export type Freshness = 'fresco' | 'defasado' | 'sem_dados';

const DAY_MS = 24 * 60 * 60 * 1000;

// RN-17: idade = now - última observação confirmada. fresco <= 2*I; defasado <= 24 h; senão (ou nunca) sem_dados.
export function freshness(lastConfirmedAt: Date | string | null | undefined, now: Date, intervalMs: number): Freshness {
  if (lastConfirmedAt == null) return 'sem_dados';
  const last = new Date(lastConfirmedAt).getTime();
  if (Number.isNaN(last)) return 'sem_dados'; // dado ilegível nunca vira "fresco"
  const age = now.getTime() - last;
  if (age <= 2 * intervalMs) return 'fresco';
  if (age <= DAY_MS) return 'defasado';
  return 'sem_dados';
}
