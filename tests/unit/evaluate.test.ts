import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAlert } from '../../src/alerts/evaluate.ts';
import type { AlertState, Decision, ObservationView } from '../../src/alerts/ports.ts';

const H = 3_600_000;
const COOL = 24 * H;
const T0 = Date.parse('2026-10-14T12:00:00.000Z');
const at = (h: number): Date => new Date(T0 + h * H);
const iso = (h: number): string => at(h).toISOString();

const base = (p: Partial<AlertState> = {}): AlertState => ({
  id: 1, revision: 1, status: 'ATIVO', targetCents: 10000, marginBp: 300,
  armedProximo: true, armedAtingido: true, episodeProximo: 1, episodeAtingido: 1,
  rearmNotBeforeProximo: null, rearmNotBeforeAtingido: null, evaluatedOnce: false, ...p,
});
const obs = (cents: number, h = 0, p: Partial<ObservationView> = {}): ObservationView => ({
  id: 1, currentCents: cents, available: true, confirmed: true, observedAt: iso(h), ...p,
});
const run = (s: AlertState, o: ObservationView, h = 0): Decision => evaluateAlert(s, o, at(h), COOL);
const step = (s: AlertState, d: Decision): AlertState => ({ ...s, ...d.next });

const ACIMA = 10301, PROX = 10300, ATING = 10000;

test('T-SM-01 / T-RN-09 ACIMA->PROXIMO dispara PROXIMO e fecha só a trava proximo', () => {
  const d = run(base(), obs(PROX));
  assert.deepEqual(d.fire, { kind: 'PROXIMO', episode: 1, alreadyInBand: true });
  assert.equal(d.reason, 'disparo');
  assert.equal(d.next.armedProximo, false);
  assert.equal(d.next.armedAtingido, true);
  assert.equal(d.next.rearmNotBeforeProximo, iso(24));
  assert.equal(d.next.evaluatedOnce, true);
});

test('T-DUP-03 / T-RN-09 ACIMA->ATINGIDO envia só 1 e fecha as duas travas', () => {
  const d = run(base({ evaluatedOnce: true }), obs(ATING));
  assert.deepEqual(d.fire, { kind: 'ATINGIDO', episode: 1, alreadyInBand: false });
  assert.equal(d.next.armedProximo, false);
  assert.equal(d.next.armedAtingido, false);
  assert.equal(d.next.rearmNotBeforeProximo, iso(24)); // RN-13
  assert.equal(d.next.rearmNotBeforeAtingido, iso(24));
});

test('T-DUP-03 PROXIMO depois ATINGIDO envia 2', () => {
  let s = base();
  const d1 = run(s, obs(PROX));
  s = step(s, d1);
  const d2 = run(s, obs(ATING, 1), 1);
  assert.equal(d1.fire?.kind, 'PROXIMO');
  assert.equal(d2.fire?.kind, 'ATINGIDO');
});

test('T-DUP-01 / RF-10-AC2 reavaliar a mesma observação não dispara de novo', () => {
  const s = base();
  const d1 = run(s, obs(ATING));
  const d2 = run(step(s, d1), obs(ATING));
  assert.ok(d1.fire);
  assert.equal(d2.fire, null);
  assert.equal(d2.reason, 'travado');
});

test('T-SM-01 PAUSADO e não confirmada: sem efeito algum', () => {
  const p = run(base({ status: 'PAUSADO' }), obs(ATING));
  assert.equal(p.reason, 'inativo');
  assert.equal(p.fire, null);
  const n = run(base(), obs(ATING, 0, { confirmed: false }));
  assert.equal(n.reason, 'nao_confirmada');
  assert.equal(n.fire, null);
  assert.equal(n.next.evaluatedOnce, false);
  assert.equal(n.next.armedAtingido, true);
});

test('T-RN-11 não confirmada acima do limite não rearma', () => {
  const s = base({ armedAtingido: false, armedProximo: false, rearmNotBeforeAtingido: iso(-1), rearmNotBeforeProximo: iso(-1) });
  const d = run(s, obs(ACIMA, 0, { confirmed: false }));
  assert.equal(d.next.armedAtingido, false);
  assert.equal(d.next.armedProximo, false);
});

