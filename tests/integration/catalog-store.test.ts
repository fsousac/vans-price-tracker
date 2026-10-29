import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDb } from '../../src/store/memory.ts';
import { createCatalogStore } from '../../src/store/catalog.store.ts';
import type { CatalogItem } from '../../src/store/ports.ts';

const T1 = '2026-10-14T12:00:00.000Z';
const T2 = '2026-10-15T12:00:00.000Z';
const item = (code: string, name: string): CatalogItem => ({ code, name, lastSlug: null, priceCents: 49999 });
const SEED = [
  item('1000000000001U', 'Old Skool Era Navy'),
  item('1000000000002U', 'Tênis ERA 59'),
  item('1000000000003U', 'Authentic Preto'),
  item('1000000000004U', 'Sk8-Hi Camuflado'),
];
const codes = (xs: CatalogItem[]) => xs.map((i) => i.code);
async function seeded() {
  const s = createCatalogStore(createMemoryDb());
  const g = await s.begin();
  await s.putPage(g, SEED.slice(0, 2));
  await s.putPage(g, SEED.slice(2));
  await s.commitGen(g, T1);
  return s;
}

test('T-CAT-01 busca "era" só acha nomes com "era", sem acento/caixa; limit respeitado', async () => {
  const s = await seeded();
  assert.deepEqual(codes(await s.search('era', 10)), ['1000000000001U', '1000000000002U']);
  assert.deepEqual(codes(await s.search('TÊNIS', 10)), ['1000000000002U']);
  assert.equal((await s.search('zzz', 10)).length, 0);
  assert.equal((await s.search('%', 10)).length, 0);
  assert.equal((await s.search('', 3)).length, 3);
  assert.equal(await s.count(), 4);
});

test('T-CAT-02 páginas gravadas sem commit ficam invisíveis (catálogo vazio)', async () => {
  const s = createCatalogStore(createMemoryDb());
  const g = await s.begin();
  await s.putPage(g, SEED);
  assert.equal(await s.count(), 0);
  assert.deepEqual(await s.search('era', 10), []);
  assert.equal(await s.refreshedAt(), null);
});

test('T-CAT-03 RF-01 atualização interrompida não altera a geração visível', async () => {
  const s = await seeded();
  const g2 = await s.begin();
  await s.putPage(g2, [item('2000000000001U', 'Era Nova Meia Página')]);
  await s.setCursor({ gen: g2, page: 1 });
  assert.equal(await s.count(), 4);
  assert.deepEqual(codes(await s.search('era', 10)), ['1000000000001U', '1000000000002U']);
  assert.equal(await s.refreshedAt(), T1);
  assert.deepEqual(await s.getCursor(), { gen: g2, page: 1 });
});

test('T-CAT-03 mesmo code em geração nova não corrompe a visível', async () => {
  const s = await seeded();
  const g2 = await s.begin();
  await s.putPage(g2, [{ ...SEED[0]!, name: 'Renomeado', priceCents: 1 }]);
  assert.equal((await s.search('old skool', 5))[0]!.priceCents, 49999);
});

test('T-CAT-04 swap troca a geração, apaga a antiga, grava data e limpa o cursor', async () => {
  const db = createMemoryDb();
  const s = createCatalogStore(db);
  let g = await s.begin();
  await s.putPage(g, SEED);
  await s.commitGen(g, T1);
  g = await s.begin();
  await s.putPage(g, [item('2000000000001U', 'Era Nova'), item('2000000000002U', 'Slip-On')]);
  await s.commitGen(g, T2);
  assert.equal(await s.count(), 2);
  assert.deepEqual(codes(await s.search('era', 10)), ['2000000000001U']);
  assert.equal(await s.refreshedAt(), T2);
  assert.equal(await s.getCursor(), null);
  assert.equal(await db.count('catalog'), 2); // geração antiga apagada fisicamente
});

test('T-CAT-05 begin descarta restos de tentativa abandonada e usa gen nova', async () => {
  const s = await seeded();
  const gA = await s.begin();
  await s.putPage(gA, [item('3000000000001U', 'Resto')]);
  const gB = await s.begin();
  assert.ok(gB > gA);
  await s.putPage(gB, [item('3000000000002U', 'Limpo')]);
  await s.commitGen(gB, T2);
  assert.deepEqual(codes(await s.search('', 10)), ['3000000000002U']);
});

test('T-CAT-05 putPage repetida (retomada) é idempotente', async () => {
  const s = createCatalogStore(createMemoryDb());
  const g = await s.begin();
  await s.putPage(g, SEED);
  await s.putPage(g, SEED);
  await s.commitGen(g, T1);
  assert.equal(await s.count(), 4);
});
