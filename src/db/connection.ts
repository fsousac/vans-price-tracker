import Database from 'better-sqlite3';

export type Db = Database.Database;

// PRAGMAs de conexão (data-model.md, seção 1); não pertencem a migração.
export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL'); // em :memory: o SQLite mantém "memory"; sem efeito
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  return db;
}

// Transação com BEGIN IMMEDIATE; commit se retornar, rollback se lançar.
export function transaction<T>(db: Db, fn: () => T): T {
  return db.transaction(fn).immediate();
}
