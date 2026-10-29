import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createComposer } from '../../src/ext/background/compose.ts';
import { createAlertStore } from '../../src/store/alerts.store.ts';
import { createMemoryDb, type MemoryDb } from '../../src/store/memory.ts';
import { createProductRepo, createRunRepo } from '../../src/store/monitor.store.ts';
import { createSettingsStore } from '../../src/store/settings.store.ts';
import { createKvStore } from '../../src/store/state.store.ts';
import { ManualClock } from '../helpers/clock.ts';
import { installFakeChrome, type FakeChrome } from '../helpers/fake-chrome.ts';
import { fixtureText } from '../helpers/fixtures.ts';
import { SeededRandom } from '../helpers/prng.ts';

// Núcleo do SW (E30) sobre fake chrome + Db em memória + fetch falso (loja). Nada de rede real.

const T0 = '2026-10-14T12:00:00.000Z';
const CODE = '1003800580026U'; // fixture OCC: 649,99 -> 379,99
const CODE2 = '1003800580027U';
const RESEND = 'https://api.resend.com/*';
const OCC = fixtureText(`occ_disc_${CODE}.json`);

// sleep() avança o relógio: a cortesia de 2-5 s do RateGate não espera de verdade.
class AutoClock extends ManualClock {
  override sleep(ms: number): Promise<void> {
    return this.advance(ms);
  }
}

const settle = async () => {
  for (let i = 0; i < 50; i++) await new Promise<void>((r) => setImmediate(r));
};

// Boot real do módulo: listeners no topo, composição de produção (sem IndexedDB no Node => degradado).
const boot = installFakeChrome();
const sw = await import('../../src/ext/background/sw.ts');
await settle();

let fc: FakeChrome | undefined;
afterEach(() => fc?.uninstall());

type Reply = { status: number; body: string; headers?: Record<string, string> };
async function setup(o: { products?: string[]; db?: MemoryDb } = {}) {
  fc = installFakeChrome({ clock: new AutoClock(T0) });
  const clock = fc.clock;
  const db = o.db ?? createMemoryDb();
  const codes = o.products ?? [CODE];
  const products = createProductRepo(db);
  const alerts = createAlertStore(db);
  for (const c of codes) {
    await products.upsertProduct({ code: c, name: 'Old Skool', legacySku: null, slug: 'old-skool' }, T0);
    await products.upsertVariants(c, [{ variantCode: `${c}-34`, size: '34', ean: null }], T0);
    await alerts.create({ variantCode: `${c}-34`, targetCents: 40000, marginBp: 300 }, T0);
  }
  const fetched: string[] = [];
  const replies = new Map<string, Reply[]>();
  const fakeFetch = (async (url: string) => {
    fetched.push(String(url));
    const code = /products\/([^/?]+)$/.exec(String(url))?.[1] ?? '';
    const r = replies.get(code)?.shift() ?? { status: 200, body: OCC.replaceAll(CODE, code) };
    return new Response(r.body, { status: r.status, headers: { 'content-type': 'application/json', ...r.headers } });
  }) as unknown as typeof fetch;
  let opened = 0;
  const compose = () =>
    createComposer({
      openDb: async () => (opened++, db), fetch: fakeFetch, clock, random: new SeededRandom(3), log: () => {},
    });
  // `current` é a "instância do SW": trocar = SW morto e reiniciado (o storage persiste).
  const ref = { current: compose() };
  sw.registerListeners(() => ref.current.getServices());
  await settle();
  return { fc, db, clock, fetched, replies, ref, compose, opened: () => opened, runs: createRunRepo(db) };
}

test('topo do modulo: registra todos os listeners de forma sincrona e cria o alarme tick (15 min) se ausente', async () => {
  for (const e of [boot.onMessage, boot.onAlarm, boot.onInstalled, boot.onStartup, boot.onClicked, boot.onPermRemoved])
    assert.equal(e.listeners.length, 1);
  const a = await chrome.alarms.get('tick');
  assert.equal(a?.periodInMinutes, 15);
  // idempotente: onStartup/onInstalled não duplicam nem reagendam
  const before = a!.scheduledTime;
  await boot.emitStartup();
  await boot.emitInstalled('update');
  await settle();
  assert.equal((await chrome.alarms.get('tick'))!.scheduledTime, before);
  assert.equal((await chrome.alarms.getAll()).length, 1);
});

test('topo do modulo: sem IndexedDB a composicao de producao degrada e responde somente_leitura, sem lancar', async () => {
  const r = (await chrome.runtime.sendMessage({ type: 'alerts.list' })) as { ok: boolean; error: { code: string } };
  assert.deepEqual([r.ok, r.error.code], [false, 'somente_leitura']);
  await boot.fire('tick'); // não lança
});

test('mensagem de remetente estranho e recusada sem compor servicos', async () => {
  const s = await setup();
  const r = (await s.fc.sendFrom({ type: 'settings.get' }, { id: 'outra', url: 'https://evil.example/' })) as { error: { code: string } };
  assert.equal(r.error.code, 'remetente_invalido');
  assert.equal(s.opened(), 0);
  const ok = (await chrome.runtime.sendMessage({ type: 'settings.get' })) as { ok: boolean };
  assert.equal(ok.ok, true);
});

