import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyBand, type Band } from '../../src/shared/price-compare.ts';

test('T-BND-02 tabela 5.4 (Hylane P=37999)', () => {
  const rows: Array<[number, number, Band]> = [
    [38000, 300, 'ATINGIDO'],
    [37999, 300, 'ATINGIDO'],
    [37998, 300, 'PROXIMO'],
    [37000, 300, 'PROXIMO'],
    [35000, 300, 'ACIMA'],
    [37998, 0, 'ACIMA'],
  ];
  for (const [t, bp, band] of rows) assert.equal(classifyBand(37999, t, bp), band, `T=${t} bp=${bp}`);
});

test('T-BND-02 limites P=T, P=T*(1+M), +1 centavo, bp=0', () => {
  assert.equal(classifyBand(10000, 10000, 300), 'ATINGIDO');
  assert.equal(classifyBand(10300, 10000, 300), 'PROXIMO');
  assert.equal(classifyBand(10301, 10000, 300), 'ACIMA');
  assert.equal(classifyBand(10001, 10000, 0), 'ACIMA');
  assert.equal(classifyBand(10000, 10000, 0), 'ATINGIDO');
});

test('T-BND-03 extremos sem overflow (1; 9.999.999; 50%)', () => {
  assert.equal(classifyBand(1, 1, 5000), 'ATINGIDO');
  assert.equal(classifyBand(2, 1, 5000), 'ACIMA');
  assert.equal(classifyBand(9_999_999, 9_999_999, 5000), 'ATINGIDO');
  assert.equal(classifyBand(9_999_999, 6_666_666, 5000), 'PROXIMO'); // limite exato 9.999.999
  assert.equal(classifyBand(9_999_999, 6_666_665, 5000), 'ACIMA');
  assert.equal(classifyBand(9_999_999, 1, 5000), 'ACIMA');
});

test('T-BND-03 propriedade: faixa monotônica em P', () => {
  const rank = { ATINGIDO: 0, PROXIMO: 1, ACIMA: 2 };
  for (const [t, bp] of [[1, 5000], [100, 0], [10000, 300], [37998, 300], [500, 1]] as const) {
    let prev = 0;
    for (let p = 0; p <= t * 2 + 10; p++) {
      const r = rank[classifyBand(p, t, bp)];
      assert.ok(r >= prev, `T=${t} bp=${bp} P=${p}`);
      prev = r;
    }
  }
});

test('T-PRF-03 pura e rejeita entradas inválidas', () => {
  assert.throws(() => classifyBand(1.5, 1, 0), RangeError);
  assert.throws(() => classifyBand(1, -1, 0), RangeError);
  assert.throws(() => classifyBand(1, 1, NaN), RangeError);
});
