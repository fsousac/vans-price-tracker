import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNotificationService } from '../../src/app/notifications.ts';
import { FakeMailer } from '../../src/notifications/mailer.fake.ts';
import type { Notifier } from '../../src/notifications/notifier.ts';
import type { MailResult } from '../../src/notifications/ports.ts';
import { createAlertStore } from '../../src/store/alerts.store.ts';
import { createMemoryDb } from '../../src/store/memory.ts';
import { IdbNotificationRepo } from '../../src/store/notifications.store.ts';
import { parseSettings } from '../../src/settings/settings.ts';
import type { IsoUtc } from '../../src/shared/types.ts';
import { ManualClock } from '../helpers/clock.ts';

const START = '2026-10-14T12:00:00.000Z';
const P = '1003800580026U';
const MIN = 60_000;
const TEMP: MailResult = { kind: 'temporary_error', reason: 'resend 503' };
const REAL = { mode: 'real', from: 'a@exemplo.com', apiKey: 'k' };

async function setup(email: Record<string, unknown> = {}) {
  const clock = new ManualClock(START);
  const db = createMemoryDb();
  await db.put('products', { code: P, name: 'Tenis', state: 'ATIVO' });
  await db.put('variants', { variantCode: `${P}-34`, productCode: P, size: '34' });
  const alerts = createAlertStore(db);
  const alertId = await alerts.create({ variantCode: `${P}-34`, targetCents: 19990, marginBp: 300 }, START as IsoUtc);
  const repo = new IdbNotificationRepo(db);
  let settings = parseSettings({ v: 1, email: { enabled: true, mode: 'teste', to: 'eu@exemplo.com', ...email } });
  const shown: string[] = [];
  let desktopResult: 'mostrada' | 'falha' = 'mostrada';
  const notifier: Notifier = { async show(n) { shown.push(n.key); return desktopResult; } };
  const real = new FakeMailer('real');
  let perm = true;
  const scheduled: (string | null)[] = [];
  const svc = createNotificationService({
    repo, alerts, notifier, clock,
    settings: { get: async () => settings },
    realMailer: () => real,
    hasMailPermission: async () => perm,
    schedule: async (_n, when) => { scheduled.push(when); },
    log: { debug() {}, info() {}, warn() {}, error() {} },
  });
  let n = 0;
  const enqueue = async (): Promise<string> => {
    const key = `${alertId}|1|ATINGIDO|${++n}`;
    await repo.insertIfAbsent({
      key, alertId, healthEventId: null, observationId: null, kind: 'ATINGIDO', emailEnabled: true, mode: 'teste',
      productCode: P as never, productName: 'Tenis', productSlug: null, size: '34', priceCents: 18990 as never,
      targetCents: 19990 as never, marginBp: 300 as never, observedAt: START as IsoUtc, source: 'occ' as never,
      degraded: false, alreadyInBand: false, now: clock.now().toISOString() as IsoUtc,
    });
    return key;
  };
  return {
    clock, repo, svc, alerts, alertId, real, shown, scheduled, enqueue,
    setSettings: (e: Record<string, unknown>) => { settings = parseSettings({ v: 1, email: { enabled: true, to: 'eu@exemplo.com', ...e } }); },
    setDesktop: (r: 'mostrada' | 'falha') => { desktopResult = r; },
    setPerm: (v: boolean) => { perm = v; },
  };
}

test('T-NOT-01 RF-08 desktop imediato; modo teste termina ACEITO simulado sem usar mailer real', async () => {
  const t = await setup();
  const key = await t.enqueue();
  assert.deepEqual(await t.svc.drain(), { desktop: 1, email: 1 });
  const r = (await t.repo.get(key))!;
  assert.equal(r.desktop, 'mostrada');
  assert.equal(r.email, 'ACEITO');
  assert.equal(r.simulated, true);
  assert.equal(t.real.sent.length, 0);
  assert.equal(t.scheduled.at(-1), null); // nada pendente: alarme removido
  assert.deepEqual(await t.svc.drain(), { desktop: 0, email: 0 }); // idempotente
});

test('T-NOT-02 desktop falha nao bloqueia o e-mail e nao e reenviado', async () => {
  const t = await setup(REAL);
  t.setDesktop('falha');
  const key = await t.enqueue();
  await t.svc.drain();
  const r = (await t.repo.get(key))!;
  assert.equal(r.desktop, 'falha');
  assert.equal(r.email, 'ACEITO');
  assert.equal(r.simulated, false);
  assert.equal(t.real.sent.length, 1);
  await t.svc.drain();
  assert.equal(t.shown.length, 1);
});

