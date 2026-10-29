import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Clock } from '../shared/clock.ts';
import { sha256Hex } from '../shared/hash.ts';
import { type Db, transaction } from './connection.ts';

export const MIGRATIONS_DIR = new URL('../../migrations/', import.meta.url);
const KEEP_BACKUPS = 5;

interface Migration {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

export interface MigrateOptions {
  clock: Clock;
  dir?: string | URL;
  backupDir?: string; // sem backupDir não há backup (ex.: :memory:)
}

function loadMigrations(d: string | URL): Migration[] {
  const dir = d instanceof URL ? fileURLToPath(d) : d;
  const files = readdirSync(dir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();
  return files.map((f, i) => {
    const version = Number(f.slice(0, 4));
    if (version !== i + 1) throw new Error(`migração fora de sequência (esperada ${i + 1}): ${f}`);
    const sql = readFileSync(join(dir, f), 'utf8');
    return { version, name: f.slice(5, -4), sql, checksum: sha256Hex(sql) };
  });
}

const stamp = (d: Date): string => d.toISOString().replace(/[-:]/g, '').slice(0, 15); // yyyymmddThhmmss

function backup(db: Db, dir: string, version: number, now: Date): void {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `vans-alert-pre-${String(version).padStart(4, '0')}-${stamp(now)}.db`);
  db.prepare('VACUUM INTO ?').run(file); // fora de transação; cópia consistente com WAL
  const old = readdirSync(dir)
    .filter((f) => f.startsWith('vans-alert-pre-') && f.endsWith('.db'))
    .sort();
  for (const f of old.slice(0, Math.max(0, old.length - KEEP_BACKUPS))) rmSync(join(dir, f));
}

// Aplica as migrações pendentes; devolve as versões aplicadas. Qualquer erro propaga (a app não sobe).
export function migrate(db: Db, opts: MigrateOptions): number[] {
  const migrations = loadMigrations(opts.dir ?? MIGRATIONS_DIR);
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    checksum   TEXT NOT NULL CHECK (length(checksum) = 64),
    applied_at TEXT NOT NULL
  ) STRICT`);

  const applied = db
    .prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version')
    .all() as { version: number; name: string; checksum: string }[];
  for (const row of applied) {
    const m = migrations[row.version - 1];
    if (!m) throw new Error(`banco na versão ${row.version}, mais novo que o código (${migrations.length}); recusando`);
    if (m.checksum !== row.checksum)
      throw new Error(`migração ${row.version} (${row.name}) já aplicada foi editada: checksum diverge`);
  }

  const pending = migrations.slice(applied.length);
  if (pending.length === 0) return [];

  const nonEmpty = applied.length > 0;
  if (nonEmpty && opts.backupDir) backup(db, opts.backupDir, pending[0]!.version, opts.clock.now());

  const insert = db.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)');
  for (const m of pending) {
    transaction(db, () => {
      db.pragma('defer_foreign_keys = ON');
      db.exec(m.sql);
      insert.run(m.version, m.name, m.checksum, opts.clock.now().toISOString());
    });
  }
  return pending.map((m) => m.version);
}
