import type { Logger } from '../observability/logger.ts';
import type { Clock } from '../shared/clock.ts';
import type { IsoUtc } from '../shared/types.ts';
import type { Settings } from '../settings/settings.ts';
import { DryRunMailer } from '../notifications/mailer.dry.ts';
import type { Notifier } from '../notifications/notifier.ts';
import type { Mailer, MailResult } from '../notifications/ports.ts';
import { renderEmail } from '../notifications/render.ts';
import type { AlertRepo, NotificationRepo, NotificationRow } from '../store/ports.ts';

const BACKOFF_MS = [5 * 60_000, 30 * 60_000, 2 * 3_600_000]; // após a 1ª, 2ª e 3ª tentativa (D-30)
const MAX_ATTEMPTS = 4; // espelha o store (claimDue encerra a partir daqui)
const BATCH = 10;
const HOURLY_CAP = 20;
const HOUR_MS = 3_600_000;
const PAUSE_LIMIT_MS = 24 * HOUR_MS;
const DESKTOP_BATCH = 20;

export interface NotificationDeps {
  repo: NotificationRepo;
  alerts: AlertRepo;
  notifier: Notifier;
  settings: { get(): Promise<Settings> };
  /** Mailer do modo real (ResendMailer sobre fetch); o modo teste usa DryRunMailer, sem rede. */
  realMailer(s: Settings['email']): Mailer;
  /** true se a permissão opcional de host do provedor está concedida (chrome.permissions.contains). */
  hasMailPermission(): Promise<boolean>;
  /** Porta do alarme `outbox`: when = null remove. */
  schedule(name: 'outbox', when: IsoUtc | null): Promise<void>;
  clock: Clock;
  log: Logger;
}

export interface NotificationService {
  /** Desktop imediato, depois e-mail vencido; reagenda o alarme `outbox`. Nunca lança por falha de canal. */
  drain(): Promise<{ desktop: number; email: number }>;
  /** FALHA -> PENDENTE (tentativas zeradas) e envia já; false se a chave não está em FALHA. */
  reenviar(key: string): Promise<boolean>;
}

export function createNotificationService(d: NotificationDeps): NotificationService {
  const { repo, alerts, clock, log } = d;
  const dry = new DryRunMailer();
  // ponytail: teto em memória (SW morto zera a janela); persistir em kv se virar problema.
  let sentAt: number[] = [];
  const iso = () => clock.now().toISOString() as IsoUtc;
  const lg = (r: NotificationRow) => (r.alertId != null ? { alert_id: r.alertId } : {});

  async function desktop(): Promise<number> {
    const rows = await repo.listPendingDesktop(DESKTOP_BATCH);
    for (const r of rows) {
      let s: 'mostrada' | 'falha';
      try { s = await d.notifier.show(r); } catch { s = 'falha'; }
      await repo.markDesktop(r.key, s, s === 'falha' ? 'desktop_falha' : null, iso());
      if (s === 'falha') log.warn('desktop_falha', lg(r));
    }
    return rows.length;
  }

  // Pausa > 24 h descarta e-mails PENDENTE do alerta (RN-15).
  async function discardLongPaused(nowMs: number): Promise<void> {
    for (const a of await alerts.list()) {
      if (a.status !== 'PAUSADO' || !a.pausedAt || nowMs - Date.parse(a.pausedAt) <= PAUSE_LIMIT_MS) continue;
      for (const n of await repo.listForAlert(a.id)) {
        if (n.email === 'PENDENTE') await repo.markAttemptFailed(n.key, { nextAttemptAt: null, reason: 'alerta_pausado', now: iso() });
      }
    }
  }

  async function send(row: NotificationRow, s: Settings): Promise<void> {
    const fail = async (reason: string, permanent: boolean): Promise<void> => {
      const now = iso();
      const retry = !permanent && row.attempts < MAX_ATTEMPTS;
      const next = retry ? (new Date(Date.parse(now) + BACKOFF_MS[row.attempts - 1]!).toISOString() as IsoUtc) : null;
      await repo.markAttemptFailed(row.key, { nextAttemptAt: next, reason, now });
      log.warn(retry ? 'email_retentativa' : 'email_falha', lg(row));
    };
    const e = s.email;
    if (!e.to) return fail('sem_destinatario', true);
    let mailer: Mailer = dry;
    if (e.mode === 'real') {
      if (!e.apiKey || !e.from) return fail('configuracao_incompleta', true);
      if (!(await d.hasMailPermission())) return fail('permissao_ausente', true);
      mailer = d.realMailer(e);
    }
    sentAt.push(clock.now().getTime());
    let res: MailResult;
    try {
      res = await mailer.send(renderEmail({ ...row, idempotencyKey: row.key }, e.to));
    } catch {
      res = { kind: 'temporary_error', reason: 'excecao_no_envio' };
    }
    if (res.kind === 'accepted') {
      await repo.markAccepted(row.key, { providerMessageId: res.providerMessageId, now: iso(), simulated: mailer.mode === 'teste' });
      log.info('email_aceito', lg(row));
    } else await fail(res.reason, res.kind === 'permanent_error');
  }

  async function email(): Promise<number> {
    const s = await d.settings.get();
    if (!s.email.enabled) return 0;
    const nowMs = clock.now().getTime();
    await discardLongPaused(nowMs);
    sentAt = sentAt.filter((t) => nowMs - t < HOUR_MS);
    const room = Math.min(BATCH, HOURLY_CAP - sentAt.length);
    if (room <= 0) return 0; // excedente fica PENDENTE
    const rows = await repo.claimDue(iso(), room);
    for (const r of rows) await send(r, s);
    return rows.length;
  }

  async function reschedule(): Promise<void> {
    const next = await repo.nextAttemptAt();
    if (!next) return d.schedule('outbox', null);
    const nowMs = clock.now().getTime();
    let at = Date.parse(next);
    // vencido mas retido (teto/horário): espera a janela do teto liberar, no mínimo 1 min
    if (at <= nowMs) at = sentAt.length >= HOURLY_CAP ? Math.min(...sentAt) + HOUR_MS : nowMs + 60_000;
    await d.schedule('outbox', new Date(at).toISOString() as IsoUtc);
  }

  return {
    async drain() {
      const dk = await desktop(); // falha de desktop nunca bloqueia o e-mail
      const em = await email();
      await reschedule();
      return { desktop: dk, email: em };
    },
    async reenviar(key) {
      const ok = await repo.resend(key, iso());
      if (ok) await this.drain();
      return ok;
    },
  };
}
