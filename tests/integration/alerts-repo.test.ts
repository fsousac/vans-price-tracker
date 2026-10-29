import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAlertRepo } from '../../src/alerts/alerts.repo.ts';
import { AlertDuplicate, type Decision, VariantNotFound } from '../../src/alerts/ports.ts';
import { makeDb } from '../helpers/db.ts';

const T0 = '2026-10-14T12:00:00.000Z';
const T1 = '2026-10-14T13:00:00.000Z';
const P = '1003800580026U';
const V = `${P}-34`;
const NEW = { variantCode: V, targetCents: 19990, marginBp: 300, email: 'a@b.com' };

function setup() {
  const db = makeDb();
  db.prepare("INSERT INTO products (code, name, created_at, updated_at) VALUES (?, 'Tenis', ?, ?)").run(P, T0, T0);
  for (const [v, s] of [[V, '34'], [`${P}-35`, '35']])
    db.prepare('INSERT INTO product_variants (variant_code, product_code, size, last_seen_at) VALUES (?, ?, ?, ?)').run(v, P, s, T0);
  return { db, repo: createAlertRepo(db) };
}

test('T-WEB-07 alerta identico = AlertDuplicate; variante inexistente = VariantNotFound (RF-09-AC7)', () => {
  const { repo } = setup();
  const id = repo.create(NEW, T0);
  assert.ok(id > 0);
  assert.throws(() => repo.create(NEW, T0), AlertDuplicate);
  assert.ok(repo.create({ ...NEW, targetCents: 15000 }, T0) > id); // alvo diferente nao e duplicado
  assert.throws(() => repo.create({ ...NEW, variantCode: `${P}-99` }, T0), VariantNotFound);
  assert.equal(repo.list().length, 2);
});

test('T-RN-12 edicao de alvo/margem incrementa revisao e reabre travas; so e-mail nao (RN-14)', () => {
  const { repo } = setup();
  const id = repo.create(NEW, T0);
  const closed: Decision['next'] = {
    armedProximo: false, armedAtingido: false, episodeProximo: 2, episodeAtingido: 3,
    rearmNotBeforeProximo: T1, rearmNotBeforeAtingido: T1, evaluatedOnce: true,
  };
  repo.applyDecision(id, closed, null, T0);

  repo.update(id, { email: 'novo@b.com' }, T1);
  let a = repo.get(id)!;
  assert.equal(a.revision, 1);
  assert.equal(a.email, 'novo@b.com');
  assert.equal(a.armedProximo, false);

  repo.update(id, { targetCents: 18000 }, T1);
  a = repo.get(id)!;
  assert.equal(a.revision, 2);
  assert.equal(a.targetCents, 18000);
  assert.equal(a.armedProximo, true);
  assert.equal(a.armedAtingido, true);
  assert.equal(a.rearmNotBeforeProximo, null);
  assert.equal(a.rearmNotBeforeAtingido, null);
  assert.equal(a.episodeAtingido, 3); // episodio preservado
  assert.equal(a.updatedAt, T1);

  repo.update(id, { marginBp: 0 }, T1);
  assert.equal(repo.get(id)!.revision, 3);
  repo.create({ ...NEW, targetCents: 5000, email: 'novo@b.com' }, T0);
  assert.throws(() => repo.update(id, { targetCents: 5000, marginBp: 300 }, T1), AlertDuplicate); // edicao colidindo
});

test('T-WEB-02 pausa/retomada mantem travas e activeByProduct so devolve ATIVO (RN-15)', () => {
  const { repo } = setup();
  const id = repo.create(NEW, T0);
  const id2 = repo.create({ ...NEW, variantCode: `${P}-35` }, T0);
  assert.deepEqual(repo.activeByProduct(P).map((a) => a.id), [id, id2]);

  repo.update(id, { status: 'PAUSADO' }, T0);
  assert.equal(repo.get(id)!.pausedAt, T0);
  assert.equal(repo.get(id)!.revision, 1);
  repo.update(id, { status: 'PAUSADO' }, T1); // repetir nao move paused_at
  assert.equal(repo.get(id)!.pausedAt, T0);
  assert.deepEqual(repo.activeByProduct(P).map((a) => a.id), [id2]);
  assert.deepEqual(repo.activeByProduct('OUTROPRODUTO1'), []);

  repo.update(id, { status: 'ATIVO' }, T1);
  assert.equal(repo.get(id)!.pausedAt, null);
  assert.equal(repo.activeByProduct(P).length, 2);
});

test('T-RN-12 applyDecision persiste travas, episodios, rearme e last_sent do tipo disparado', () => {
  const { repo } = setup();
  const id = repo.create(NEW, T0);
  repo.applyDecision(
    id,
    { armedProximo: true, armedAtingido: false, episodeProximo: 1, episodeAtingido: 1,
      rearmNotBeforeProximo: null, rearmNotBeforeAtingido: T1, evaluatedOnce: true },
    { kind: 'ATINGIDO', episode: 1, alreadyInBand: false },
    T1,
  );
  const a = repo.get(id)!;
  assert.equal(a.armedAtingido, false);
  assert.equal(a.armedProximo, true);
  assert.equal(a.rearmNotBeforeAtingido, T1);
  assert.equal(a.evaluatedOnce, true);
  assert.equal(a.lastSentAtingidoAt, T1);
  assert.equal(a.lastSentProximoAt, null);
  assert.equal(a.revision, 1);
});

test('T-WEB-04 / T-PRV-03 delete apaga notificacoes (cascade) e e-mail, preserva historico (RF-09-AC4, RNF-PRIV-03)', () => {
  const { db, repo } = setup();
  const id = repo.create(NEW, T0);
  const keep = repo.create({ ...NEW, email: 'outro@b.com' }, T0);
  db.prepare("INSERT INTO monitoring_runs (kind, trigger, status, started_at, finished_at) VALUES ('monitor','manual','ok',?,?)").run(T0, T0);
  db.prepare(
    "INSERT INTO price_observations (variant_code, run_id, observed_at, original_cents, current_cents, available, confirmed, degraded, source) VALUES (?, 1, ?, 29990, 19990, 1, 1, 0, 'occ')",
  ).run(V, T0);
  const notif = db.prepare(
    "INSERT INTO notifications (alert_id, observation_id, kind, idempotency_key, mode, created_at, updated_at) VALUES (?, 1, 'ATINGIDO', ?, 'teste', ?, ?)",
  );
  notif.run(id, 'a'.repeat(64), T0, T0);
  notif.run(keep, 'b'.repeat(64), T0, T0);

  repo.delete(id);
  assert.equal(repo.get(id), null);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM notifications WHERE alert_id = ?').get(id) as { n: number }).n, 0);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM notifications').get() as { n: number }).n, 1);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM price_observations').get() as { n: number }).n, 1);
  assert.ok(repo.get(keep));
});
