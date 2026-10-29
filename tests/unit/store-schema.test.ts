// T-STORE-SCHEMA: esquema v1 (7.3) e migração (7.4) testados em Node com a memória.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DB_VERSION, MIGRATIONS, type Migration } from '../../src/store/schema.ts';
import { createMemoryDb } from '../../src/store/memory.ts';

const V1 = MIGRATIONS[0]!;

test('esquema v1 tem as 12 stores e DB_VERSION = MIGRATIONS.length', () => {
  assert.equal(DB_VERSION, MIGRATIONS.length);
  const s = createMemoryDb().dump();
  assert.deepEqual(Object.keys(s.stores).sort(), [
    'alerts', 'catalog', 'failure_samples', 'health_events', 'kv', 'notifications',
    'observations', 'outbound_requests', 'products', 'run_items', 'runs', 'variants',
  ]);
  assert.equal(s.version, DB_VERSION);
  assert.deepEqual(Object.keys(s.stores.observations!.indexes).sort(), ['byRunVariantSeq', 'byVariant']);
  assert.equal(s.stores.observations!.indexes.byRunVariantSeq!.unique, true);
});

// passo 2 de teste: índice novo + transformação de dados (dinheiro continua em centavos inteiros)
const step2: Migration = (m) => {
  m.createIndex('alerts', 'byTarget', 'targetCents');
  m.forEach('alerts', (a) => ({ ...a, marginBp: a.marginBp ?? 0 }));
  m.createStore('extra', { keyPath: 'id' });
};

test('migra v1 -> v2 preservando dados, transformando e criando índice/store', async () => {
  const old = createMemoryDb({ migrations: [V1] });
  await old.add('alerts', { variantCode: 'A', status: 'ativo', targetCents: 30000 });
  await old.add('alerts', { variantCode: 'B', status: 'ativo', targetCents: 20000, marginBp: 50 });
  await old.put('kv', { key: 'settings', v: 1 });

  const db = createMemoryDb({ state: old.dump(), migrations: [V1, step2] });
  assert.equal(db.dump().version, 2);
  assert.deepEqual(await db.get('kv', 'settings'), { key: 'settings', v: 1 });
  const byTarget = await db.getAll<{ variantCode: string; marginBp: number }>('alerts', { index: 'byTarget' });
  assert.deepEqual(byTarget.map((a) => [a.variantCode, a.marginBp]), [['B', 50], ['A', 0]]);
  await db.put('extra', { id: 1 });
  assert.equal(await db.add('alerts', { variantCode: 'C', status: 'x', targetCents: 1 }), 3); // autoincremento mantido
});

test('base mais nova que o código => VersionError, sem criar base vazia', () => {
  const novo = createMemoryDb({ migrations: [V1, step2] }).dump();
  assert.throws(() => createMemoryDb({ state: novo, migrations: [V1] }), { name: 'VersionError' });
});

test('migração que falha não altera o estado de origem', async () => {
  const old = createMemoryDb({ migrations: [V1] });
  await old.put('kv', { key: 'a', v: 1 });
  const state = old.dump();
  const boom: Migration = (m) => { m.forEach('kv', () => ({ key: 'zz' })); throw new Error('falha no upgrade'); };
  assert.throws(() => createMemoryDb({ state, migrations: [V1, boom] }), /falha no upgrade/);
  assert.equal(state.version, 1);
  assert.deepEqual(await createMemoryDb({ state, migrations: [V1] }).get('kv', 'a'), { key: 'a', v: 1 });
});

test('índice único criado sobre dados duplicados falha (ConstraintError)', async () => {
  const old = createMemoryDb({ migrations: [V1] });
  await old.add('alerts', { variantCode: 'A', status: 's' });
  await old.add('alerts', { variantCode: 'A', status: 's' });
  const uniq: Migration = (m) => m.createIndex('alerts', 'u', 'variantCode', { unique: true });
  assert.throws(() => createMemoryDb({ state: old.dump(), migrations: [V1, uniq] }), { name: 'ConstraintError' });
});
