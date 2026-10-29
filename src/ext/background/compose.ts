// Composição preguiçosa dos serviços do SW sobre IndexedDB (idb.ts) e fetch (extension-architecture.md 4, 7.4).
// Só há cache de coisas reconstruíveis (Db, serviços); todo estado de negócio vive no storage.
import { AlertService } from '../../app/alerts.ts';
import { createCatalogApp } from '../../app/catalog.ts';
import { CircuitStore } from '../../app/circuit-store.ts';
import { buildHealth } from '../../app/health.ts';
import { MonitorService } from '../../app/monitor.ts';
import { createNotificationService } from '../../app/notifications.ts';
import { withRateGate, type RateGate } from '../../app/rate-gate.ts';
import { Round } from '../../app/round.ts';
import { createTick } from '../../app/tick.ts';
import { DryRunMailer } from '../../notifications/mailer.dry.ts';
import { ResendMailer } from '../../notifications/mailer.resend.ts';
import { createLogger, type Logger } from '../../observability/logger.ts';
import { CompositeSource } from '../../price-monitor/composite.source.ts';
import { FetchHttpClient } from '../../price-monitor/http/fetch-http.ts';
import { NextDataSource } from '../../price-monitor/nextdata.source.ts';
import { OccSource } from '../../price-monitor/occ.source.ts';
import type { HttpClient, ProductRow } from '../../price-monitor/ports.ts';
import type { EmailSettings } from '../../settings/settings.ts';
import { SystemClock, type Clock } from '../../shared/clock.ts';
import { SystemRandom, type Random } from '../../shared/random.ts';
import { createAlertStore } from '../../store/alerts.store.ts';
import { createCatalogStore } from '../../store/catalog.store.ts';
import { prefixRange, type Db } from '../../store/db.ts';
import { createHealthEventStore } from '../../store/events.store.ts';
import { createHealthReadStore } from '../../store/health.store.ts';
import { createObservationRepo } from '../../store/history.store.ts';
import { openIdb } from '../../store/idb.ts';
import { createProductRepo, createRequestLog, createRunRepo } from '../../store/monitor.store.ts';
import { IdbNotificationRepo } from '../../store/notifications.store.ts';
import type { KvKey } from '../../store/ports.ts';
import { createSettingsStore } from '../../store/settings.store.ts';
import { createKvStore } from '../../store/state.store.ts';
import { errResponse } from '../messages.ts';
import { createChromeNotifier } from '../notifier.chrome.ts';
import { RESEND_ORIGIN, schedule } from './alarms.ts';
import { createApi, type Api } from './api.ts';

export type Services =
  | { degraded: true; reason: 'versao_futura' | 'falha_ao_abrir' }
  | {
      degraded: false;
      api: Api;
      tick(): Promise<unknown>;
      resume(): Promise<unknown>;
      drain(): Promise<unknown>;
      emailPermissionRemoved(): Promise<void>;
      notificationCode(key: string): Promise<string | null>;
      log: Logger;
    };

export interface ComposeOpts {
  openDb?: () => Promise<Db>;
  fetch?: typeof fetch;
  clock?: Clock;
  random?: Random;
  log?: (line: string) => void;
}

// ponytail: chave fora da união KvKey (store/ports.ts é de outro dono); o kv aceita qualquer string.
const INSTALLED_KEY = 'installed_at' as unknown as KvKey;
export const DEGRADED_MSG = 'Os dados são de uma versão mais nova da extensão ou a migração falhou. Atualize a extensão; nada foi apagado.';

/** Api do modo somente leitura: o remetente já foi validado por registerApi; tudo responde `somente_leitura`. */
export const degradedApi: Api = { handle: async () => errResponse('somente_leitura', DEGRADED_MSG) };

