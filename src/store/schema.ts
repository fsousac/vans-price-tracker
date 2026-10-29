// Esquema do IndexedDB (extension-architecture 7.3/7.4). DB_VERSION = MIGRATIONS.length.
export interface Migrator {
  createStore(name: string, opts: { keyPath: string | string[]; autoIncrement?: boolean }): void;
  createIndex(store: string, name: string, keyPath: string | string[], opts?: { unique?: boolean }): void;
  deleteStore(name: string): void;
  /** Transforma dados na transação de upgrade: devolver valor = substitui; undefined = mantém. */
  forEach(store: string, fn: (value: any) => unknown): void;
}

export type Migration = (m: Migrator) => void;

// MIGRATIONS[n] leva de n a n+1. Aditivas por padrão; destrutiva exige ADR e teste de preservação.
export const MIGRATIONS: readonly Migration[] = [
  (m) => {
    const store = (name: string, keyPath: string | string[], autoIncrement = false) =>
      m.createStore(name, { keyPath, autoIncrement });
    const index = (s: string, name: string, keyPath: string | string[], unique = false) =>
      m.createIndex(s, name, keyPath, { unique });

    store('products', 'code');
    index('products', 'state', 'state');

    store('variants', 'variantCode');
    index('variants', 'productCode', 'productCode');

    store('observations', 'id', true);
    index('observations', 'byVariant', ['variantCode', 'observedAt']);
    index('observations', 'byRunVariantSeq', ['runId', 'variantCode', 'seq'], true);

    store('alerts', 'id', true);
    index('alerts', 'variantCode', 'variantCode');
    index('alerts', 'status', 'status');

    store('notifications', 'key');
    index('notifications', 'alertId', 'alertId');
    index('notifications', 'due', ['emailStatus', 'nextAttemptAt']);

    store('runs', 'id', true);
    index('runs', 'status', 'status');
    index('runs', 'startedAt', 'startedAt');

    store('run_items', ['runId', 'seq']);
    index('run_items', 'productCode', 'productCode');

    store('failure_samples', 'productCode');

    store('health_events', 'id', true);
    // Chave inválida (ex. null) não indexa: o repositório grava closedAt '' enquanto aberto.
    index('health_events', 'open', ['kind', 'subject', 'closedAt']);

    store('outbound_requests', 'id', true);
    index('outbound_requests', 'at', 'at');

    store('catalog', 'code');
    index('catalog', 'gen', 'gen');

    store('kv', 'key');
  },
];

export const DB_VERSION = MIGRATIONS.length;
