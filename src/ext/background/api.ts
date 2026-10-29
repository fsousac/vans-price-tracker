import type { Logger } from '../../observability/logger.ts';
import { extractProductCode } from '../../price-monitor/url.ts';
import type { AlertError, AlertService } from '../../app/alerts.ts';
import type { RefreshOutcome, RefreshRefusal } from '../../app/catalog.ts';
import type { buildHealth } from '../../app/health.ts';
import type { MonitorService } from '../../app/monitor.ts';
import type { NotificationService } from '../../app/notifications.ts';
import type { MailResult } from '../../notifications/ports.ts';
import type { Result } from '../../shared/result.ts';
import type { AlertRow, CatalogItem, NotificationRow, ObservationRow, ProductRow, VariantRow } from '../../store/ports.ts';
import type { SettingsStore } from '../../store/settings.store.ts';
import { errResponse, okResponse, parseRequest, type Request, type Response } from '../messages.ts';

// Despacho UI -> SW (extension-architecture.md seção 11). Sem estado de módulo: tudo vem de `deps`
// (composição preguiçosa em compose.ts). Única leitura de `chrome` é runtime.id/getURL (validação do remetente).

export const HISTORY_PAGE = 50;
export const CATALOG_LIMIT = 50;

export interface ApiDeps {
  alerts: Pick<AlertService, 'create' | 'edit' | 'pause' | 'resume' | 'delete'>;
  alertRepo: { list(): Promise<AlertRow[]>; get(id: number): Promise<AlertRow | null> };
  products: { get(code: string): Promise<ProductRow | null>; getVariant(v: string): Promise<VariantRow | null> };
  observations: {
    latestConfirmed(v: string): Promise<ObservationRow | null>;
    history(v: string, limit: number, offset: number): Promise<ObservationRow[]>;
  };
  notifications: { listForAlert(alertId: number): Promise<NotificationRow[]> };
  notifier: Pick<NotificationService, 'reenviar'>;
  monitor: Pick<MonitorService, 'discoverProduct' | 'resumeProduct'>;
  health(): ReturnType<typeof buildHealth>;
  catalog: {
    search(q: string, limit: number): Promise<CatalogItem[]>;
    refreshedAt(): Promise<string | null>;
    refresh(): Promise<Result<RefreshOutcome, RefreshRefusal>>;
  };
  settings: SettingsStore;
  /** resumeOrStart('manual'): o resultado (rodada iniciada/pulada e motivo) é repassado à UI. */
  runNow(): Promise<unknown>;
  /** Envia (ou simula, conforme o modo) o e-mail de teste; nunca lança por erro de provedor. */
  sendTestEmail(): Promise<MailResult & { simulated?: boolean }>;
  /** chrome.permissions.contains para o host do provedor. */
  hasMailPermission(): Promise<boolean>;
  log?: Logger;
}

const SENDER_MSG = 'Origem da requisição não autorizada.';

/** Só páginas da própria extensão: id igual e URL sob chrome-extension://<id>/. */
export function senderOk(sender: { id?: string; url?: string } | undefined): boolean {
  try {
    return !!sender && !!chrome.runtime.id && sender.id === chrome.runtime.id &&
      typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));
  } catch {
    return false;
  }
}

const pad2 = (n: number) => String(n).padStart(2, '0');
const centsText = (c: number) => `${Math.floor(c / 100)},${pad2(c % 100)}`; // formato aceito por validateTarget
const bpText = (bp: number) => `${Math.floor(bp / 100)},${pad2(bp % 100)}`; // formato aceito por validateMargin

function alertError(e: AlertError): Response<never> {
  switch (e.kind) {
    case 'validacao': return errResponse('requisicao_invalida', Object.values(e.fields).join(' '));
    case 'sem_variante': return errResponse('requisicao_invalida', 'Escolha um tamanho.');
    case 'variante_inexistente': return errResponse('nao_encontrado', 'Tamanho não encontrado. Reabra o produto e tente de novo.');
    case 'limite_produtos': return errResponse('requisicao_invalida', e.message);
    case 'duplicado': return errResponse('duplicado', e.message);
    case 'nao_encontrado': return errResponse('nao_encontrado', 'Monitoramento não encontrado.');
  }
}

