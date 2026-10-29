import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHealth, type HealthDto } from '../../src/ext/ui/options/health-model.ts';

const H = 3_600_000;
const now = new Date('2026-10-15T15:00:00Z');
const base = (p: Partial<HealthDto> = {}): HealthDto => ({
  lastRun: { status: 'ok', startedAt: '2026-10-15T14:00:00Z', finishedAt: '2026-10-15T14:05:00Z', ok: 3, failed: 0, skipped: 0 },
  circuit: { openUntil: null, reason: null }, lastConfirmed: [], intervalMs: 4 * H,
  budget: { used: 100, limit: 400 }, openEvents: [], emailMode: 'teste', ...p,
});

test('RF-12-AC4 circuito aberto mostra até quando e por quê; vencido volta a fechado', () => {
  const open = buildHealth(base({ circuit: { openUntil: '2026-10-16T12:00:00Z', reason: 'http_403_ou_desafio' } }), now);
  assert.equal(open.circuit.state, 'aberto');
  assert.match(open.circuit.reason, /16\/10\/2026 09:00.*403/);
  assert.equal(buildHealth(base({ circuit: { openUntil: '2026-10-15T14:00:00Z', reason: 'x' } }), now).circuit.state, 'fechado');
  assert.equal(buildHealth(base({ circuit: { openUntil: null, reason: null, probePending: true } }), now).circuit.state, 'meio_aberto');
});

test('RF-12-AC3 frescor com relógio fixo (limites 2*I e 24 h)', () => {
  const t = (h: number) => new Date(now.getTime() - h * H).toISOString();
  const v = buildHealth(base({ lastConfirmed: [t(8), t(8.01), t(24), t(24.01), null, 'lixo'] }), now);
  assert.deepEqual(v.fresh, { fresco: 1, defasado: 2, sem_dados: 3 });
  assert.equal(v.stale, true);
});

test('RF-12 última rodada em SP, pulada com motivo; sem rodada = null', () => {
  const v = buildHealth(base({ lastRun: { status: 'skipped', startedAt: '2026-10-15T14:00:00Z', finishedAt: null, ok: 0, failed: 0, skipped: 0, skipReason: 'intervalo_minimo' } }), now);
  assert.equal(v.run!.started, '15/10/2026 11:00');
  assert.equal(v.run!.finished, '—');
  assert.match(v.run!.note, /intervalo mínimo/);
  assert.equal(buildHealth(base({ lastRun: null }), now).run, null);
});

test('RF-06 orçamento: porcentagem, teto 100 e esgotado', () => {
  assert.equal(buildHealth(base(), now).budget.percent, 25);
  const b = buildHealth(base({ budget: { used: 450, limit: 400 } }), now).budget;
  assert.equal(b.percent, 100);
  assert.equal(b.exhausted, true);
});

test('RF-12-AC6 aviso de navegador aberto; e-mail teste não envia', () => {
  const v = buildHealth(base(), now);
  assert.match(v.banner, /navegador aberto/);
  assert.match(v.email, /não envia/);
});
