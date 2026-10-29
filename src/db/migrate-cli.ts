import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SystemClock } from '../shared/clock.ts';
import { openDb } from './connection.ts';
import { migrate } from './migrate.ts';

const path = process.env['DB_PATH'] ?? 'data/vans-alert.db';
mkdirSync(dirname(path), { recursive: true });
const db = openDb(path);
try {
  const applied = migrate(db, { clock: new SystemClock(), backupDir: join('data', 'backups') });
  console.log(applied.length ? `migrações aplicadas: ${applied.join(', ')}` : 'banco já está atualizado');
} catch (e) {
  console.error(`migração falhou: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
} finally {
  db.close();
}
