import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHistory, channelLabels, type ObservationDto } from '../../src/ext/ui/options/history-model.ts';

const o = (observedAt: string, cur: number, confirmed = true, orig = 64999): ObservationDto =>
  ({ observedAt, originalCents: orig, currentCents: cur, available: true, source: 'occ', confirmed });

test('RF-07-AC1/AC2 ordem decrescente, fuso SP e desconto calculado', () => {
  const v = buildHistory({ observations: [o('2026-10-14T12:00:00Z', 37999), o('2026-10-15T17:30:00Z', 37999)], notifications: [] });
  assert.equal(v.rows[0]!.when, '15/10/2026 14:30');
  assert.equal(v.rows[0]!.discount, '42%');
  assert.equal(v.rows[1]!.when, '14/10/2026 09:00');
});

test('RF-07-AC4/AC5 não confirmada marcada e fora de mín/máx', () => {
  const v = buildHistory({ observations: [o('2026-10-15T10:00:00Z', 1000, false), o('2026-10-15T11:00:00Z', 30000), o('2026-10-15T12:00:00Z', 40000)], notifications: [] });
  assert.equal(v.min, 'R$ 300,00');
  assert.equal(v.max, 'R$ 400,00');
  assert.equal(v.confirmedCount, 2);
  assert.equal(v.rows.find((r) => !r.confirmed)!.note, 'não confirmada');
});

test('RF-07 só não confirmadas: mín/máx travessão; vazio sinalizado', () => {
  assert.equal(buildHistory({ observations: [o('2026-10-15T10:00:00Z', 1000, false)], notifications: [] }).min, '—');
  assert.equal(buildHistory({ observations: [], notifications: [] }).empty, true);
});

test('RF-08 notificações: aceito pelo provedor, simulado, mostrada; nunca "entregue"', () => {
  const v = buildHistory({
    observations: [],
    notifications: [
      { key: 'a', kind: 'ATINGIDO', createdAt: '2026-10-15T10:00:00Z', desktop: 'mostrada', email: 'ACEITO', simulated: false },
      { key: 'b', kind: 'PROXIMO', createdAt: '2026-10-15T11:00:00Z', desktop: 'mostrada', email: 'ACEITO', simulated: true },
      { key: 'c', kind: 'XX', createdAt: '2026-10-15T12:00:00Z', desktop: 'falha', email: 'FALHA' },
    ],
  });
  assert.deepEqual(v.notifs.map((n) => n.key), ['c', 'b', 'a']);
  const labels = v.notifs.flatMap((n) => n.channels.map((c) => c.label));
  assert.ok(labels.includes('E-mail aceito pelo provedor'));
  assert.ok(labels.includes('E-mail simulado (não enviado)'));
  assert.ok(labels.includes('Mostrada no navegador'));
  assert.ok(!labels.some((l) => /entregue/i.test(l)));
  assert.equal(channelLabels({ desktop: 'pendente', email: 'desligado' }).length, 1);
});