test('T-NOT-04 retentativas 5 min/30 min/2 h, 4 envios, 5a nao existe, alarme outbox', async () => {
  const t = await setup(REAL);
  t.real.enqueue(TEMP, TEMP, TEMP, TEMP, TEMP);
  const key = await t.enqueue();
  const at = (ms: number) => new Date(Date.parse(START) + ms).toISOString();
  await t.svc.drain();
  assert.equal(t.real.sent.length, 1);
  let r = (await t.repo.get(key))!;
  assert.deepEqual([r.email, r.attempts, r.nextAttemptAt], ['PENDENTE', 1, at(5 * MIN)]);
  assert.equal(t.scheduled.at(-1), at(5 * MIN));

  await t.clock.advance(5 * MIN - 1);
  await t.svc.drain();
  assert.equal(t.real.sent.length, 1); // ainda cedo
  await t.clock.advance(1);
  await t.svc.drain();
  r = (await t.repo.get(key))!;
  assert.deepEqual([t.real.sent.length, r.attempts, r.nextAttemptAt], [2, 2, at(35 * MIN)]);

  await t.clock.advance(30 * MIN);
  await t.svc.drain();
  r = (await t.repo.get(key))!;
  assert.deepEqual([t.real.sent.length, r.attempts, r.nextAttemptAt], [3, 3, at(155 * MIN)]);

  await t.clock.advance(120 * MIN);
  await t.svc.drain();
  r = (await t.repo.get(key))!;
  assert.deepEqual([t.real.sent.length, r.attempts, r.email, r.nextAttemptAt], [4, 4, 'FALHA', null]);
  assert.equal(t.scheduled.at(-1), null);

  await t.clock.advance(24 * 60 * MIN);
  await t.svc.drain();
  assert.equal(t.real.sent.length, 4); // 5a tentativa nao existe
});

test('T-NOT-04 attempts ja esta gravado quando o envio comeca', async () => {
  const t = await setup(REAL);
  const key = await t.enqueue();
  let seen = -1;
  const orig = t.real.send.bind(t.real);
  t.real.send = async (m) => { seen = (await t.repo.get(key))!.attempts; return orig(m); };
  await t.svc.drain();
  assert.equal(seen, 1);
});

test('T-NOT-05 erro permanente 4xx = FALHA sem retentativa; reenviar volta a PENDENTE e envia', async () => {
  const t = await setup(REAL);
  t.real.enqueue({ kind: 'permanent_error', reason: 'resend 422' });
  const key = await t.enqueue();
  await t.svc.drain();
  let r = (await t.repo.get(key))!;
  assert.deepEqual([r.email, r.attempts, r.failureReason], ['FALHA', 1, 'resend 422']);
  assert.equal(await t.svc.reenviar(key), true);
  r = (await t.repo.get(key))!;
  assert.deepEqual([r.email, r.attempts], ['ACEITO', 1]);
  assert.equal(await t.svc.reenviar(key), false); // so FALHA reenvia
  assert.equal(await t.svc.reenviar('inexistente'), false);
});

test('T-SEC-05 sem permissao de host: FALHA permissao_ausente, sem chamar o mailer', async () => {
  const t = await setup(REAL);
  t.setPerm(false);
  const key = await t.enqueue();
  await t.svc.drain();
  const r = (await t.repo.get(key))!;
  assert.deepEqual([r.email, r.failureReason], ['FALHA', 'permissao_ausente']);
  assert.equal(t.real.sent.length, 0);
});

test('T-NOT-06 modo real sem chave/remetente ou sem destinatario = FALHA, nada enviado', async () => {
  const t = await setup({ mode: 'real', from: '', apiKey: '' });
  const k1 = await t.enqueue();
  await t.svc.drain();
  assert.equal((await t.repo.get(k1))!.failureReason, 'configuracao_incompleta');
  t.setSettings({ mode: 'teste', to: '' });
  const k2 = await t.enqueue();
  await t.svc.drain();
  assert.equal((await t.repo.get(k2))!.failureReason, 'sem_destinatario');
  assert.equal(t.real.sent.length, 0);
});

test('T-NOT-07 e-mail desligado: so desktop; linha PENDENTE intacta', async () => {
  const t = await setup({ enabled: false });
  const key = await t.enqueue();
  assert.deepEqual(await t.svc.drain(), { desktop: 1, email: 0 });
  const r = (await t.repo.get(key))!;
  assert.deepEqual([r.desktop, r.email, r.attempts], ['mostrada', 'PENDENTE', 0]);
});

test('T-NOT-08 teto 20/h: excedente fica PENDENTE e sai quando a janela libera', async () => {
  const t = await setup(REAL);
  for (let i = 0; i < 25; i++) await t.enqueue();
  await t.svc.drain(); // lote de 10
  await t.svc.drain();
  const last = await t.svc.drain();
  assert.equal(t.real.sent.length, 20);
  assert.equal(last.email, 0);
  assert.equal(t.scheduled.at(-1), new Date(Date.parse(START) + 60 * MIN).toISOString());
  await t.clock.advance(60 * MIN);
  await t.svc.drain();
  assert.equal(t.real.sent.length, 25);
});

test('T-WEB-03 RN-15 pausa > 24 h descarta PENDENTE (alerta_pausado); ate 24 h mantem', async () => {
  const t = await setup(REAL);
  const key = await t.enqueue();
  await t.alerts.update(t.alertId, { status: 'PAUSADO' }, START as IsoUtc);
  await t.clock.advance(24 * 60 * MIN);
  await t.svc.drain();
  assert.equal((await t.repo.get(key))!.email, 'PENDENTE');
  assert.equal(t.real.sent.length, 0);
  await t.clock.advance(1);
  await t.svc.drain();
  const r = (await t.repo.get(key))!;
  assert.deepEqual([r.email, r.failureReason], ['FALHA', 'alerta_pausado']);
  assert.equal(t.real.sent.length, 0);
});

test('T-RN-15 lease: drains concorrentes nao reenviam a mesma linha', async () => {
  const t = await setup(REAL);
  await t.enqueue();
  await Promise.all([t.svc.drain(), t.svc.drain()]);
  assert.equal(t.real.sent.length, 1);
});
