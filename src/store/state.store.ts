import type { Db } from './db.ts';
import type { KvKey, KvRepo } from './ports.ts';

// Estado do SW efêmero (circuito, last_tick_at, catálogo): tudo em storage, nada em variável de módulo.
export function createKvStore(db: Db): KvRepo {
  return {
    get: async (key: KvKey) => (await db.get<{ key: string; value: string }>('kv', key))?.value ?? null,
    set: async (key, value) => { await db.put('kv', { key, value }); },
    delete: async (key) => { await db.delete('kv', key); },
  };
}
