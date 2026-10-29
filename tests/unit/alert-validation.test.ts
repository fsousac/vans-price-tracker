import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAlertInput, validateEmail, validateMargin, validateTarget } from '../../src/alerts/validation.ts';

test('T-BND-01 margem padrão 300 bp quando ausente/vazia', () => {
  assert.deepEqual(validateMargin(undefined), { ok: true, value: 300 });
  assert.deepEqual(validateMargin('  '), { ok: true, value: 300 });
});

test('T-BND-01 margem válida vira pontos-base inteiros', () => {
  const cases: [string, number][] = [['0', 0], ['3', 300], ['3,5', 350], ['0.25', 25], ['12,34', 1234], ['50', 5000], ['50,00', 5000]];
  for (const [s, bp] of cases) assert.deepEqual(validateMargin(s), { ok: true, value: bp }, s);
});

test('T-BND-01 margem inválida é recusada (RF-05-AC2)', () => {
  for (const s of ['50,01', '51', '-1', 'abc', '3,333', '1e2', '3%', '1.000,5']) {
    const r = validateMargin(s);
    assert.equal(r.ok, false, s);
    if (!r.ok) assert.match(r.error, /Margem inválida/);
  }
});

test('T-BND-01 alvo: inválidos com mensagem específica (RF-04-AC2)', () => {
  const msg = (s: string) => {
    const r = validateTarget(s);
    return r.ok ? null : r.error;
  };
  assert.match(msg('379,999')!, /2 casas/);
  assert.match(msg('0')!, /maior que zero/);
  assert.match(msg('-5')!, /maior que zero/);
  assert.match(msg('abc')!, /inválido/);
  assert.match(msg('')!, /Informe/);
  assert.match(msg('100000')!, /no máximo/);
  assert.deepEqual(validateTarget('379,99'), { ok: true, value: 37999 });
});

test('T-NOT-07 e-mails válidos', () => {
  for (const s of ['a@b.co', 'felipe.coelho+vans@example.com.br', ' x@y.com ']) {
    assert.equal(validateEmail(s).ok, true, s);
  }
  assert.deepEqual(validateEmail(' x@y.com '), { ok: true, value: 'x@y.com' });
});

test('T-NOT-07 e-mails inválidos (RF-08-AC9, S8: sem CR/LF/vírgula/espaço)', () => {
  const long = `${'a'.repeat(250)}@b.co`;
  const bad = [
    '', 'abc', '@b.co', 'a@', 'a@b', 'a@@b.co', 'a b@c.co', 'a@b c.co', 'a,b@c.co', 'a@b.co,c@d.co',
    'a@b.co\r\nBcc: x@y.com', 'a@b.co\nX', 'a\r@b.co', 'a;b@c.co', 'a..b@c.co', 'a@b.', long,
  ];
  for (const s of bad) assert.equal(validateEmail(s).ok, false, JSON.stringify(s.slice(0, 30)));
  assert.equal(validateEmail(`${'a'.repeat(64)}@${'b'.repeat(180)}.co`).ok, true);
  assert.equal(validateEmail(`${'a'.repeat(65)}@b.co`).ok, false);
});

test('T-BND-01 validateAlertInput: válido com margem padrão', () => {
  assert.deepEqual(validateAlertInput({ target: '379,99', email: 'a@b.co' }), {
    ok: true,
    value: { targetCents: 37999, marginBp: 300, email: 'a@b.co' },
  });
});

test('T-BND-01 validateAlertInput: erros por campo, nada aceito parcialmente', () => {
  const r = validateAlertInput({ target: 'abc', margin: '99', email: 'x' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.deepEqual(Object.keys(r.error).sort(), ['email', 'margin', 'target']);
  const r2 = validateAlertInput({ target: '10,00', margin: '3', email: 'x' });
  assert.equal(r2.ok, false);
  if (!r2.ok) assert.deepEqual(Object.keys(r2.error), ['email']);
});
