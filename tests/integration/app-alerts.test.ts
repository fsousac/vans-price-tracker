import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateAlert } from '../../src/alerts/evaluate.ts';
import { AlertService } from '../../src/app/alerts.ts';
import { createAlertStore } from '../../src/store/alerts.store.ts';
import { createObservationRepo } from '../../src/store/history.store.ts';
import { createMemoryDb } from '../../src/store/memory.ts';
import { createProductRepo } from '../../src/store/monitor.store.ts';
import { IdbNotificationRepo } from '../../src/store/notifications.store.ts';
import { ManualClock } from '../helpers/clock.ts';

const T0 = '2026-10-14T12:00:00.000Z';
const DAY = 86_400_000;
const IN = { target: '199,90', margin: '3' };
const code = (i: number) => `P${String(i).padStart(9, '0')}`;
const V1 = `${code(1)}-34`;

async function setup(products = 1, emailEnabled = true) {
  const db = createMemoryDb();
  const productRepo = createProductRepo(db);
  for (let i = 1; i <= products; i++) {
    await productRepo.upsertProduct({ code: code(i), name: 'Old Skool', legacySku: null, slug: 'old-skool' }, T0);
    await productRepo.upsertVariants(code(i), ['34', '35'].map((s) => ({ variantCode: `${code(i)}-${s}`, size: s, ean: null })), T0);
  }
  const clock = new ManualClock(T0);
  const alerts = createAlertStore(db);
  const observations = createObservationRepo(db);
  const notifications = new IdbNotificationRepo(db);
  const svc = new AlertService({
    alerts, observations, notifications, clock, mode: 'teste', products: productRepo,
    tx: (fn) => db.tx(fn), emailEnabled: async () => emailEnabled,
  });
  let seq = 0;
  const addObs = async (variant: string, cents: number) => {
    await observations.insert({ variantCode: variant, runId: 1, seq: ++seq, observedAt: clock.now().toISOString(), originalCents: 40000, currentCents: cents, available: true, confirmed: true, degraded: false, source: 'occ' });
    return (await observations.latestConfirmed(variant))!;
  };
  const create = async (v: string, i = IN) => {
    const r = await svc.create(v, i);
    assert.ok(r.ok);
    return r.value.id;
  };
  const count = (s: string) => db.count(s);
  return { svc, alerts, notifications, clock, db, count, addObs, create };
}

test('T-IDN-04 criar sem variante, inexistente ou invalido e recusado (RF-03-AC4)', async () => {
  const { svc, count } = await setup();
  assert.deepEqual(await svc.create(undefined, IN), { ok: false, error: { kind: 'sem_variante' } });
  assert.deepEqual(await svc.create('', IN), { ok: false, error: { kind: 'sem_variante' } });
  assert.deepEqual(await svc.create(`${code(1)}-99`, IN), { ok: false, error: { kind: 'variante_inexistente' } });
  const bad = await svc.create(V1, { target: 'x', margin: '99' });
  assert.ok(!bad.ok && bad.error.kind === 'validacao');
  assert.deepEqual(Object.keys(bad.error.fields), ['target', 'margin']);
  assert.equal(await count('alerts'), 0);
});

test('T-MON-02 51o produto distinto ATIVO e recusado ao criar e ao retomar (RF-06-AC3)', async () => {
  const { svc, alerts, create } = await setup(51);
  for (let i = 1; i <= 50; i++) await create(`${code(i)}-34`);
  const r = await svc.create(`${code(51)}-34`, IN);
  assert.ok(!r.ok && r.error.kind === 'limite_produtos');
  await create(`${code(1)}-35`); // mesmo produto nao conta de novo
  const p1 = (await alerts.list()).filter((a) => a.variantCode.startsWith(code(1)));
  for (const a of p1) assert.ok((await svc.pause(a.id)).ok);
  await create(`${code(51)}-34`);
  const back = await svc.resume(p1[0]!.id);
  assert.ok(!back.ok && back.error.kind === 'limite_produtos');
  assert.equal((await alerts.get(p1[0]!.id))!.status, 'PAUSADO');
});

test('T-WEB-07 duplo envio nao duplica alerta (RF-09-AC7)', async () => {
  const { svc, count, create } = await setup();
  await create(V1);
  const r = await svc.create(V1, IN);
  assert.ok(!r.ok && r.error.kind === 'duplicado');
  assert.equal(await count('alerts'), 1);
});

test('T-WEB-02 alvo acima do preco atual e aceito com aviso (RF-04-AC4); sem leitura, sem aviso', async () => {
  const { svc, addObs } = await setup();
  const a = await svc.create(V1, IN);
  assert.ok(a.ok && a.value.warning === null);
  await addObs(V1, 15000);
  const b = await svc.create(V1, { ...IN, target: '200' });
  assert.ok(b.ok);
  assert.deepEqual(b.value.warning, { code: 'alvo_acima_do_preco_atual', currentCents: 15000 });
  const c = await svc.create(V1, { ...IN, target: '100' });
  assert.ok(c.ok && c.value.warning === null);
});

