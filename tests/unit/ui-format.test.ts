import { test } from 'node:test';
import assert from 'node:assert/strict';
import { badge, brl, formatSp } from '../../src/ext/ui/format.ts';

test('RF-09 BRL em centavos; ausente vira travessão, nunca R$ 0,00', () => {
  assert.equal(brl(12999), 'R$ 129,99');
  assert.equal(brl(5), 'R$ 0,05');
  assert.equal(brl(null), '—');
  assert.equal(brl(undefined), '—');
});

test('RF-09 data em America/Sao_Paulo (UTC-3), formato dd/mm/aaaa hh:mm', () => {
  assert.equal(formatSp('2026-10-15T17:30:00Z'), '15/10/2026 14:30');
  assert.equal(formatSp('2026-01-01T02:00:00Z'), '31/12/2025 23:00');
  assert.equal(formatSp(new Date('2026-06-15T00:00:00Z')), '14/06/2026 21:00');
});

test('RF-09 data inválida ou ausente vira travessão', () => {
  for (const x of [null, undefined, 'lixo', NaN]) assert.equal(formatSp(x as never), '—');
});

test('RN-06 selos têm texto; estado desconhecido é neutro (nunca ok)', () => {
  assert.deepEqual(badge('nao_confirmado'), { text: 'Não confirmada', tone: 'warn' });
  assert.deepEqual(badge('ACEITO'), { text: 'Aceito pelo provedor', tone: 'ok' });
  assert.deepEqual(badge('aberto'), { text: 'Circuito aberto', tone: 'bad' });
  assert.deepEqual(badge('xyz'), { text: 'xyz', tone: 'neutral' });
  assert.deepEqual(badge('constructor'), { text: 'constructor', tone: 'neutral' });
  assert.equal(badge('').text, '—');
});
