import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideConfirmation, type ConfirmInput } from '../../src/price-monitor/confirm.ts';

const at = '2026-10-14T12:00:00.000Z';
const mk = (
  cents: number,
  source: 'occ' | 'next_data' | 'json_ld' = 'occ',
  last: number | null = null,
  pending: { id: number; currentCents: number } | null = null,
): ConfirmInput => ({
  candidate: { currentCents: cents, source, observedAt: at },
  lastConfirmed: last === null ? null : { currentCents: last },
  pendingUnconfirmed: pending,
});

test('T-RN-07 primeira leitura OCC confirma', () => {
  assert.deepEqual(decideConfirmation(mk(37999)), { confirmed: true });
});

test('T-RN-07 variacao <= 70% confirma (queda e alta, limite exato)', () => {
  assert.deepEqual(decideConfirmation(mk(30000, 'occ', 100000)), { confirmed: true }); // -70% exato
  assert.deepEqual(decideConfirmation(mk(170000, 'occ', 100000)), { confirmed: true }); // +70% exato
  assert.deepEqual(decideConfirmation(mk(50000, 'occ', 100000)), { confirmed: true });
});

test('T-RN-07 RF-11-AC3 variacao > 70% nao confirma (queda e alta, +1 centavo)', () => {
  const r = { confirmed: false, reason: 'variacao_maior_70pct' };
  assert.deepEqual(decideConfirmation(mk(29999, 'occ', 100000)), r);
  assert.deepEqual(decideConfirmation(mk(170001, 'occ', 100000)), r);
  assert.deepEqual(decideConfirmation(mk(1, 'occ', 37999)), r);
});

test('T-RN-07 RN-09a fallback sem par nao confirma (com e sem confirmada anterior)', () => {
  const r = { confirmed: false, reason: 'fonte_fallback_sem_par' };
  assert.deepEqual(decideConfirmation(mk(37999, 'next_data')), r);
  assert.deepEqual(decideConfirmation(mk(37999, 'next_data', 37999)), r);
  assert.deepEqual(decideConfirmation(mk(37999, 'json_ld', 38000, { id: 1, currentCents: 30000 })), r);
});

test('T-RN-07 RF-11-AC3 par concordante em centavos confirma a pendente', () => {
  assert.deepEqual(decideConfirmation(mk(10000, 'occ', 100000, { id: 7, currentCents: 10000 })), {
    confirmed: true,
    confirmsPendingId: 7,
  });
  // fallback que concorda com a pendente tambem confirma
  assert.deepEqual(decideConfirmation(mk(10000, 'next_data', 100000, { id: 8, currentCents: 10000 })), {
    confirmed: true,
    confirmsPendingId: 8,
  });
});

test('T-RN-07 pendente discordante (1 centavo) nao confirma', () => {
  assert.deepEqual(decideConfirmation(mk(10001, 'occ', 100000, { id: 7, currentCents: 10000 })), {
    confirmed: false,
    reason: 'variacao_maior_70pct',
  });
});