test('T-DUP-02 / RF-10-AC3 rearme após 24 h: P>T confirmado, depois P<=T dispara episódio 2', () => {
  let s = base({ evaluatedOnce: true });
  s = step(s, run(s, obs(ATING)));
  const up = run(s, obs(ACIMA, 25), 25);
  assert.equal(up.reason, 'rearmado');
  assert.equal(up.next.armedAtingido, true);
  assert.equal(up.next.armedProximo, true);
  assert.equal(up.next.episodeAtingido, 2);
  assert.equal(up.next.episodeProximo, 2);
  s = step(s, up);
  const again = run(s, obs(ATING, 26), 26);
  assert.deepEqual(again.fire, { kind: 'ATINGIDO', episode: 2, alreadyInBand: false });
});

test('T-DUP-02 / RF-10-AC4 anti-flapping: subida antes de 24 h não rearma; limite exato de 24 h rearma', () => {
  let s = base({ evaluatedOnce: true });
  s = step(s, run(s, obs(ATING)));
  const early = run(s, obs(ACIMA, 23), 23);
  assert.equal(early.next.armedAtingido, false);
  assert.equal(early.next.episodeAtingido, 1);
  s = step(s, early);
  assert.equal(run(s, obs(ATING, 24), 24).fire, null);
  assert.equal(run(s, obs(ACIMA, 24), 24).next.armedAtingido, true);
});

test('T-RN-11 em PROXIMO reabre só atingido; proximo só com P>T*(1+M)', () => {
  let s = base({ evaluatedOnce: true });
  s = step(s, run(s, obs(ATING))); // ambas fechadas
  const d = run(s, obs(PROX, 25), 25);
  assert.equal(d.next.armedAtingido, true);
  assert.equal(d.next.armedProximo, false);
  assert.equal(d.next.episodeProximo, 1);
  assert.equal(d.fire, null);
});

test('T-DUP-05 / RF-10-AC8 indisponível na faixa: nem dispara nem rearma; ao voltar dispara', () => {
  const s0 = base();
  const d1 = run(s0, obs(ATING, 0, { available: false }));
  assert.equal(d1.fire, null);
  assert.equal(d1.reason, 'indisponivel');
  assert.equal(d1.next.armedAtingido, true);
  assert.equal(d1.next.evaluatedOnce, false);
  const d2 = run(step(s0, d1), obs(ATING, 1), 1);
  assert.equal(d2.fire?.kind, 'ATINGIDO');

  // trava fechada, preço baixo e indisponível: não rearma
  const closed = base({ armedAtingido: false, armedProximo: false, rearmNotBeforeAtingido: iso(-1), rearmNotBeforeProximo: iso(-1) });
  const d3 = run(closed, obs(ATING, 30, { available: false }), 30);
  assert.equal(d3.next.armedAtingido, false);
  assert.equal(d3.next.armedProximo, false);
});

test('T-RN-11 indisponível com preço acima do limite rearma (decisão só por preço, architecture 3.4)', () => {
  const closed = base({ armedAtingido: false, armedProximo: false });
  const d = run(closed, obs(ACIMA, 0, { available: false }));
  assert.equal(d.reason, 'rearmado');
  assert.equal(d.next.armedAtingido, true);
  assert.equal(d.fire, null);
});

test('T-DUP-04 travas reabertas (edição, feita pelo service) dispararam de novo na faixa', () => {
  const edited = base({ revision: 2, evaluatedOnce: true });
  assert.equal(run(edited, obs(ATING)).fire?.kind, 'ATINGIDO');
});

test('T-RN-09 D-09 primeira avaliação marca alreadyInBand', () => {
  assert.equal(run(base(), obs(ATING)).fire?.alreadyInBand, true);
  assert.equal(run(base({ evaluatedOnce: true }), obs(ATING)).fire?.alreadyInBand, false);
});

test('T-RN-09 ACIMA sem travas a rearmar: fora_da_faixa; entrada não é mutada', () => {
  const s = base();
  const snap = structuredClone(s);
  const d = run(s, obs(ACIMA));
  assert.equal(d.reason, 'fora_da_faixa');
  assert.equal(d.fire, null);
  assert.deepEqual(s, snap);
});
