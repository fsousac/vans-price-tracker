import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAlertRepo } from '../../src/alerts/alerts.repo.ts';
import { AlertService } from '../../src/alerts/alerts.service.ts';
import { evaluateAlert } from '../../src/alerts/evaluate.ts';
import { transaction } from '../../src/db/connection.ts';
import { SqliteNotificationRepo } from '../../src/notifications/notifications.repo.ts';
import { SqliteObservationRepo } from '../../src/price-history/history.repo.ts';
import { createProductRepo } from '../../src/price-monitor/monitor.repo.ts';
import { makeDb } from '../helpers/db.ts';
import { ManualClock } from '../helpers/clock.ts';

const T0 = '2026-10-14T12:00:00.000Z';
const DAY = 86_400_000;
const IN = { target: '199,90', margin: '3', email: 'a@b.com' };
const code = (i: number) => `P${String(i).padStart(9, '0')}`;
const V1 = `${code(1)}-34`;

function setup(products = 1) {
  const db = makeDb();
  db.exec(`INSERT INTO monitoring_runs (kind, trigger, status, started_at, finished_at) VALUES ('monitor','manual','ok','${T0}','${T0}')`);
  for (let i = 1; i <= products; i++) {
    db.prepare("INSERT INTO products (code, name, last_slug, created_at, updated_at) VALUES (?, 'Old Skool', 'old-skool', ?, ?)").run(code(i), T0, T0);
    for (const s of ['34', '35'])
      db.prepare('INSERT INTO product_variants (variant_code, product_code, size, last_seen_at) VALUES (?, ?, ?, ?)').run(`${code(i)}-${s}`, code(i), s, T0);
  }
  const clock = new ManualClock(T0);
  const alerts = createAlertRepo(db);
  const observations = new SqliteObservationRepo(db);
  const notifications = new SqliteNotificationRepo(db);
  const svc = new AlertService({
    alerts, observations, notifications, clock, mode: 'teste',
    products: createProductRepo(db),
    tx: (fn) => transaction(db, fn),
  });
  const count = (t: string) => (db.prepare(`SELECT count(*) c FROM ${t}`).get() as { c: number }).c;
  const addObs = (variant: string, cents: number) => {
    observations.insert({ variantCode: variant, runId: 1, seq: count('price_observations') + 1, observedAt: clock.now().toISOString(), originalCents: 40000, currentCents: cents, available: true, confirmed: true, degraded: false, source: 'occ' });
    return observations.latestConfirmed(variant)!;
  };
  const create = (v: string, i = IN) => {
    const r = svc.create(v, i);
    assert.ok(r.ok);
    return r.value.id;
  };
  return { svc, alerts, notifications, clock, count, addObs, create };
}

test('T-IDN-04 criar sem variante ou com variante inexistente e recusado (RF-03-AC4)', () => {
  const { svc, count } = setup();
  assert.deepEqual(svc.create(undefined, IN), { ok: false, error: { kind: 'sem_variante' } });
  assert.deepEqual(svc.create('', IN), { ok: false, error: { kind: 'sem_variante' } });
  assert.deepEqual(svc.create(`${code(1)}-99`, IN), { ok: false, error: { kind: 'variante_inexistente' } });
  const bad = svc.create(V1, { ...IN, target: 'x', email: 'y' });
  assert.ok(!bad.ok && bad.error.kind === 'validacao');
  assert.deepEqual(Object.keys(bad.error.fields), ['target', 'email']);
  assert.equal(count('price_alerts'), 0);
});

test('T-MON-02 51o produto distinto com alerta ATIVO e recusado ao criar e ao retomar (RF-06-AC3)', () => {
  const { svc, alerts, create } = setup(51);
  for (let i = 1; i <= 50; i++) create(`${code(i)}-34`);
  const r = svc.create(`${code(51)}-34`, IN);
  assert.ok(!r.ok && r.error.kind === 'limite_produtos');
  create(`${code(1)}-35`); // mesmo produto nao conta de novo
  // pausa o produto 1 inteiro: libera vaga para o 51o; retomar o pausado agora estoura
  const p1 = alerts.list().filter((a) => a.variantCode.startsWith(code(1)));
  for (const a of p1) assert.ok(svc.pause(a.id).ok);
  create(`${code(51)}-34`);
  const back = svc.resume(p1[0]!.id);
  assert.ok(!back.ok && back.error.kind === 'limite_produtos');
  assert.equal(alerts.get(p1[0]!.id)!.status, 'PAUSADO');
});

test('T-WEB-07 duplo envio nao duplica alerta (RF-09-AC7)', () => {
  const { svc, count, create } = setup();
  create(V1);
  const r = svc.create(V1, IN);
  assert.ok(!r.ok && r.error.kind === 'duplicado');
  assert.equal(count('price_alerts'), 1);
});

