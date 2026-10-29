import type { AlertRepo } from '../alerts/ports.ts';
import type { Logger } from '../observability/logger.ts';
import type { Clock } from '../shared/clock.ts';
import { sha256Hex } from '../shared/hash.ts';
import type { Mailer, NewNotification, NotificationRepo, NotificationRow } from './ports.ts';
import { renderEmail } from './render.ts';

const BACKOFF_MS = [5 * 60_000, 30 * 60_000, 2 * 3_600_000]; // após a 1ª, 2ª e 3ª tentativa (D-30)
const MAX_ATTEMPTS = 4;
const BATCH = 10;
const HOURLY_CAP = 20; // S14
const HOUR_MS = 3_600_000;
const PAUSE_LIMIT_MS = 24 * HOUR_MS;

export type EnqueueInput = Omit<NewNotification, 'idempotencyKey' | 'mode' | 'now'> & {
  revision?: number; // preço: obrigatório
  episode?: number; // preço: obrigatório
};

export interface NotificationDeps {
  repo: NotificationRepo;
  alerts: AlertRepo;
  mailer: Mailer;
  clock: Clock;
  log: Logger;
  ownerEmail: string | null;
}

export class NotificationService {
  readonly #d: NotificationDeps;
  // ponytail: teto em memória (reinício zera a janela); persistir se virar exposição pública
  #sentAt: number[] = [];

  constructor(deps: NotificationDeps) {
    this.#d = deps;
  }

  #now(): string {
    return this.#d.clock.now().toISOString();
  }

  // Chamado pelo monitor dentro da sua transação. SAUDE sem OWNER_EMAIL não é criada (null).
  enqueue(n: EnqueueInput): { id: number; created: boolean } | null {
    const { revision, episode, ...snap } = n;
    let key: string;
    if (n.kind === 'SAUDE') {
      if (!this.#d.ownerEmail || n.healthEventId == null) return null;
      key = sha256Hex(`saude|${n.healthEventId}`);
    } else {
      if (n.alertId == null || revision == null || episode == null) throw new Error('enqueue de preço exige alertId, revision e episode');
      key = sha256Hex(`${n.alertId}|${revision}|${n.kind}|${episode}`);
    }
    return this.#d.repo.insertIfAbsent({ ...snap, idempotencyKey: key, mode: this.#d.mailer.mode, now: this.#now() });
  }

  reenviar(id: number): boolean {
    return this.#d.repo.resend(id, this.#now());
  }

  // Processa o que está vencido; devolve quantas linhas tentou enviar.
  async drain(): Promise<number> {
    const nowMs = this.#d.clock.now().getTime();
    const now = new Date(nowMs).toISOString();
    this.#discardLongPaused(nowMs, now);
    this.#sentAt = this.#sentAt.filter((t) => nowMs - t < HOUR_MS);
    const room = Math.min(BATCH, HOURLY_CAP - this.#sentAt.length);
    if (room <= 0) return 0; // excedente fica PENDENTE
    const rows = this.#d.repo.claimDue(now, room);
    for (const row of rows) await this.#send(row);
    return rows.length;
  }

  #discardLongPaused(nowMs: number, now: string): void {
    for (const a of this.#d.alerts.list()) {
      if (a.status !== 'PAUSADO' || !a.pausedAt || nowMs - Date.parse(a.pausedAt) <= PAUSE_LIMIT_MS) continue;
      for (const n of this.#d.repo.listForAlert(a.id)) {
        if (n.status === 'PENDENTE') this.#d.repo.markAttemptFailed(n.id, { nextAttemptAt: null, reason: 'alerta_pausado', now });
      }
    }
  }

  async #send(row: NotificationRow): Promise<void> {
    const { repo, mailer, log } = this.#d;
    const fail = (reason: string, permanent: boolean): void => {
      const now = this.#now();
      const retry = !permanent && row.attempts < MAX_ATTEMPTS;
      const next = retry ? new Date(Date.parse(now) + BACKOFF_MS[row.attempts - 1]!).toISOString() : null;
      repo.markAttemptFailed(row.id, { nextAttemptAt: next, reason, now });
      log.warn(retry ? 'email_retentativa' : 'email_falha', row.alertId != null ? { alert_id: row.alertId } : {});
    };
    const to = row.kind === 'SAUDE' ? this.#d.ownerEmail : (row.alertId != null ? this.#d.alerts.get(row.alertId)?.email : null);
    if (!to) return fail('sem_destinatario', true);

    this.#sentAt.push(this.#d.clock.now().getTime());
    let res;
    try {
      res = await mailer.send(renderEmail(row, to));
    } catch {
      res = { kind: 'temporary_error' as const, reason: 'excecao_no_envio' };
    }
    if (res.kind === 'accepted') {
      repo.markAccepted(row.id, { providerMessageId: res.providerMessageId, now: this.#now(), simulated: mailer.mode === 'teste' });
      log.info('email_aceito', row.alertId != null ? { alert_id: row.alertId } : {});
    } else fail(res.reason, res.kind === 'permanent_error');
  }
}
