import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { StateKey, StateRepo } from '../../src/observability/ports.ts';
import { CircuitStore, RoundBreaker } from '../../src/scheduler/circuit.ts';

class MemState implements StateRepo {
  m = new Map<string, string>();
  get(k: StateKey): string | null {
    return this.m.get(k) ?? null;
  }
  set(k: StateKey, v: string): void {
    this.m.set(k, v);
  }
  delete(k: StateKey): void {
    this.m.delete(k);
  }
}
const T0 = '2026-10-14T12:00:00.000Z';
const T24 = '2026-10-15T12:00:00.000Z';

test('RN-18 T-FLH-08 403/desafio abre na hora', () => {
  assert.deepEqual(new RoundBreaker().observe('http_403_ou_desafio'), { action: 'open_circuit', reason: 'http_403_ou_desafio' });
});

test('RN-18 T-FLH-08 2x 429 seguidos abre; 429 isolado não', () => {
  const b = new RoundBreaker();
  assert.equal(b.observe('http_429').action, 'continue');
  assert.equal(b.observe(null).action, 'continue');
  assert.equal(b.observe('http_429').action, 'continue');
  assert.equal(b.observe('http_429').action, 'open_circuit');
});

test('RN-18 T-FLH-08 3 falhas de transporte seguidas abrem; sucesso zera', () => {
  const b = new RoundBreaker();
  assert.equal(b.observe('rede_timeout').action, 'continue');
  assert.equal(b.observe('http_5xx').action, 'continue');
  assert.equal(b.observe(null).action, 'continue');
  assert.equal(b.observe('host_nao_autorizado').action, 'continue');
  assert.equal(b.observe('rede_timeout').action, 'continue');
  assert.deepEqual(b.observe('http_5xx'), { action: 'open_circuit', reason: 'falhas_de_transporte' });
});

test('RN-18 T-FLH-08 conteúdo ruim não conta para o circuito; 3 seguidos encerram parcial', () => {
  const b = new RoundBreaker();
  assert.equal(b.observe('formato_desconhecido').action, 'continue');
  assert.equal(b.observe('preco_invalido').action, 'continue');
  assert.equal(b.observe('formato_desconhecido').action, 'end_partial');
  const c = new RoundBreaker();
  for (let i = 0; i < 4; i++) assert.equal(c.observe('produto_removido').action, 'continue');
  const d = new RoundBreaker();
  d.observe('formato_desconhecido');
  d.observe('formato_desconhecido');
  d.observe(null);
  assert.equal(d.observe('formato_desconhecido').action, 'continue');
});

test('T-FLH-08 circuito 24 h: aberto, meia-abertura, sonda falha reabre sem novo aviso, sucesso fecha', () => {
  const s = new MemState();
  const c = new CircuitStore(s);
  assert.deepEqual(c.status(T0), { state: 'closed' });
  assert.deepEqual(c.open('http_403_ou_desafio', T0), { created: true, until: T24 });
  assert.deepEqual(c.status('2026-10-15T11:59:59.999Z'), { state: 'open', until: T24, reason: 'http_403_ou_desafio' });
  assert.deepEqual(c.status(T24), { state: 'half_open', reason: 'http_403_ou_desafio' });
  c.beginProbe(T24);
  assert.equal(s.get('circuit_probe_pending'), '1');
  assert.deepEqual(c.probeFailed(T24), { until: '2026-10-16T12:00:00.000Z' });
  assert.equal(s.get('circuit_probe_pending'), null);
  assert.equal(c.status(T24).state, 'open');
  assert.equal(s.get('circuit_reason'), 'http_403_ou_desafio'); // mesmo episódio
  c.close();
  assert.deepEqual(c.status('2026-10-16T12:00:00.000Z'), { state: 'closed' });
  assert.equal(s.m.size, 0);
});

test('T-FLH-08 reabrir com circuito já aberto não é novo episódio', () => {
  const c = new CircuitStore(new MemState());
  assert.equal(c.open('http_429_repetido', T0).created, true);
  assert.equal(c.open('http_429_repetido', T0).created, false);
});