test('T-WEB-02 alvo acima do preco atual e aceito com aviso (RF-04-AC4); sem leitura, sem aviso', () => {
  const { svc, addObs } = setup();
  const a = svc.create(V1, IN);
  assert.ok(a.ok && a.value.warning === null);
  addObs(V1, 15000);
  const b = svc.create(V1, { ...IN, target: '200' });
  assert.ok(b.ok);
  assert.deepEqual(b.value.warning, { code: 'alvo_acima_do_preco_atual', currentCents: 15000 });
  const c = svc.create(V1, { ...IN, target: '100' });
  assert.ok(c.ok && c.value.warning === null);
});

test('T-WEB-02 edicao: alvo reabre travas e revision++; so e-mail nao reabre (RN-14, RF-09-AC2)', () => {
  const { svc, alerts, create } = setup();
  const id = create(V1);
  const rev = alerts.get(id)!.revision;
  const closed = { armedProximo: false, armedAtingido: false, episodeProximo: 1, episodeAtingido: 1, rearmNotBeforeProximo: null, rearmNotBeforeAtingido: null, evaluatedOnce: true };
  alerts.applyDecision(id, closed, null, T0);
  assert.ok(svc.edit(id, { ...IN, email: 'novo@b.com' }).ok);
  let a = alerts.get(id)!;
  assert.equal(a.revision, rev);
  assert.equal(a.email, 'novo@b.com');
  assert.equal(a.armedAtingido, false);
  assert.ok(svc.edit(id, { ...IN, target: '150', email: 'novo@b.com' }).ok);
  a = alerts.get(id)!;
  assert.equal(a.revision, rev + 1);
  assert.ok(a.armedAtingido && a.armedProximo);
  const miss = svc.edit(999, IN);
  assert.ok(!miss.ok && miss.error.kind === 'nao_encontrado');
});

test('T-WEB-03 pausa nao cria notificacao e retomar mantem travas (RN-15, RF-09-AC3)', () => {
  const { svc, alerts, clock, count, addObs, create } = setup();
  const id = create(V1);
  const before = alerts.get(id)!;
  assert.ok(svc.pause(id).ok);
  const paused = alerts.get(id)!;
  assert.equal(paused.status, 'PAUSADO');
  assert.equal(paused.pausedAt, T0);
  const ob = addObs(V1, 10000);
  const d = evaluateAlert(paused, ob, clock.now(), DAY);
  assert.equal(d.reason, 'inativo');
  svc.apply(paused, d, ob);
  assert.equal(count('notifications'), 0);
  assert.ok(svc.resume(id).ok);
  const back = alerts.get(id)!;
  assert.equal(back.status, 'ATIVO');
  assert.equal(back.pausedAt, null);
  assert.equal(back.armedAtingido, before.armedAtingido);
  assert.equal(back.revision, before.revision);
});

test('T-WEB-04 excluir apaga alerta e notificacoes; historico permanece (RF-09-AC4)', () => {
  const { svc, alerts, clock, count, addObs, create } = setup();
  const id = create(V1);
  const ob = addObs(V1, 10000);
  const a = alerts.get(id)!;
  svc.apply(a, evaluateAlert(a, ob, clock.now(), DAY), ob);
  assert.equal(count('notifications'), 1);
  assert.equal(svc.delete(id), true);
  assert.equal(svc.delete(id), false);
  assert.equal(count('price_alerts'), 0);
  assert.equal(count('notifications'), 0);
  assert.equal(count('price_observations'), 1);
});

test('T-DUP-07 apply persiste decisao e cria 1 notificacao idempotente com snapshot (RN-12)', () => {
  const { svc, alerts, notifications, clock, count, addObs, create } = setup();
  const id = create(V1);
  const ob = addObs(V1, 15000);
  const a = alerts.get(id)!;
  const d = evaluateAlert(a, ob, clock.now(), DAY);
  assert.equal(d.fire?.kind, 'ATINGIDO');
  const r1 = svc.apply(a, d, ob);
  const r2 = svc.apply(a, d, ob); // reprocessamento
  assert.equal(r1.notificationId, r2.notificationId);
  assert.equal(count('notifications'), 1);
  const n = notifications.listForAlert(id)[0]!;
  assert.equal(n.priceCents, 15000);
  assert.equal(n.size, '34');
  assert.equal(n.productName, 'Old Skool');
  assert.equal(n.alreadyInBand, true);
  assert.equal(n.idempotencyKey.length, 64);
  assert.equal(alerts.get(id)!.armedAtingido, false);
});
