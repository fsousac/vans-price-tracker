// T-STORE-DB: porta Db em memória (RNF-REL-02: atomicidade multi-registro). Suíte compartilhada com o IndexedDB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dbContractCases } from '../../src/store/db-contract.ts';
import { compareKeys, prefixRange } from '../../src/store/db.ts';
import { createMemoryDb } from '../../src/store/memory.ts';

for (const [name, fn] of dbContractCases) {
  test(`db-contract (memória): ${name}`, () => fn(assert, async () => createMemoryDb()));
}

test('compareKeys segue a ordem do IndexedDB: número < string < array', () => {
  assert.ok(compareKeys(9, 'a') < 0);
  assert.ok(compareKeys('z', ['a']) < 0);
  assert.ok(compareKeys(['a'], ['a', 1]) < 0);
  assert.ok(compareKeys(['a', 'z'], ['a', []]) < 0);
  assert.equal(compareKeys(['a', 1], ['a', 1]), 0);
});

test('prefixRange cobre [prefixo, qualquer coisa]', () => {
  assert.deepEqual(prefixRange('V'), { gte: ['V'], lt: ['V', []] });
});

test('índice inexistente e store inexistente falham alto', async () => {
  const db = createMemoryDb();
  await assert.rejects(db.getAll('kv', { index: 'nope' }));
  await assert.rejects(db.get('nope', 'x'));
});
