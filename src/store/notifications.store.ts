import type { Db } from './db.ts';
import type { IsoUtc } from '../shared/types.ts';
import type { NewNotification, NotificationRepo, NotificationRow } from './ports.ts';

const LEASE_MS = 10 * 60_000; // lease em nextAttemptAt durante o envio
const MAX_ATTEMPTS = 4; // inicial + 3 retentativas (D-30)
const S = 'notifications';

// Registro gravado: NotificationRow + emailStatus (campo do índice 'due'; a porta expõe `email`).
type Stored = NotificationRow & { emailStatus: NotificationRow['email'] };
const toRow = ({ emailStatus: _, ...r }: Stored): NotificationRow => r;
const stamp = (r: NotificationRow, email: NotificationRow['email']): Stored => ({ ...r, email, emailStatus: email });

export class IdbNotificationRepo implements NotificationRepo {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  async get(key: string): Promise<NotificationRow | null> {
    const r = await this.db.get<Stored>(S, key);
    return r ? toRow(r) : null;
  }

  insertIfAbsent(n: NewNotification): Promise<{ created: boolean }> {
    return this.db.tx(async () => {
      if (await this.db.get(S, n.key)) return { created: false };
      const { now, emailEnabled, ...rest } = n;
      await this.db.add(
        S,
        stamp(
          {
            ...rest, desktop: 'pendente', email: 'desligado', simulated: false, attempts: 0,
            nextAttemptAt: emailEnabled ? now : null, providerMessageId: null, acceptedAt: null,
            failureReason: null, createdAt: now, updatedAt: now,
          },
          emailEnabled ? 'PENDENTE' : 'desligado',
        ),
      );
      return { created: true };
    });
  }

  async listPendingDesktop(limit: number): Promise<NotificationRow[]> {
    // ponytail: varre o store (pequeno, some com o alerta); índice por desktop se crescer.
    const all = await this.db.getAll<Stored>(S);
    return all
      .filter((r) => r.desktop === 'pendente')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || (a.key < b.key ? -1 : 1))
      .slice(0, limit)
      .map(toRow);
  }

  async markDesktop(key: string, s: 'mostrada' | 'falha', reason: string | null, now: IsoUtc): Promise<void> {
    await this.mutate(key, (r) =>
      r.desktop === 'pendente'
        ? { ...r, desktop: s, failureReason: s === 'falha' ? (reason ?? 'desktop_falha').slice(0, 200) : r.failureReason, updatedAt: now }
        : null,
    );
  }

  claimDue(now: IsoUtc, limit: number): Promise<NotificationRow[]> {
    return this.db.tx(async () => {
      const due = await this.db.getAll<Stored>(S, {
        index: 'due',
        range: { gte: ['PENDENTE', ''], lte: ['PENDENTE', now] },
      });
      const lease = new Date(Date.parse(now) + LEASE_MS).toISOString() as IsoUtc;
      const out: NotificationRow[] = [];
      for (const r of due) {
        if (out.length >= limit) break;
        if (r.attempts >= MAX_ATTEMPTS) {
          // lease vencido após a última tentativa (crash): encerra em vez de reenviar
          await this.db.put(S, stamp({ ...r, failureReason: 'tentativas_esgotadas', nextAttemptAt: null, updatedAt: now }, 'FALHA'));
          continue;
        }
        if (r.alertId !== null) {
          // alerta pausado/excluído não envia (RN-15)
          const a = await this.db.get<{ status: string }>('alerts', r.alertId);
          if (a?.status !== 'ATIVO') continue;
        }
        const next: Stored = { ...r, attempts: r.attempts + 1, nextAttemptAt: lease, updatedAt: now };
        await this.db.put(S, next);
        out.push(toRow(next));
      }
      return out;
    });
  }

  async markAccepted(key: string, r: { providerMessageId: string; now: IsoUtc; simulated: boolean }): Promise<void> {
    await this.mutate(key, (x) =>
      x.email === 'PENDENTE'
        ? stamp({ ...x, providerMessageId: r.providerMessageId, acceptedAt: r.now, simulated: r.simulated, nextAttemptAt: null, failureReason: null, updatedAt: r.now }, 'ACEITO')
        : null,
    );
  }

  async markAttemptFailed(key: string, r: { nextAttemptAt: IsoUtc | null; reason: string; now: IsoUtc }): Promise<void> {
    await this.mutate(key, (x) =>
      x.email === 'PENDENTE'
        ? stamp({ ...x, nextAttemptAt: r.nextAttemptAt, failureReason: r.reason.slice(0, 200), updatedAt: r.now }, r.nextAttemptAt === null ? 'FALHA' : 'PENDENTE')
        : null,
    );
  }

  resend(key: string, now: IsoUtc): Promise<boolean> {
    return this.mutate(key, (x) =>
      x.email === 'FALHA' ? stamp({ ...x, attempts: 0, nextAttemptAt: now, failureReason: null, updatedAt: now }, 'PENDENTE') : null,
    );
  }

  async listForAlert(alertId: number): Promise<NotificationRow[]> {
    const rows = await this.db.getAll<Stored>(S, { index: 'alertId', range: { eq: alertId } });
    return rows.map(toRow).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || (a.key < b.key ? 1 : -1));
  }

  async nextAttemptAt(): Promise<IsoUtc | null> {
    const [r] = await this.db.getAll<Stored>(S, { index: 'due', range: { gte: ['PENDENTE', ''], lt: ['PENDENTE', []] }, limit: 1 });
    return r?.nextAttemptAt ?? null;
  }

  /** Lê-modifica-grava em tx; chave ausente ou transição inválida = no-op (false). */
  private mutate(key: string, f: (r: Stored) => Stored | null): Promise<boolean> {
    return this.db.tx(async () => {
      const r = await this.db.get<Stored>(S, key);
      const n = r && f(r);
      if (n) await this.db.put(S, n);
      return !!n;
    });
  }
}
