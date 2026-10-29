import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JITTER_FRAC, RECOVERY_GAP_MS, TICK_MS, createTick, nextRoundAt } from '../../src/app/tick.ts';
import { parseSettings } from '../../src/settings/settings.ts';
import type { RunTrigger } from '../../src/price-monitor/ports.ts';
import { ManualClock } from '../helpers/clock.ts';

const T0 = '2026-10-14T12:00:00.000Z';
const HOUR = 3_600_000;

function setup(o: { last?: string | null; running?: boolean; hours?: number; prevTick?: string | null } = {}) {
  const clock = new ManualClock(T0);
  const calls: RunTrigger[] = [];
  const kv = new Map<string, string>();
  if (o.prevTick) kv.set('last_tick_at', o.prevTick);
  let drains = 0;
  const settings = parseSettings({ v: 1, intervalHours: o.hours ?? 4 });
  const tick = createTick({
    round: { resumeOrStart: async (t) => { calls.push(t); return { skipped: 'intervalo_minimo' }; } },
    runs: {
      getRunning: async () => (o.running ? ({ startedAt: o.last ?? T0 } as never) : null),
      lastFinished: async () => (o.last ? ({ startedAt: o.last } as never) : null),
    },
    settings: { get: async () => settings },
    kv: { get: async (k) => kv.get(k) ?? null, set: async (k, v) => { kv.set(k, v); } },
    notifications: { drain: async () => { drains++; } },
    clock,
  });
  return { clock, calls, kv, tick, drains: () => drains };
}
const ago = (ms: number) => new Date(Date.parse(T0) - ms).toISOString();

test('nextRoundAt: jitter determinstico dentro de +-10% do intervalo (RF-06-AC2)', () => {
  const a = nextRoundAt(T0, 4);
  assert.equal(a, nextRoundAt(T0, 4));
  for (const s of ['2026-10-14T12:00:00.000Z', '2026-10-14T16:03:11.000Z', '2026-10-15T00:00:00.000Z', '2026-10-15T08:00:00.500Z']) {
    const d = nextRoundAt(s, 4) - Date.parse(s);
    assert.ok(Math.abs(d - 4 * HOUR) <= 4 * HOUR * JITTER_FRAC, s);
  }
  const offsets = new Set(Array.from({ length: 20 }, (_, i) => nextRoundAt(new Date(Date.parse(T0) + i * 1000).toISOString(), 4) - Date.parse(T0) - i * 1000));
  assert.ok(offsets.size > 10); // nao alinha em horario cheio
});

test('sem rodada anterior: vence na hora, grava last_tick_at e drena (RF-06)', async () => {
  const s = setup();
  await s.tick();
  assert.deepEqual(s.calls, ['scheduled']);
  assert.equal(s.kv.get('last_tick_at'), T0);
  assert.equal(s.drains(), 1);
});

test('rodada recente: nao vence, mas o drain de notificacoes roda mesmo assim (T-NOT-04)', async () => {
  const s = setup({ last: ago(HOUR) });
  assert.deepEqual(await s.tick(), { round: null });
  assert.equal(s.calls.length, 0);
  assert.equal(s.drains(), 1);
});

test('vence exatamente no instante com jitter (1 ms antes nao) (RF-06-AC2)', async () => {
  const last = ago(4 * HOUR);
  const due = nextRoundAt(last, 4);
  const s = setup({ last });
  await s.clock.advance(due - Date.parse(T0) - 1);
  await s.tick();
  assert.equal(s.calls.length, 0);
  await s.clock.advance(1);
  await s.tick();
  assert.equal(s.calls.length, 1);
});

test('intervalo vem dos ajustes: 2 h vence, 6 h nao, para a mesma rodada anterior (RF-06-AC2)', async () => {
  const last = ago(2.3 * HOUR);
  const a = setup({ last, hours: 2 });
  await a.tick();
  assert.equal(a.calls.length, 1);
  const b = setup({ last, hours: 6 });
  await b.tick();
  assert.equal(b.calls.length, 0);
});

test('volta do sono: no maximo 1 rodada, com gatilho recovery (RF-06-AC5, T-MON-04)', async () => {
  const s = setup({ last: ago(30 * HOUR), prevTick: ago(10 * HOUR) });
  await s.tick();
  assert.deepEqual(s.calls, ['recovery']); // 30 h de atraso = 1 chamada, nao 7 rodadas
});

test('tick em dia usa scheduled; atraso acima de 3 ticks usa recovery', async () => {
  const a = setup({ last: ago(5 * HOUR), prevTick: ago(TICK_MS) });
  await a.tick();
  const b = setup({ last: ago(5 * HOUR), prevTick: ago(RECOVERY_GAP_MS + 1) });
  await b.tick();
  assert.deepEqual([a.calls, b.calls], [['scheduled'], ['recovery']]);
});

test('rodada running: delega a resumeOrStart sem olhar o intervalo (RNF-REL-01)', async () => {
  const s = setup({ running: true, last: ago(10 * 60_000) });
  await s.tick();
  assert.equal(s.calls.length, 1);
});

test('ajuste corrompido cai no padrao de 4 h', async () => {
  const s = setup({ last: ago(3 * HOUR), hours: 99 }); // parseSettings -> 4 h; 3 h < 3,6 h minimo com jitter
  await s.tick();
  assert.equal(s.calls.length, 0);
});
