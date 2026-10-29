import { type Db, openDb } from '../../src/db/connection.ts';
import { migrate } from '../../src/db/migrate.ts';
import { ManualClock } from './clock.ts';

// Banco :memory: com as migrações reais.
export function makeDb(): Db {
  const db = openDb(':memory:');
  migrate(db, { clock: new ManualClock('2026-10-14T12:00:00.000Z') });
  return db;
}
