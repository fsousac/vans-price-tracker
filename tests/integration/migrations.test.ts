import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDb } from '../../src/db/connection.ts';
import { MIGRATIONS_DIR, migrate } from '../../src/db/migrate.ts';
import { ManualClock } from '../helpers/clock.ts';
import { makeDb } from '../helpers/db.ts';

const clock = () => new ManualClock('2026-10-14T12:00:00.000Z');
const tmp = () => mkdtempSync(join(tmpdir(), 'vans-mig-'));
const TS = '2026-10-14T12:00:00.000Z';

function migDir(files: Record<string, string>): string {
  const d = tmp();
  for (const [n, sql] of Object.entries(files)) writeFileSync(join(d, n), sql);
  return d;
}

test('T-MIG-01 banco vazio recebe o esquema de 0001 e reexecucao e no-op (RNF-MNT-02)', () => {
  const db = openDb(':memory:');
  assert.deepEqual(migrate(db, { clock: clock() }), [1]);
  const tables = db
    .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => (r as { name: string }).name);
  for (const t of ['products', 'product_variants', 'price_observations', 'price_alerts', 'notifications', 'schema_migrations'])
    assert.ok(tables.includes(t), t);
  const before = db.prepare('SELECT * FROM schema_migrations').all();
  assert.deepEqual(migrate(db, { clock: clock() }), []);
  assert.deepEqual(db.prepare('SELECT * FROM schema_migrations').all(), before);
});

test('T-MIG-02 checksum adulterado aborta (RNF-REL-02)', () => {
  const dir = migDir({ '0001_a.sql': 'CREATE TABLE a (x INTEGER) STRICT;' });
  const db = openDb(':memory:');
  migrate(db, { clock: clock(), dir });
  writeFileSync(join(dir, '0001_a.sql'), 'CREATE TABLE a (x INTEGER, y INTEGER) STRICT;');
  assert.throws(() => migrate(db, { clock: clock(), dir }), /editada/);
});

test('T-MIG-03 buraco na sequencia e banco mais novo que o codigo sao recusados', () => {
  const gap = migDir({ '0001_a.sql': 'SELECT 1;', '0003_c.sql': 'SELECT 1;' });
  assert.throws(() => migrate(openDb(':memory:'), { clock: clock(), dir: gap }), /fora de sequência/);

  const two = migDir({ '0001_a.sql': 'SELECT 1;', '0002_b.sql': 'SELECT 1;' });
  const db = openDb(':memory:');
  migrate(db, { clock: clock(), dir: two });
  const one = migDir({ '0001_a.sql': 'SELECT 1;' });
  assert.throws(() => migrate(db, { clock: clock(), dir: one }), /mais novo/);
});

test('T-MIG-04 migracao que falha da rollback e nao registra versao', () => {
  const dir = migDir({
    '0001_a.sql': 'CREATE TABLE a (x INTEGER) STRICT;',
    '0002_b.sql': 'CREATE TABLE b (x INTEGER) STRICT; INSERT INTO nao_existe VALUES (1);',
  });
  const db = openDb(':memory:');
  assert.throws(() => migrate(db, { clock: clock(), dir }));
  const versions = db.prepare('SELECT version FROM schema_migrations').all();
  assert.deepEqual(versions, [{ version: 1 }]);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='b'").get(), undefined);
});

test('T-MIG-05 backup VACUUM INTO antes de pendente em banco nao vazio, retendo 5', () => {
  const root = tmp();
  const backupDir = join(root, 'backups');
  const dbPath = join(root, 'x.db');
  const sqls: Record<string, string> = { '0001_a.sql': 'CREATE TABLE a (x INTEGER) STRICT;' };
  const dir = migDir(sqls);
  const db = openDb(dbPath);
  migrate(db, { clock: clock(), dir, backupDir });
  assert.equal(readdirSync(dir).length, 1);
  assert.throws(() => readdirSync(backupDir), 'banco vazio nao gera backup');

  mkdirSync(backupDir);
  for (let i = 1; i <= 6; i++) writeFileSync(join(backupDir, `vans-alert-pre-0000-2026010${i}T000000.db`), '');
  writeFileSync(join(dir, '0002_b.sql'), 'CREATE TABLE b (x INTEGER) STRICT;');
  assert.deepEqual(migrate(db, { clock: clock(), dir, backupDir }), [2]);
  const files = readdirSync(backupDir).sort();
  assert.equal(files.length, 5);
  assert.ok(files.includes('vans-alert-pre-0002-20261014T120000.db'));
  const copy = openDb(join(backupDir, 'vans-alert-pre-0002-20261014T120000.db'));
  assert.equal(copy.prepare("SELECT 1 FROM sqlite_schema WHERE name='b'").get(), undefined);
  assert.ok(copy.prepare("SELECT 1 FROM sqlite_schema WHERE name='a'").get());
  copy.close();
  db.close();
});

test('T-MIG-06 0001_init.sql e identico ao DDL de data-model.md (secao 3)', () => {
  const doc = readFileSync(new URL('../../docs/data-model.md', import.meta.url), 'utf8');
  const ddl = /```sql\n(-- 0001_init\.sql[\s\S]*?)```/.exec(doc)?.[1];
  assert.ok(ddl);
  assert.equal(readFileSync(new URL('0001_init.sql', MIGRATIONS_DIR), 'utf8').trimEnd(), ddl.trimEnd());
});

test('T-SM-02 price_observations rejeita current_cents=0 (preco de falha inexpressavel)', () => {
  const db = makeDb();
  db.prepare(
    `INSERT INTO products (code, name, created_at, updated_at) VALUES ('ABCDEFGH1234', 'Old Skool', ?, ?)`,
  ).run(TS, TS);
  db.prepare(`INSERT INTO product_variants (variant_code, product_code, size, last_seen_at) VALUES ('ABCDEFGH1234-34', 'ABCDEFGH1234', '34', ?)`).run(TS);
  db.prepare(`INSERT INTO monitoring_runs (kind, trigger, status, started_at, finished_at) VALUES ('monitor','scheduled','ok',?,?)`).run(TS, TS);
  const ins = db.prepare(
    `INSERT INTO price_observations (variant_code, run_id, observed_at, original_cents, current_cents, available, confirmed, degraded, source)
     VALUES ('ABCDEFGH1234-34', 1, ?, 29999, ?, 1, 1, 0, 'occ')`,
  );
  assert.throws(() => ins.run(TS, 0), /CHECK/);
  assert.throws(() => ins.run(TS, -1), /CHECK/);
  assert.equal(ins.run(TS, 19999).changes, 1);
});

test('T-REL-03 segunda rodada running e rejeitada pelo indice unico parcial', () => {
  const db = makeDb();
  const ins = db.prepare(`INSERT INTO monitoring_runs (kind, trigger, status, started_at, finished_at) VALUES ('monitor','scheduled',?,?,?)`);
  ins.run('running', TS, null);
  assert.throws(() => ins.run('running', TS, null), /UNIQUE/);
  assert.equal(ins.run('ok', TS, TS).changes, 1);
});
