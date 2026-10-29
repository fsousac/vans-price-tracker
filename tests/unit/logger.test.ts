import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ManualClock } from '../helpers/clock.ts';
import { createLogger, type LogFields } from '../../src/observability/logger.ts';

function setup() {
  const lines: string[] = [];
  const clock = new ManualClock('2026-10-14T12:00:00.000Z');
  return { lines, log: createLogger('worker', clock, (l) => lines.push(l)) };
}

test('T-OBS-01 uma linha JSON por evento com ts, level, module, event', () => {
  const { lines, log } = setup();
  log.info('run_finished', { run_id: 7, count: 3, duration_ms: 120 });
  assert.equal(lines.length, 1);
  assert.ok(lines[0]!.endsWith('\n') && lines[0]!.trim().split('\n').length === 1);
  assert.deepEqual(JSON.parse(lines[0]!), {
    ts: '2026-10-14T12:00:00.000Z', level: 'info', module: 'worker', event: 'run_finished',
    run_id: 7, count: 3, duration_ms: 120,
  });
});

test('T-OBS-01 níveis e campos de falha', () => {
  const { lines, log } = setup();
  log.warn('fetch_failed', { product_code: '1003800580026U', failure_class: 'http_429', http_status: 429, source: 'occ' });
  log.error('x');
  log.debug('y');
  assert.deepEqual(lines.map((l) => JSON.parse(l).level), ['warn', 'error', 'debug']);
  assert.equal(JSON.parse(lines[0]!).failure_class, 'http_429');
});

test('T-OBS-01 destino padrão é console.log (sem process.stdout)', () => {
  const out: string[] = [];
  const orig = console.log;
  console.log = (l: string) => out.push(l);
  try {
    createLogger('sw', new ManualClock('2026-10-14T12:00:00.000Z')).info('boot', { count: 1 });
  } finally {
    console.log = orig;
  }
  assert.equal(out.length, 1);
  assert.equal(JSON.parse(out[0]!).event, 'boot');
});

test('T-OBS-01 RNF-PRIV-01 campo não permitido não compila e é descartado em runtime', () => {
  const { lines, log } = setup();
  // @ts-expect-error email não é campo de LogFields
  const bad: LogFields = { alert_id: 1, email: 'marina@gmail.com' };
  log.info('alert_checked', bad);
  const out = JSON.parse(lines[0]!);
  assert.equal(out.alert_id, 1);
  assert.equal('email' in out, false);
  assert.ok(!lines[0]!.includes('marina'));
});