test("fire('tick') roda a rodada contra a loja falsa e mostra a notificacao; clique abre so a loja", async () => {
  const s = await setup();
  await s.fc.fire('tick');
  assert.equal(s.fetched.length, 1);
  assert.match(s.fetched[0]!, /^https:\/\/www\.vans\.com\.br\/arezzocoocc\/v2\/vans\/products\//);
  assert.equal((await s.runs.lastFinished('monitor'))?.status, 'ok');
  assert.equal(s.fc.notificationCalls.length, 1);
  const n = s.fc.notificationCalls[0]!;
  assert.match(String(n.options.title), /Preço-alvo atingido/);
  assert.match(String(n.options.message), /379,99/);
  // segundo tick logo depois: intervalo não venceu, nenhuma requisição nova (orçamento/intervalo respeitados)
  await s.fc.fire('tick');
  assert.equal(s.fetched.length, 1);
  await s.fc.click(n.id);
  await settle();
  assert.deepEqual(s.fc.tabs.map((t) => t.url), [`https://www.vans.com.br/p/${CODE}`]);
});

test('SW morto: descartar a instancia de servicos e disparar o alarme resume retoma a mesma rodada sem refazer', async () => {
  const s = await setup({ products: [CODE, CODE2] });
  s.replies.set(CODE2, [{ status: 429, body: '', headers: { 'retry-after': '60' } }]);
  await s.fc.fire('tick');
  const run = await s.runs.getRunning('monitor');
  assert.ok(run, 'rodada pausada continua running');
  assert.ok(await chrome.alarms.get('resume'), 'espera longa vira alarme resume');
  assert.equal(s.fc.notificationCalls.length, 0); // nada notificado antes do fechamento

  s.ref.current = s.compose(); // nova instância: nada em memória sobrevive
  await s.clock.advance(60_000);
  await s.fc.fire('resume');
  assert.equal((await s.runs.lastFinished('monitor'))?.id, run.id);
  assert.equal((await s.runs.lastFinished('monitor'))?.status, 'ok');
  const per = (c: string) => s.fetched.filter((u) => u.endsWith(`/${c}`)).length;
  assert.deepEqual([per(CODE), per(CODE2)], [1, 2]); // o que já foi lido não é relido
  assert.equal(s.fc.notificationCalls.length, 2);
  assert.equal(await chrome.alarms.get('resume'), undefined);
});

test('composicao de producao atende o popup/opcoes: saude, catalogo, e-mail de teste simulado e alarme outbox', async () => {
  const s = await setup();
  type R = { ok: boolean; data: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const send = (m: unknown) => chrome.runtime.sendMessage(m) as Promise<R>;
  const h = await send({ type: 'health.get' });
  assert.equal(h.ok, true);
  assert.equal(h.data.budget.limit, 400);
  assert.deepEqual((await send({ type: 'catalog.search', q: 'old' })).data.items, []);
  await send({ type: 'settings.set', settings: { intervalHours: 4, email: { mode: 'teste', enabled: true, to: 'eu@exemplo.com', from: 'eu@exemplo.com' } } });
  assert.deepEqual((await send({ type: 'email.test' })).data, { accepted: true, simulated: true });
  await chrome.alarms.create('outbox', { when: 0 });
  await s.fc.fire('outbox');
  assert.equal(s.fetched.length, 0); // modo teste: nenhuma rede (nem loja nem provedor)
});

test('revogar a permissao do provedor desliga o e-mail', async () => {
  const s = await setup();
  const settings = createSettingsStore(createKvStore(s.db));
  await chrome.permissions.request({ origins: [RESEND] });
  const set = await settings.set({ email: { mode: 'real', enabled: true, to: 'eu@exemplo.com', from: 'onboarding@resend.dev', apiKey: 're_x' } });
  assert.ok(set.ok);
  s.fc.revoke({ origins: [RESEND] });
  await settle();
  const e = (await settings.get()).email;
  assert.equal(e.enabled, false);
  assert.equal(e.apiKey, 're_x'); // só desliga; não apaga configuração
});

test('base de versao futura: modo degradado, nenhuma rodada, nenhuma escrita e nada apagado', async () => {
  const seed = createMemoryDb();
  await createProductRepo(seed).upsertProduct({ code: CODE, name: 'Old Skool', legacySku: null, slug: 'old-skool' }, T0);
  await createKvStore(seed).set('last_tick_at', T0);
  const state = seed.dump();
  state.version += 1; // dados de uma versão mais nova do que o código
  const frozen = structuredClone(state);
  fc = installFakeChrome({ clock: new AutoClock(T0) });
  let fetches = 0;
  let opens = 0;
  const c = createComposer({
    openDb: async () => (opens++, createMemoryDb({ state })),
    fetch: (async () => (fetches++, new Response('{}'))) as unknown as typeof fetch,
    clock: fc.clock, log: () => {},
  });
  sw.registerListeners(() => c.getServices());
  await settle();
  assert.deepEqual(await c.getServices(), { degraded: true, reason: 'versao_futura' });
  await fc.fire('tick');
  const r = (await chrome.runtime.sendMessage({ type: 'alert.create', variantCode: `${CODE}-34`, target: '10,00' })) as { ok: boolean; error: { code: string; message: string } };
  assert.deepEqual([r.ok, r.error.code], [false, 'somente_leitura']);
  assert.match(r.error.message, /versão mais nova/);
  assert.equal(fetches, 0);
  assert.equal(fc.notificationCalls.length, 0);
  assert.deepEqual(state, frozen); // nada apagado nem recriado
  assert.ok(opens >= 2, 'falha não fica em cache: o próximo evento tenta abrir de novo');
});
