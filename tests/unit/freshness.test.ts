import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ManualClock } from '../helpers/clock.ts';
import { freshness } from '../../src/shared/freshness.ts';

const H = 3_600_000;
const I = 4 * H;

function stateAfter(ageMs: number, interval = I): string {
  const clock = new ManualClock('2026-10-14T12:00:00.000Z');
  const last = clock.now();
  clock.advance(ageMs);
  return freshness(last, clock.now(), interval);
}

test('T-SAU-03 / T-RN-14 limite exato de 8 h: fresco; 8 h + 1 ms: defasado', () => {
  assert.equal(stateAfter(0), 'fresco');
  assert.equal(stateAfter(8 * H), 'fresco');
  assert.equal(stateAfter(8 * H + 1), 'defasado');
});

test('T-SAU-03 / T-RN-14 limite exato de 24 h: defasado; 24 h + 1 ms: sem_dados', () => {
  assert.equal(stateAfter(24 * H), 'defasado');
  assert.equal(stateAfter(24 * H + 1), 'sem_dados');
});

test('T-SAU-03 nunca confirmada (null/undefined/inválida) = sem_dados', () => {
  const now = new Date('2026-10-14T12:00:00.000Z');
  assert.equal(freshness(null, now, I), 'sem_dados');
  assert.equal(freshness(undefined, now, I), 'sem_dados');
  assert.equal(freshness('lixo', now, I), 'sem_dados');
});

test('T-SAU-03 aceita ISO string e respeita o intervalo configurado (2*I)', () => {
  const now = new Date('2026-10-14T12:00:00.000Z');
  assert.equal(freshness('2026-10-14T04:00:00.000Z', now, I), 'fresco');
  assert.equal(freshness('2026-10-14T04:00:00.000Z', now, 2 * H), 'defasado');
});
