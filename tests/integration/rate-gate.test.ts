import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ManualClock } from '../helpers/clock.ts';
import { SeededRandom } from '../helpers/prng.ts';
import type { HttpClient, HttpResult, RequestLog, RequestPurpose } from '../../src/price-monitor/ports.ts';
import { BudgetExceededError, withRateGate } from '../../src/price-monitor/http/rate-gate.ts';

// deixa as continuações da fila registrarem seus sleep() antes de avançar o relógio
const run = async (c: ManualClock, ms: number): Promise<void> => {
  await new Promise<void>((r) => setImmediate(r));
  await c.advance(ms);
};
const START = '2026-10-14T12:00:00.000Z';
const OK: HttpResult = { ok: true, status: 200, body: '{}', contentType: 'application/json' };
const req = (p = '/x') => ({ url: new URL('https://www.vans.com.br' + p), accept: 'json' as const });

class MemLog implements RequestLog {
  rows: { purpose: RequestPurpose; at: string }[] = [];
  record(purpose: RequestPurpose, now: string): void {
    this.rows.push({ purpose, at: now });
  }
  countSince(since: string): number {
    return this.rows.filter((r) => r.at >= since).length;
  }
}

function setup() {
  const clock = new ManualClock(START);
  const log = new MemLog();
  const calls: { at: number; url: string }[] = [];
  let inflight = 0;
  let maxInflight = 0;
  let fail = false;
  const inner: HttpClient = {
    async get(r) {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      calls.push({ at: clock.now().getTime(), url: r.url.pathname });
      await clock.sleep(1_000); // a requisição "demora" 1 s
      inflight--;
      if (fail) throw new Error('boom');
      return OK;
    },
  };
  const gate = withRateGate(inner, { clock, random: new SeededRandom(3), log });
  return { clock, log, calls, gate, stats: () => maxInflight, setFail: (v: boolean) => (fail = v) };
}

test('T-REL-06 RNF-REL-03 3 concorrentes: 1 em voo, 2-5 s entre elas, 1 linha por chamada com a origem', async () => {
  const s = setup();
  const ps = [
    s.gate.forPurpose('monitor').get(req('/a')),
    s.gate.forPurpose('discover').get(req('/b')),
    s.gate.forPurpose('catalog').get(req('/c')),
  ];
  await run(s.clock, 60_000);
  assert.deepEqual(await Promise.all(ps), [OK, OK, OK]);
  assert.equal(s.stats(), 1);
  assert.deepEqual(s.calls.map((c) => c.url), ['/a', '/b', '/c']);
  for (let i = 1; i < 3; i++) {
    const gap = s.calls[i]!.at - s.calls[i - 1]!.at - 1_000; // entre o fim de uma e o início da próxima
    assert.ok(gap >= 2_000 && gap < 5_000, `gap ${gap}`);
  }
  assert.deepEqual(s.log.rows.map((r) => r.purpose), ['monitor', 'discover', 'catalog']);
});

test('RF-06-AC1 primeira requisição não espera; get() direto registra monitor', async () => {
  const s = setup();
  const p = s.gate.get(req());
  await run(s.clock, 1_000);
  await p;
  assert.equal(s.calls[0]!.at, Date.parse(START));
  assert.equal(s.log.rows[0]!.purpose, 'monitor');
});

test('RNF-REL-04 T-REL-06 orçamento 400/24 h: a 401ª é recusada sem chamar a rede', async () => {
  const s = setup();
  for (let i = 0; i < 400; i++) s.log.record('monitor', START);
  await assert.rejects(s.gate.get(req()), BudgetExceededError);
  assert.equal(s.calls.length, 0);
  assert.equal(s.log.rows.length, 400);
});

test('RNF-REL-04 orçamento em janela deslizante: linhas > 24 h não contam', async () => {
  const s = setup();
  for (let i = 0; i < 400; i++) s.log.record('monitor', '2026-10-13T11:59:59.000Z');
  const p = s.gate.get(req());
  await run(s.clock, 1_000);
  assert.equal(await p, OK);
});

test('T-REL-06 erro do cliente interno não trava a fila e a requisição foi registrada', async () => {
  const s = setup();
  s.setFail(true);
  const a = s.gate.get(req('/a'));
  const rejected = assert.rejects(a, /boom/);
  await run(s.clock, 1_000);
  await rejected;
  s.setFail(false);
  const b = s.gate.get(req('/b'));
  await run(s.clock, 10_000);
  assert.equal(await b, OK);
  assert.equal(s.log.rows.length, 2);
});

test('T-LEG-02 o gate não altera a requisição (sem trocar headers/UA)', async () => {
  let seen: unknown;
  const clock = new ManualClock(START);
  const gate = withRateGate({ get: async (r) => ((seen = r), OK) }, { clock, random: new SeededRandom(1), log: new MemLog() });
  const r = { ...req(), headers: { 'x-a': '1' } };
  await gate.get(r);
  assert.equal(seen, r);
});
