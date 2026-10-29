import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SeededRandom } from '../helpers/prng.ts';
import type { Random } from '../../src/shared/random.ts';
import { courtesyMs, maxRetries, retryDelayMs } from '../../src/scheduler/backoff.ts';

const fixed = (v: number): Random => ({ next: () => v });

test('RN-18 T-FLH-08 backoff 5 s / 10 s com jitter +-25%', () => {
  const f = { class: 'rede_timeout' as const };
  assert.equal(retryDelayMs(f, 1, fixed(0.5)), 5_000);
  assert.equal(retryDelayMs(f, 2, fixed(0.5)), 10_000);
  assert.equal(retryDelayMs(f, 1, fixed(0)), 3_750);
  assert.equal(retryDelayMs(f, 2, fixed(0.999999999)), 12_500);
  const r = new SeededRandom(7);
  for (let i = 0; i < 200; i++) {
    const d = retryDelayMs({ class: 'http_5xx' }, 1, r)!;
    assert.ok(d >= 3_750 && d <= 6_250);
  }
});

test('RN-18 no máximo 2 retentativas; 3ª não existe', () => {
  assert.equal(retryDelayMs({ class: 'http_5xx' }, 3, fixed(0.5)), null);
  assert.equal(retryDelayMs({ class: 'http_5xx' }, 0, fixed(0.5)), null);
});

test('T-LEG-02 sem retentativa para 403/desafio, conteúdo ruim e host não autorizado', () => {
  for (const c of ['http_403_ou_desafio', 'produto_removido', 'formato_desconhecido', 'preco_invalido', 'host_nao_autorizado'] as const) {
    assert.equal(maxRetries(c), 0);
    assert.equal(retryDelayMs({ class: c, retryAfterMs: 1000 }, 1, fixed(0.5)), null);
  }
});

test('RN-18 429: 1 retentativa após Retry-After, teto 60 s, ausente = 30 s', () => {
  assert.equal(retryDelayMs({ class: 'http_429', retryAfterMs: 12_000 }, 1, fixed(0.5)), 12_000);
  assert.equal(retryDelayMs({ class: 'http_429', retryAfterMs: 600_000 }, 1, fixed(0.5)), 60_000);
  assert.equal(retryDelayMs({ class: 'http_429' }, 1, fixed(0.5)), 30_000);
  assert.equal(retryDelayMs({ class: 'http_429' }, 2, fixed(0.5)), null);
});

test('RN-18 5xx com Retry-After respeita (teto 60 s) sem encurtar o backoff', () => {
  assert.equal(retryDelayMs({ class: 'http_5xx', retryAfterMs: 20_000 }, 1, fixed(0.5)), 20_000);
  assert.equal(retryDelayMs({ class: 'http_5xx', retryAfterMs: 1_000 }, 1, fixed(0.5)), 5_000);
  assert.equal(retryDelayMs({ class: 'http_5xx', retryAfterMs: 999_000 }, 1, fixed(0.5)), 60_000);
});

test('RF-06-AC1 cortesia uniforme em [2 s, 5 s)', () => {
  assert.equal(courtesyMs(fixed(0)), 2_000);
  assert.equal(courtesyMs(fixed(0.999999)), 4_999);
  const r = new SeededRandom(1);
  for (let i = 0; i < 500; i++) {
    const d = courtesyMs(r);
    assert.ok(d >= 2_000 && d < 5_000);
  }
});
