import type { Db } from '../db/connection.ts';
import type { IsoUtc } from '../shared/types.ts';
import type { StateKey, StateRepo } from './ports.ts';

export function createStateRepo(db: Db): StateRepo {
  const get = db.prepare('SELECT value FROM app_state WHERE key = ?');
  const set = db.prepare(
    'INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
  );
  const del = db.prepare('DELETE FROM app_state WHERE key = ?');
  return {
    get: (key: StateKey) => (get.get(key) as { value: string } | undefined)?.value ?? null,
    set: (key: StateKey, value: string, now: IsoUtc) => void set.run(key, value, now),
    delete: (key: StateKey) => void del.run(key),
  };
}