export function createComposer(o: ComposeOpts = {}) {
  const clock = o.clock ?? new SystemClock();
  const random = o.random ?? new SystemRandom();
  const fetchImpl: typeof fetch = o.fetch ?? ((...a) => fetch(...a));
  const open = o.openDb ?? (() => openIdb());
  const log = createLogger('sw', clock, o.log);
  let dbP: Promise<Db> | undefined;
  let gate: RateGate | undefined; // 1 em voo + cortesia valem para rodada, popup e catálogo juntos
  let cache: { mode: EmailSettings['mode']; s: Services } | undefined;

  async function getServices(): Promise<Services> {
    let db: Db;
    try {
      db = await (dbP ??= open());
    } catch (e) {
      dbP = undefined; // não cacheia a falha; nunca cria base vazia por cima
      const reason = (e as { name?: string } | null)?.name === 'VersionError' ? 'versao_futura' : 'falha_ao_abrir';
      log.error(reason === 'versao_futura' ? 'base_versao_futura' : 'base_falha_ao_abrir');
      return { degraded: true, reason };
    }
    const mode = (await createSettingsStore(createKvStore(db)).get()).email.mode;
    // `mode` é fixado na construção dos serviços: trocar o modo nas opções recompõe.
    if (cache?.mode !== mode) cache = { mode, s: await build(db, mode) };
    return cache.s;
  }

  async function build(db: Db, mode: EmailSettings['mode']): Promise<Services> {
    const kv = createKvStore(db);
    const settings = createSettingsStore(kv);
    const base = createProductRepo(db);
    const products = {
      ...base,
      // ponytail: resetFailures ainda não existe em ProductRepo (contrato pedido em app/monitor.ts).
      async resetFailures(code: string, now: string) {
        const p = await db.get<ProductRow>('products', code);
        if (p) await db.put('products', { ...p, consecutiveFailures: 0, notFoundStreak: 0, updatedAt: now });
      },
    };
    const runs = createRunRepo(db);
    const alerts = createAlertStore(db);
    const observations = createObservationRepo(db);
    const notifications = new IdbNotificationRepo(db);
    const health = createHealthEventStore(db);
    const requestLog = createRequestLog(db);
    const circuit = new CircuitStore(kv);
    const tx = <T>(fn: () => Promise<T>) => db.tx(fn);
    const now = () => clock.now().getTime();
    const emailEnabled = async () => (await settings.get()).email.enabled;
    const hasMailPermission = () => chrome.permissions.contains({ origins: [RESEND_ORIGIN] });
    const http: HttpClient = new FetchHttpClient({ fetch: fetchImpl, clock });
    gate ??= withRateGate(http, { clock, random, log: requestLog });
    const sourceFor = (h: HttpClient) => new CompositeSource([new OccSource(h, clock), new NextDataSource(h, clock)]);
    const realMailer = (e: EmailSettings) => new ResendMailer({ apiKey: e.apiKey, from: e.from }, (u, i) => fetchImpl(u, i));

    let installedAt = await kv.get(INSTALLED_KEY);
    if (installedAt === null) await kv.set(INSTALLED_KEY, (installedAt = clock.now().toISOString()));

    const notifier = createNotificationService({
      repo: notifications, alerts, notifier: createChromeNotifier(), settings, realMailer, hasMailPermission,
      schedule: (name, when) => schedule(name, when, now()), clock, log,
    });
    const alertService = new AlertService({ alerts, notifications, observations, products, clock, tx, mode, emailEnabled });
    const monitor = new MonitorService({
      source: sourceFor(gate.forPurpose('discover')), products, observations, alerts, alertService, notifications,
      emailEnabled, mode, runs, health, circuit, clock, log, tx, confirmReread: true,
    });
    const round = new Round({
      source: sourceFor(gate.forPurpose('monitor')), monitor, products, alerts, runs,
      runItems: (id) => db.getAll('run_items', { range: prefixRange(id) }),
      requestLog, circuit, kv, health, notifications, emailEnabled, mode,
      drain: () => notifier.drain(),
      schedule: (name, when) => schedule(name, when, now()),
      clock, random, log, tx,
    });
    const tick = createTick({ round, runs, settings, kv, notifications: notifier, clock });
    const catalog = createCatalogApp({ store: createCatalogStore(db), http: gate.forPurpose('catalog'), circuit, clock });
    const read = createHealthReadStore(db);

    const api = createApi({
      alerts: alertService, alertRepo: alerts, products, observations, notifications, notifier, monitor, settings,
      health: async () => {
        const s = await settings.get();
        return buildHealth({
          read, kv, events: health, requests: requestLog, clock, version: chrome.runtime.getManifest?.().version ?? '0.0.0',
          intervalMs: s.intervalHours * 3_600_000, installedAt: new Date(installedAt),
          emailMode: s.email.enabled ? s.email.mode : 'desligado',
        });
      },
      catalog: { search: (q, n) => catalog.search(q, n), refreshedAt: () => catalog.lastRefreshAt(), refresh: () => catalog.refresh('manual') },
      runNow: () => round.resumeOrStart('manual'),
      async sendTestEmail() {
        const e = (await settings.get()).email;
        const mailer = e.mode === 'real' ? realMailer(e) : new DryRunMailer();
        const r = await mailer.send({
          to: e.to,
          subject: 'Vans Price Watcher: e-mail de teste',
          text: 'Este é um e-mail de teste do Vans Price Watcher. Se chegou, o envio está configurado.',
          html: '<p>Este é um e-mail de teste do Vans Price Watcher. Se chegou, o envio está configurado.</p>',
          idempotencyKey: `teste|${clock.now().toISOString()}`,
        });
        return { ...r, simulated: mailer.mode === 'teste' };
      },
      hasMailPermission,
      log,
    });

    return {
      degraded: false,
      api,
      tick,
      resume: () => round.resumeOrStart('recovery', { resumeOnly: true }),
      drain: () => notifier.drain(),
      async emailPermissionRemoved() {
        await settings.set({ email: { enabled: false } });
        log.warn('email_desligado_permissao_removida');
      },
      notificationCode: async (key) => (await notifications.get(key))?.productCode ?? null,
      log,
    };
  }

  return { getServices };
}
