import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatBrl, parseBrlToCents, percentOff, valueToCents } from '../../src/shared/money.ts';

test('T-RN-01 valueToCents converte e rejeita', () => {
  assert.deepEqual(valueToCents(379.99), { ok: true, value: 37999 });
  assert.deepEqual(valueToCents(100), { ok: true, value: 10000 });
  for (const v of [0, -1, 379.999, 1.005, NaN, Infinity, '99.99', null, undefined, {}, 1e300]) {
    assert.deepEqual(valueToCents(v), { ok: false, error: 'preco_invalido' }, String(v));
  }
});

test('T-TGT-03 ruído de float vira centavos', () => {
  assert.deepEqual(valueToCents(99.99000000000001), { ok: true, value: 9999 });
  assert.deepEqual(valueToCents(49.989999999999995), { ok: true, value: 4999 });
});

test('T-TGT-01 parseBrlToCents aceita formatos válidos', () => {
  const ok = (s: string, v: number) => assert.deepEqual(parseBrlToCents(s), { ok: true, value: v }, s);
  ok('379,99', 37999);
  ok('379.99', 37999);
  ok(' 379 ', 37900);
  ok('379,9', 37990);
  ok('1.234,50', 123450);
  ok('0,01', 1);
  ok('99999,99', 9999999);
  ok('99.999,99', 9999999);
});

test('T-TGT-01 parseBrlToCents recusa inválidos com erro específico', () => {
  const bad = (s: string, e: string) => assert.deepEqual(parseBrlToCents(s), { ok: false, error: e }, s);
  bad('', 'vazio');
  bad('   ', 'vazio');
  bad('379,999', 'casas_decimais');
  bad('1.234', 'casas_decimais');
  bad('0', 'nao_positivo');
  bad('0,00', 'nao_positivo');
  bad('-5', 'nao_positivo');
  bad('abc', 'formato_invalido');
  bad('1,234,50', 'formato_invalido');
  bad('12.34.5,00', 'formato_invalido');
  bad('1e3', 'formato_invalido');
  bad('100000', 'acima_do_maximo');
  bad('99999,995', 'casas_decimais');
});

test('T-TGT-01 formatBrl', () => {
  assert.equal(formatBrl(123456), 'R$ 1.234,56');
  assert.equal(formatBrl(5), 'R$ 0,05');
  assert.equal(formatBrl(37999), 'R$ 379,99');
  assert.equal(formatBrl(100000000), 'R$ 1.000.000,00');
});

test('T-RN-01 percentOff', () => {
  assert.equal(percentOff(10000, 7500), 25);
  assert.equal(percentOff(10000, 10000), 0);
  assert.equal(percentOff(10000, 12000), 0);
  assert.equal(percentOff(0, 0), 0);
  assert.equal(percentOff(30000, 20000), 33);
  assert.equal(percentOff(20000, 9999), 50);
});
