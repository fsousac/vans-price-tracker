import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Db } from '../../src/db/connection.ts';
import { createHealthEventRepo } from '../../src/observability/events.repo.ts';
import { buildHealth, type HealthDeps } from '../../src/observability/health.ts';
import { createHealthReadRepo } from '../../src/observability/health.repo.ts';
import { createStateRepo } from '../../src/observability/state.repo.ts';
import { ManualClock } from '../helpers/clock.ts';
import { makeDb } from '../helpers/db.ts';

const T0 = '2026-10-14T12:00:00.000Z';
const H = 3_600_000;
const iso = (ms: number) => new Date(new Date(T0).getTime() + ms).toISOString();

function setup() {
  const db = makeDb();
  const clock = new ManualClock(T0);
  const state = createStateRepo(db);
  const deps: HealthDeps = {
    repo: createHealthReadRepo(db),
    state,
    clock,
    version: '0.1.0',
    emailMode: 'teste',
    intervalMs: 4 * H,
    startedAt: new Date(T0),
  };
  return { db, clock, state, deps };
}

function seed(db: Db): void {
  db.exec(`INSERT INTO products (code, name, created_at, updated_at) VALUES ('P0000001', 'Tenis', '${T0}', '${T0}');
    INSERT INTO product_variants (variant_code, product_code, size, last_seen_at) VALUES ('P0000001-34', 'P0000001', '34', '${T0}');
    INSERT INTO price_alerts (variant_code, target_cents, email, created_at, updated_at)
      VALUES ('P0000001-34', 20000, 'segredo@example.com', '${T0}', '${T0}');`);
}
function addRun(db: Db, status: string, startedMs: number, finishedMs: number | null, skip: string | null = null): number {
  const r = db
    .prepare("INSERT INTO monitoring_runs (kind, trigger, status, skip_reason, started_at, finished_at) VALUES ('monitor','scheduled',?,?,?,?)")
    .run(status, skip, iso(startedMs), finishedMs === null ? null : iso(finishedMs));
  return Number(r.lastInsertRowid);
}
function addObs(db: Db, runId: number, atMs: number, source = 'occ', seq = 1): void {
  db.prepare(
    'INSERT INTO price_observations (variant_code, run_id, seq, observed_at, original_cents, current_cents, available, confirmed, degraded, source) VALUES (?,?,?,?,?,?,1,1,0,?)',
  ).run('P0000001-34', runId, seq, iso(atMs), 30000, 25000, source);
}

test('T-OBS-03 open() duas vezes = 1 episodio; close e reabertura criam novo (RNF-OBS-03)', () => {
  const db = makeDb();
  const ev = createHealthEventRepo(db);
  const a = ev.open('circuito_aberto', 'global', 'http_403_ou_desafio', T0);
  const b = ev.open('circuito_aberto', 'global', null, iso(1000));
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(b.id, a.id);
  assert.equal(ev.open('produto_removido', 'global', null, T0).created, true); // outro kind, outro episodio
  ev.close('circuito_aberto', 'global', iso(2000));
  const c = ev.open('circuito_aberto', 'global', null, iso(3000));
  assert.equal(c.created, true);
  assert.notEqual(c.id, a.id);
  assert.equal((db.prepare('SELECT count(*) n FROM health_events WHERE kind = ?').get('circuito_aberto') as { n: number }).n, 2);
  ev.close('parser_degradado', 'nada', T0); // fechar o que nao existe e no-op
});

test('T-SAU-05 state repo: get/set/delete e upsert', () => {
  const { state } = setup();
  assert.equal(state.get('circuit_reason'), null);
  state.set('circuit_reason', 'a', T0);
  state.set('circuit_reason', 'b', iso(1));
  assert.equal(state.get('circuit_reason'), 'b');
  state.delete('circuit_reason');
  assert.equal(state.get('circuit_reason'), null);
});

test('T-SAU-01 payload tem os campos de RF-12-AC1 e nao contem PII nem segredo', () => {
  const { db, deps } = setup();
  seed(db);
  const run = addRun(db, 'ok', -2 * H, -2 * H + 60_000);
  addObs(db, run, -2 * H);
  const h = buildHealth(deps);
  assert.deepEqual(Object.keys(h).sort(), ['circuit', 'counters', 'email_mode', 'freshness', 'now', 'scheduler', 'version']);
  assert.equal(h.version, '0.1.0');
  assert.equal(h.email_mode, 'teste');
  assert.equal(h.scheduler.status, 'ok');
  assert.equal(h.scheduler.last_run?.status, 'ok');
  assert.deepEqual(h.circuit, { open: false, reason: null, until: null });
  assert.deepEqual(h.freshness, { fresco: 1, defasado: 0, sem_dados: 0 });
  const json = JSON.stringify(h);
  assert.ok(!json.includes('segredo@example.com'));
  assert.ok(!json.includes('@'));
});

