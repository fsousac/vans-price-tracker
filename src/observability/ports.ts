import type { IsoUtc } from '../shared/types.ts';

export type HealthKind =
  | 'circuito_aberto'
  | 'parser_degradado'
  | 'produto_com_falha'
  | 'produto_removido'
  | 'formato_desconhecido';
export type StateKey =
  | 'circuit_open_until'
  | 'circuit_reason'
  | 'circuit_probe_pending'
  | 'catalog_last_refresh_at'
  | 'scheduler_heartbeat_at'
  | 'last_recovery_at';

export interface HealthEventRepo {
  open(kind: HealthKind, subject: string, detail: string | null, now: IsoUtc): { id: number; created: boolean };
  close(kind: HealthKind, subject: string, now: IsoUtc): void;
}
export interface StateRepo {
  get(key: StateKey): string | null;
  set(key: StateKey, value: string, now: IsoUtc): void;
  delete(key: StateKey): void;
}
