import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAlertStore } from '../../src/store/alerts.store.ts';
import { createMemoryDb } from '../../src/store/memory.ts';
import { AlertDuplicate, type Decision, VariantNotFound } from '../../src/store/ports.ts';

const T0 = '2026-10-14T12:00:00.000Z';
const T1 = '2026-10-14T13:00:00.000Z';
const P = '1003800580026U';
const V = `${P}-34`;
const NEW = { variantCode: V, targetCents: 19990, marginBp: 300 };

async function setup() {
  const db = createMemoryDb();
  await db.put('products', { code: P, name: 'Tenis', state: 'ATIVO' });
  for (const s of ['34', '35']) await db.put('variants', { variantCode: `${P}-${s}`, productCode: P, size: s });
  return { db, repo: createAlertStore(db) };
}

test('T26 T-WEB-07 duplicado identico = AlertDuplicate; variante inexistente = VariantNotFound (RF-09-AC7)', async () => {
  const { repo } = await setup();
  const id = await repo.create(NEW, T0);
  await assert.rejects(repo.create(NEW, T0), AlertDuplicate);
  assert.ok((await repo.create({ ...NEW, targetCents: 15000 }, T0)) > id);
  await assert.rejects(repo.create({ ...NEW, variantCode: `${P}-99` }, T0), VariantNotFound);
  assert.equal((await repo.list()).length, 2);
});

test('T26 T-RN-12 edicao de alvo/margem incrementa revisao e reabre travas; status nao (RN-14)', async () => {
  const { repo } = await setup();
  const id = await repo.create(NEW, T0);
  const closed: Decision['next'] = {
    armedProximo: false, armedAtingido: false, episodeProximo: 2, episodeAtingido: 3,
    rearmNotBeforeProximo: T1, rearmNotBeforeAtingido: T1, evaluatedOnce: true,
  };
  await repo.applyDecision(id, closed, null, T0);
  await repo.update(id, { status: 'PAUSADO' }, T1);
  let a = (await repo.get(id))!;
  assert.equal(a.revision, 1);
  assert.equal(a.armedProximo, false);

  await repo.update(id, { targetCents: 18000 }, T1);
  a = (await repo.get(id))!;
  assert.equal(a.revision, 2);
  assert.equal(a.targetCents, 18000);
  assert.ok(a.armedProximo && a.armedAtingido);
  assert.equal(a.rearmNotBeforeProximo, null);
  assert.equal(a.rearmNotBeforeAtingido, null);
  assert.equal(a.episodeAtingido, 3);
  assert.equal(a.updatedAt, T1);

  await repo.update(id, { marginBp: 0 }, T1);
  assert.equal((await repo.get(id))!.revision, 3);
  await repo.create({ ...NEW, targetCents: 5000 }, T0);
  await assert.rejects(repo.update(id, { targetCents: 5000, marginBp: 300 }, T1), AlertDuplicate);
  assert.equal((await repo.get(id))!.targetCents, 18000);
});

test('T26 T-WEB-02 pausa/retomada e activeByProduct so devolve ATIVO (RN-15)', async () => {
  const { repo } = await setup();
  const id = await repo.create(NEW, T0);
  const id2 = await repo.create({ ...NEW, variantCode: `${P}-35` }, T0);
  assert.deepEqual((await repo.activeByProduct(P)).map((a) => a.id), [id, id2]);
  await repo.update(id, { status: 'PAUSADO' }, T0);
  await repo.update(id, { status: 'PAUSADO' }, T1);
  assert.equal((await repo.get(id))!.pausedAt, T0);
  assert.deepEqual((await repo.activeByProduct(P)).map((a) => a.id), [id2]);
  assert.deepEqual(await repo.activeByProduct('OUTROPRODUTO1'), []);
  await repo.update(id, { status: 'ATIVO' }, T1);
  assert.equal((await repo.get(id))!.pausedAt, null);
  assert.equal((await repo.activeByProduct(P)).length, 2);
});

test('T26 T-RN-12 applyDecision persiste travas, episodios, rearme e lastSent do tipo disparado', async () => {
  const { repo } = await setup();
  const id = await repo.create(NEW, T0);
  await repo.applyDecision(
    id,
    { armedProximo: true, armedAtingido: false, episodeProximo: 1, episodeAtingido: 1,
      rearmNotBeforeProximo: null, rearmNotBeforeAtingido: T1, evaluatedOnce: true },
    { kind: 'ATINGIDO', episode: 1, alreadyInBand: false },
    T1,
  );
  const a = (await repo.get(id))!;
  assert.equal(a.armedAtingido, false);
  assert.equal(a.armedProximo, true);
  assert.equal(a.rearmNotBeforeAtingido, T1);
  assert.ok(a.evaluatedOnce);
  assert.equal(a.lastSentAtingidoAt, T1);
  assert.equal(a.lastSentProximoAt, null);
  assert.equal(a.revision, 1);
});

test('T26 T-WEB-04 T-PRV-03 delete apaga notificacoes (cascata) e preserva historico (RF-09-AC4, RNF-PRIV-03)', async () => {
  const { db, repo } = await setup();
  const id = await repo.create(NEW, T0);
  const keep = await repo.create({ ...NEW, targetCents: 1 }, T0);
  await db.add('observations', { variantCode: V, runId: 1, seq: 0, observedAt: T0, currentCents: 19990 });
  await db.put('notifications', { key: `${id}|1|ATINGIDO|1`, alertId: id });
  await db.put('notifications', { key: `${keep}|1|ATINGIDO|1`, alertId: keep });
  await repo.delete(id);
  assert.equal(await repo.get(id), null);
  assert.equal(await db.count('notifications'), 1);
  assert.equal(await db.count('observations'), 1);
  assert.ok(await repo.get(keep));
});