test('T-SAU-02 atrasado quando ultima rodada nao pulada > 2*I; pulada nao conta; sem alertas = ok', () => {
  const { db, clock, deps } = setup();
  assert.equal(buildHealth(deps).scheduler.status, 'ok'); // sem alertas ativos
  seed(db);
  assert.equal(buildHealth(deps).scheduler.status, 'ok'); // nunca rodou, app no ar ha 0
  await_(clock, 8 * H + 1);
  assert.equal(buildHealth(deps).scheduler.status, 'atrasado'); // nunca rodou e app no ar > 2*I
  addRun(db, 'skipped', 8 * H, 8 * H + 1, 'intervalo_minimo');
  assert.equal(buildHealth(deps).scheduler.status, 'atrasado'); // pulada nao zera o relogio
  addRun(db, 'ok', 8 * H - 100, 8 * H);
  assert.equal(buildHealth(deps).scheduler.status, 'ok');
  await_(clock, 8 * H - 1); // idade exata 2*I ainda ok; +1 ms atrasa
  assert.equal(buildHealth(deps).scheduler.status, 'ok');
  await_(clock, 1);
  assert.equal(buildHealth(deps).scheduler.status, 'atrasado');
  db.exec("UPDATE price_alerts SET status = 'PAUSADO', paused_at = '" + T0 + "'");
  assert.equal(buildHealth(deps).scheduler.status, 'ok');
});
function await_(clock: ManualClock, ms: number): void {
  void clock.advance(ms); // sem timers pendentes: ajusta o relogio de forma sincrona
}

test('T-SAU-02 circuito aberto tem precedencia e mostra motivo/retomada; expira com o tempo', () => {
  const { db, clock, state, deps } = setup();
  seed(db);
  state.set('circuit_open_until', iso(24 * H), T0);
  state.set('circuit_reason', 'http_403_ou_desafio', T0);
  let h = buildHealth(deps);
  assert.equal(h.scheduler.status, 'pausado_circuito');
  assert.deepEqual(h.circuit, { open: true, reason: 'http_403_ou_desafio', until: iso(24 * H) });
  await_(clock, 24 * H);
  h = buildHealth(deps);
  assert.equal(h.circuit.open, false);
});

test('T-SAU-01 frescor por alerta ativo usa so observacao confirmada (fresco/defasado/sem_dados)', () => {
  const { db, deps } = setup();
  seed(db);
  assert.deepEqual(buildHealth(deps).freshness, { fresco: 0, defasado: 0, sem_dados: 1 });
  const run = addRun(db, 'ok', -10 * H, -10 * H + 1);
  addObs(db, run, -9 * H); // 9 h > 2*I = 8 h
  assert.deepEqual(buildHealth(deps).freshness, { fresco: 0, defasado: 1, sem_dados: 0 });
  db.exec('UPDATE price_observations SET confirmed = 0');
  assert.deepEqual(buildHealth(deps).freshness, { fresco: 0, defasado: 0, sem_dados: 1 });
});

test('T-OBS-02 contadores: rodadas, itens 24 h por classe, observacoes por fonte, notificacoes, idade', () => {
  const { db, deps } = setup();
  seed(db);
  const r1 = addRun(db, 'ok', -3 * H, -3 * H + 1000);
  const r2 = addRun(db, 'failed', -2 * H, -2 * H + 1000);
  const item = db.prepare(
    'INSERT INTO run_items (run_id, product_code, seq, outcome, failure_class, finished_at) VALUES (?, ?, 1, ?, ?, ?)',
  );
  item.run(r1, 'P0000001', 'ok', null, iso(-3 * H));
  item.run(r2, 'P0000001', 'falha', 'http_5xx', iso(-2 * H));
  db.prepare(
    "INSERT INTO run_items (run_id, product_code, seq, outcome, failure_class, finished_at) VALUES (?, 'P0000001', 2, 'falha', 'preco_invalido', ?)",
  ).run(addRun(db, 'failed', -30 * H, -30 * H + 1), iso(-30 * H)); // fora da janela de 24 h
  addObs(db, r1, -3 * H, 'occ');
  addObs(db, r1, -3 * H, 'json_ld', 2);
  db.exec(`INSERT INTO health_events (kind, subject, opened_at) VALUES ('circuito_aberto','global','${T0}');
    INSERT INTO notifications (health_event_id, kind, idempotency_key, mode, created_at, updated_at)
      VALUES (1, 'SAUDE', '${'a'.repeat(64)}', 'teste', '${T0}', '${T0}')`);
  const c = buildHealth(deps).counters;
  assert.deepEqual(c.runs_by_status, { ok: 1, failed: 2 });
  assert.deepEqual(c.items_24h, { ok: 1, failed_by_class: { http_5xx: 1 } });
  assert.deepEqual(c.observations_by_source, { occ: 1, json_ld: 1 });
  assert.deepEqual(c.notifications_by_status, { PENDENTE: 1 });
  assert.equal(c.last_observation_age_s, 3 * 3600);
});

test('T-SAU-05 /saude nao faz rede: montar o payload so le o banco (no-network.ts ativo)', () => {
  const { db, deps } = setup();
  seed(db);
  const t = performance.now();
  buildHealth(deps);
  assert.ok(performance.now() - t < 200);
});
