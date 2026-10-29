import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ManualClock } from '../helpers/clock.ts';
import { SeededRandom } from '../helpers/prng.ts';
import { SystemClock } from '../../src/shared/clock.ts';
import { SystemRandom } from '../../src/shared/random.ts';
import { sha256Hex } from '../../src/shared/hash.ts';
import { maskEmail, stripControl } from '../../src/shared/mask.ts';
import { err, ok } from '../../src/shared/result.ts';

test('RNF-TEST-01 ManualClock.advance resolve sleep na ordem de vencimento', async () => {
  const c = new ManualClock('2026-10-14T12:00:00.000Z');
  const order: string[] = [];
  const a = c.sleep(300).then(() => order.push('a300'));
  const b = c.sleep(100).then(() => order.push('b100'));
  const d = c.sleep(100).then(() => order.push('d100'));
  await c.advance(99);
  assert.deepEqual(order, []);
  await c.advance(1);
  assert.deepEqual(order, ['b100', 'd100']);
  await c.advance(500);
  await Promise.all([a, b, d]);
  assert.deepEqual(order, ['b100', 'd100', 'a300']);
  assert.equal(c.now().toISOString(), '2026-10-14T12:00:00.600Z');
});

test('RNF-TEST-01 ManualClock: sleep encadeado dentro do mesmo advance', async () => {
  const c = new ManualClock('2026-10-14T12:00:00.000Z');
  const seen: number[] = [];
  const p = (async () => {
    await c.sleep(100);
    seen.push(c.now().getTime());
    await c.sleep(100);
    seen.push(c.now().getTime());
  })();
  await c.advance(250);
  await p;
  const t0 = Date.parse('2026-10-14T12:00:00.000Z');
  assert.deepEqual(seen, [t0 + 100, t0 + 200]);
});

test('RNF-TEST-01 ManualClock: AbortSignal rejeita o sleep e remove o timer', async () => {
  const c = new ManualClock(new Date('2026-10-14T12:00:00.000Z'));
  const ac = new AbortController();
  const p = c.sleep(1000, ac.signal);
  ac.abort(new Error('cancelado'));
  await assert.rejects(p, /cancelado/);
  await c.advance(2000);
  await assert.rejects(c.sleep(1, ac.signal), /cancelado/);
});

test('RNF-TEST-01 SystemClock: now() e sleep abortável', async () => {
  const c = new SystemClock();
  assert.ok(Math.abs(c.now().getTime() - Date.now()) < 1000);
  const ac = new AbortController();
  const p = c.sleep(60_000, ac.signal);
  ac.abort(new Error('x'));
  await assert.rejects(p, /x/);
  await c.sleep(1);
});

test('RNF-TEST-01 PRNG semeado é determinístico e em [0,1)', () => {
  const a = new SeededRandom(42);
  const b = new SeededRandom(42);
  for (let i = 0; i < 100; i++) {
    const v = a.next();
    assert.equal(v, b.next());
    assert.ok(v >= 0 && v < 1);
  }
  assert.notEqual(new SeededRandom(1).next(), new SeededRandom(2).next());
  const r = new SystemRandom().next();
  assert.ok(r >= 0 && r < 1);
});

test('RNF-TEST-01 sha256Hex estável (vetores conhecidos)', () => {
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256Hex('saude|1').length, 64);
});

test('RNF-PRIV-01 maskEmail', () => {
  assert.equal(maskEmail('marina@gmail.com'), 'm***@g***.com');
  assert.equal(maskEmail('a@b.com.br'), 'a***@b***.com.br');
  assert.equal(maskEmail('x@localhost'), 'x***@l***');
  for (const bad of ['', 'sem-arroba', '@x.com', 'a@']) assert.equal(maskEmail(bad), '***');
  assert.ok(!maskEmail('marina@gmail.com').includes('marina'));
});

test('RNF-PRIV-01 stripControl remove CR/LF/TAB/NUL/DEL/C1 e preserva acentos', () => {
  assert.equal(stripControl('Tênis\r\nBcc: x@y.z\t\0\x7f\x85\u2028ok'), 'TênisBcc: x@y.zok');
  assert.equal(stripControl('Old Skool 😀'), 'Old Skool 😀');
});

test('Result helpers', () => {
  assert.deepEqual(ok(1), { ok: true, value: 1 });
  assert.deepEqual(err('x'), { ok: false, error: 'x' });
});