function refreshError(r: RefreshRefusal): Response<never> {
  switch (r.reason) {
    case 'intervalo_minimo': return errResponse('requisicao_invalida', `O catálogo já foi atualizado hoje. Nova atualização liberada em ${r.nextAllowedAt}.`);
    case 'circuito_aberto': return errResponse('circuito_aberto', 'A coleta está pausada por segurança (a loja bloqueou ou limitou o acesso). Tente mais tarde.');
    case 'em_andamento': return errResponse('requisicao_invalida', 'Uma atualização do catálogo já está em andamento.');
    case 'orcamento_esgotado': return errResponse('falha_externa', 'O limite diário de requisições à loja foi atingido.');
    case 'falha': return errResponse('falha_externa', 'Não foi possível atualizar o catálogo agora.');
  }
}

// Motivo do provedor só vira texto se for um código curto; nada de corpo/cabeçalho/chave na saída.
const safeReason = (r: string) => (/^[a-z0-9_]{1,40}$/.test(r) ? ` (${r})` : '');

export function createApi(d: ApiDeps) {
  const interval = async () => (await d.settings.getPublic()).intervalHours;

  async function inspect(url: string): Promise<Response> {
    const c = extractProductCode(url);
    if (!c.ok) return errResponse('requisicao_invalida', c.error.message);
    const r = await d.monitor.discoverProduct(c.value);
    if (!r.ok) {
      if (r.error.reason === 'circuito_aberto') return errResponse('circuito_aberto', 'A coleta está pausada por segurança. Tente mais tarde.');
      if (r.error.reason === 'orcamento_diario') return errResponse('falha_externa', 'O limite diário de requisições à loja foi atingido.');
      return errResponse('falha_externa', r.error.failureClass === 'formato_desconhecido'
        ? 'Formato de página desconhecido (formato_desconhecido).'
        : 'Não foi possível ler o produto agora. Tente novamente mais tarde.');
    }
    const { product, variants } = r.value;
    const all = await d.alertRepo.list();
    const vs = await Promise.all(variants.map(async (v) => {
      const o = await d.observations.latestConfirmed(v.variantCode); // preço só de leitura confirmada; senão null
      return { variantCode: v.variantCode, code: v.variantCode, size: v.size, priceCents: o?.currentCents ?? null, available: o?.available ?? true };
    }));
    const mine = new Set(variants.map((v) => v.variantCode));
    const monitored = all.filter((a) => mine.has(a.variantCode))
      .map((a) => ({ id: a.id, variantCode: a.variantCode, targetCents: a.targetCents, marginBp: a.marginBp, state: a.status }));
    return okResponse({ code: product.code, name: product.name, state: product.state, fromCache: r.value.fromCache, variants: vs, monitored });
  }

  async function update(req: Extract<Request, { type: 'alert.update' }>): Promise<Response> {
    const cur = await d.alertRepo.get(req.id);
    if (!cur) return errResponse('nao_encontrado', 'Monitoramento não encontrado.');
    const r = await d.alerts.edit(req.id, {
      target: req.target ?? centsText(cur.targetCents),
      margin: req.margin ?? bpText(cur.marginBp),
    });
    return r.ok ? okResponse(r.value) : alertError(r.error);
  }

  async function list(): Promise<Response> {
    const rows = await Promise.all((await d.alertRepo.list()).map(async (a) => {
      const v = await d.products.getVariant(a.variantCode);
      const p = v ? await d.products.get(v.productCode) : null;
      const o = await d.observations.latestConfirmed(a.variantCode);
      return {
        id: a.id, code: v?.productCode ?? a.variantCode.split('-')[0], variantCode: a.variantCode,
        productName: p?.name ?? 'Produto', productState: p?.state ?? null, size: v?.size ?? a.variantCode.split('-')[1] ?? '',
        targetCents: a.targetCents, marginBp: a.marginBp, status: a.status,
        priceCents: o?.currentCents ?? null, lastConfirmedAt: o?.observedAt ?? null, available: o?.available ?? null,
      };
    }));
    return okResponse({ alerts: rows, intervalHours: await interval() });
  }

  async function history(req: Extract<Request, { type: 'history.get' }>): Promise<Response> {
    const a = await d.alertRepo.get(req.alertId);
    if (!a) return errResponse('nao_encontrado', 'Monitoramento não encontrado.');
    const rows = await d.observations.history(a.variantCode, HISTORY_PAGE + 1, req.page * HISTORY_PAGE);
    const observations = rows.slice(0, HISTORY_PAGE).map((o) => ({
      observedAt: o.observedAt, originalCents: o.originalCents, currentCents: o.currentCents,
      available: o.available, source: o.source, confirmed: o.confirmed, degraded: o.degraded,
    }));
    const notifications = req.page === 0
      ? (await d.notifications.listForAlert(a.id)).map((n) => ({
          key: n.key, kind: n.kind, createdAt: n.createdAt, desktop: n.desktop, email: n.email, simulated: n.simulated,
        }))
      : [];
    return okResponse({ observations, notifications, hasMore: rows.length > HISTORY_PAGE });
  }

  async function health(): Promise<Response> {
    const [h, alerts, s] = await Promise.all([d.health(), d.alertRepo.list(), d.settings.getPublic()]);
    const lastConfirmed = await Promise.all(alerts.filter((a) => a.status === 'ATIVO')
      .map(async (a) => (await d.observations.latestConfirmed(a.variantCode))?.observedAt ?? null));
    const lr = h.scheduler.lastRun;
    return okResponse({ // forma HealthDto (ui/options/health-model.ts); sem e-mail, chave, URL ou corpo
      lastRun: lr && { status: lr.status, startedAt: lr.startedAt, finishedAt: lr.finishedAt, ok: lr.itemsOk, failed: lr.itemsFailed, skipped: 0 },
      circuit: { openUntil: h.circuit.until, reason: h.circuit.reason },
      lastConfirmed,
      intervalMs: s.intervalHours * 3_600_000,
      budget: { used: h.budget24h.used, limit: h.budget24h.limit },
      openEvents: h.openEvents.map((e) => ({ kind: e.kind, subject: e.subject, since: e.openedAt })),
      emailMode: h.emailMode,
      schedulerStatus: h.scheduler.status,
      lastTickAt: h.scheduler.lastTickAt,
    });
  }

  async function setSettings(req: Extract<Request, { type: 'settings.set' }>): Promise<Response> {
    const { intervalHours, email: e } = req.settings;
    if (e.enabled && e.mode === 'real' && !(await d.hasMailPermission()))
      return errResponse('permissao_ausente', 'Conceda a permissão para o provedor de e-mail antes de ativar o modo real.');
    const r = await d.settings.set({
      intervalHours,
      email: { mode: e.mode, enabled: e.enabled, to: e.to, from: e.from, ...(e.apiKey !== undefined ? { apiKey: e.apiKey ?? '' } : {}) },
    });
    return r.ok ? okResponse(r.value) : errResponse('requisicao_invalida', Object.values(r.error).join(' '));
  }

  async function testEmail(): Promise<Response> {
    const s = (await d.settings.get()).email;
    if (!s.to || !s.from) return errResponse('requisicao_invalida', 'Informe destinatário e remetente e salve antes de testar.');
    if (s.mode === 'real' && (!s.apiKey || !(await d.hasMailPermission())))
      return errResponse('permissao_ausente', 'Modo real exige a chave do provedor e a permissão de acesso ao provedor.');
    const r = await d.sendTestEmail();
    if (r.kind === 'accepted') return okResponse({ accepted: true, simulated: r.simulated === true }); // aceito pelo provedor, nunca "entregue"
    return errResponse('falha_externa', `O provedor de e-mail não aceitou o envio${safeReason(r.reason)}.`);
  }

  async function dispatch(req: Request): Promise<Response> {
    switch (req.type) {
      case 'tab.inspect': return inspect(req.url);
      case 'alert.create': {
        const r = await d.alerts.create(req.variantCode, { target: req.target, ...(req.margin !== undefined ? { margin: req.margin } : {}) });
        return r.ok ? okResponse(r.value) : alertError(r.error);
      }
      case 'alert.update': return update(req);
      case 'alert.pause': case 'alert.resume': {
        const r = await (req.type === 'alert.pause' ? d.alerts.pause(req.id) : d.alerts.resume(req.id));
        return r.ok ? okResponse(null) : alertError(r.error);
      }
      case 'alert.delete':
        return (await d.alerts.delete(req.id)) ? okResponse(null) : errResponse('nao_encontrado', 'Monitoramento não encontrado.');
      case 'alerts.list': return list();
      case 'history.get': return history(req);
      case 'health.get': return health();
      case 'monitor.runNow': return okResponse(await d.runNow());
      case 'product.resume':
        return (await d.monitor.resumeProduct(req.code)) ? okResponse(null) : errResponse('nao_encontrado', 'Este produto não está pausado ou não foi encontrado.');
      case 'catalog.search': {
        const [items, refreshedAt] = await Promise.all([d.catalog.search(req.q, CATALOG_LIMIT), d.catalog.refreshedAt()]);
        return okResponse({ items: items.map((i) => ({ code: i.code, name: i.name, lastSlug: i.lastSlug, priceCents: i.priceCents })), refreshedAt });
      }
      case 'catalog.refresh': {
        const r = await d.catalog.refresh();
        return r.ok ? okResponse(r.value) : refreshError(r.error);
      }
      case 'settings.get': return okResponse(await d.settings.getPublic()); // só apiKeySet, nunca a chave
      case 'settings.set': return setSettings(req);
      case 'email.test': return testEmail();
      case 'notification.resend':
        return (await d.notifier.reenviar(req.key)) ? okResponse(null) : errResponse('nao_encontrado', 'Notificação não encontrada ou não está em falha.');
    }
  }

  async function handle(message: unknown, sender: { id?: string; url?: string } | undefined): Promise<Response> {
    if (!senderOk(sender)) return errResponse('remetente_invalido', SENDER_MSG);
    const p = parseRequest(message);
    if (!p.ok) return errResponse('requisicao_invalida', p.error);
    try {
      const resp = await dispatch(p.value);
      if (p.value.type.startsWith('settings.') || p.value.type === 'email.test') {
        // cinto e suspensórios: a chave nunca sai, nem por engano de um campo novo
        const key = (await d.settings.get()).email.apiKey;
        if (key !== '' && JSON.stringify(resp).includes(key)) return errResponse('interno', 'Erro interno. Tente novamente.');
      }
      return resp;
    } catch {
      d.log?.error('api_erro'); // só o evento: sem mensagem/stack (podem conter dados)
      return errResponse('interno', 'Erro interno. Tente novamente.');
    }
  }

  return { handle };
}
export type Api = ReturnType<typeof createApi>;

/**
 * Registra o listener de forma síncrona (chamar no topo do sw.ts). Remetente inválido é recusado
 * antes de compor qualquer serviço. `getApi` é preguiçoso (SW efêmero).
 */
export function registerApi(getApi: () => Promise<Api> | Api): void {
  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (!senderOk(sender)) {
      respond(errResponse('remetente_invalido', SENDER_MSG));
      return false;
    }
    Promise.resolve()
      .then(getApi)
      .then((a) => a.handle(msg, sender))
      .catch(() => errResponse('interno', 'Erro interno. Tente novamente.'))
      .then(respond);
    return true;
  });
}