test('T-WEB-02 edicao: alvo reabre travas e revision++ (RN-14); duplicado e inexistente', async () => {
  const { svc, alerts, create } = await setup();
  const id = await create(V1);
  await create(V1, { target: '150', margin: '3' });
  const closed = { armedProximo: false, armedAtingido: false, episodeProximo: 1, episodeAtingido: 1, rearmNotBeforeProximo: null, rearmNotBeforeAtingido: null, evaluatedOnce: true };
  await alerts.applyDecision(id, closed, null, T0);
  assert.ok((await svc.edit(id, IN)).ok); // mesmo alvo/margem: nada reabre
  let a = (await alerts.get(id))!;
  assert.equal(a.revision, 1);
  assert.equal(a.armedAtingido, false);
  assert.ok((await svc.edit(id, { target: '180', margin: '3' })).ok);
  a = (await alerts.get(id))!;
  assert.equal(a.revision, 2);
  assert.ok(a.armedAtingido && a.armedProximo);
  const dup = await svc.edit(id, { target: '150', margin: '3' });
  assert.ok(!dup.ok && dup.error.kind === 'duplicado');
  const miss = await svc.edit(999, IN);
  assert.ok(!miss.ok && miss.error.kind === 'nao_encontrado');
});

test('T-WEB-03 pausa nao cria notificacao e retomar mantem travas (RN-15, RF-09-AC3)', async () => {
  const { svc, alerts, clock, count, addObs, create } = await setup();
  const id = await create(V1);
  const before = (await alerts.get(id))!;
  assert.ok((await svc.pause(id)).ok);
  const paused = (await alerts.get(id))!;
  assert.equal(paused.status, 'PAUSADO');
  assert.equal(paused.pausedAt, T0);
  const ob = await addObs(V1, 10000);
  const d = evaluateAlert(paused, ob, clock.now(), DAY);
  assert.equal(d.reason, 'inativo');
  await svc.apply(paused, d, ob);
  assert.equal(await count('notifications'), 0);
  assert.ok((await svc.resume(id)).ok);
  const back = (await alerts.get(id))!;
  assert.equal(back.status, 'ATIVO');
  assert.equal(back.pausedAt, null);
  assert.equal(back.armedAtingido, before.armedAtingido);
  assert.equal(back.revision, before.revision);
  assert.deepEqual(await svc.pause(999), { ok: false, error: { kind: 'nao_encontrado' } });
});

test('T-WEB-04 excluir apaga alerta e notificacoes; historico permanece (RF-09-AC4)', async () => {
  const { svc, alerts, clock, count, addObs, create } = await setup();
  const id = await create(V1);
  const ob = await addObs(V1, 10000);
  const a = (await alerts.get(id))!;
  await svc.apply(a, evaluateAlert(a, ob, clock.now(), DAY), ob);
  assert.equal(await count('notifications'), 1);
  assert.equal(await svc.delete(id), true);
  assert.equal(await count('alerts'), 0);
  assert.equal(await count('notifications'), 0);
  assert.equal(await count('observations'), 1);
  assert.equal(await svc.delete(id), false);
});

test('T-RN-12 apply cria notificacao com chave composta em texto, idempotente; mudar alvo muda a chave', async () => {
  const { svc, alerts, notifications, clock, count, addObs, create } = await setup();
  const id = await create(V1);
  const ob = await addObs(V1, 10000);
  const a = (await alerts.get(id))!;
  const d = evaluateAlert(a, ob, clock.now(), DAY);
  assert.ok(d.fire);
  const r = await svc.apply(a, d, ob);
  assert.equal(r.notificationKey, `${id}|1|${d.fire.kind}|${d.fire.episode}`);
  const n = (await notifications.get(r.notificationKey!))!;
  assert.equal(n.email, 'PENDENTE');
  assert.equal(n.desktop, 'pendente');
  assert.equal(n.priceCents, 10000);
  assert.equal(n.targetCents, 19990);
  assert.equal(n.size, '34');
  assert.equal(n.productName, 'Old Skool');
  assert.equal(n.mode, 'teste');
  assert.equal((await alerts.get(id))!.evaluatedOnce, true);
  await svc.apply(a, d, ob); // reprocessar o mesmo resultado
  assert.equal(await count('notifications'), 1);
  assert.ok((await svc.edit(id, { target: '300', margin: '3' })).ok);
  const a2 = (await alerts.get(id))!;
  assert.equal(a2.revision, 2);
  const d2 = evaluateAlert(a2, ob, clock.now(), DAY);
  const r2 = await svc.apply(a2, d2, ob);
  assert.ok(r2.notificationKey?.startsWith(`${id}|2|`));
  assert.equal(await count('notifications'), 2);
});

test('T-RF-08 e-mail desligado: notificacao nasce com email desligado; sem disparo nao le settings', async () => {
  const { svc, alerts, notifications, clock, addObs, create } = await setup(1, false);
  const id = await create(V1);
  const ob = await addObs(V1, 10000);
  const a = (await alerts.get(id))!;
  const r = await svc.apply(a, evaluateAlert(a, ob, clock.now(), DAY), ob);
  assert.equal((await notifications.get(r.notificationKey!))!.email, 'desligado');
});

test('T-RN-12 falha no meio do apply faz rollback (nada de travas fechadas sem notificacao)', async () => {
  const { svc, alerts, db, clock, addObs, create } = await setup();
  const id = await create(V1);
  const ob = await addObs(V1, 10000);
  const a = (await alerts.get(id))!;
  const d = evaluateAlert(a, ob, clock.now(), DAY);
  const real = db.add.bind(db);
  db.add = async (s: string, v: unknown) => {
    if (s === 'notifications') throw new Error('boom');
    return real(s, v);
  };
  await assert.rejects(svc.apply(a, d, ob), /boom/);
  db.add = real;
  const after = (await alerts.get(id))!;
  assert.equal(after.evaluatedOnce, a.evaluatedOnce);
  assert.equal(after.armedAtingido, a.armedAtingido);
});
