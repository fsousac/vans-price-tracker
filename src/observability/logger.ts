import type { Clock } from '../shared/clock.ts';
import type { FailureClass, SourceName } from '../shared/types.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// Fechado de propósito (RNF-PRIV-01): sem campo livre, sem e-mail/corpo/credencial.
export interface LogFields {
  run_id?: number;
  alert_id?: number;
  product_code?: string;
  failure_class?: FailureClass;
  http_status?: number;
  duration_ms?: number;
  source?: SourceName;
  count?: number;
}

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

const ALLOWED = ['run_id', 'alert_id', 'product_code', 'failure_class', 'http_status', 'duration_ms', 'source', 'count'] as const;

// Uma linha JSON por evento; `write` injetável para testes (padrão: console, sem Node).
export function createLogger(
  module: string,
  clock: Clock,
  write: (line: string) => void = (l) => console.log(l.trimEnd()),
): Logger {
  const log = (level: LogLevel) => (event: string, fields: LogFields = {}): void => {
    const rec: Record<string, unknown> = { ts: clock.now().toISOString(), level, module, event };
    // ponytail: allowlist em runtime também, caso um cast ignore o tipo.
    for (const k of ALLOWED) if (fields[k] !== undefined) rec[k] = fields[k];
    write(JSON.stringify(rec) + '\n');
  };
  return { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') };
}
