import { type Db, transaction } from '../db/connection.ts';
import type { BasisPoints, Cents, IsoUtc, SourceName } from '../shared/types.ts';
import type { NewNotification, NotificationKind, NotificationRepo, NotificationRow, NotificationStatus } from './ports.ts';

const LEASE_MS = 10 * 60_000; // lease em next_attempt_at enquanto o envio está em andamento
const MAX_ATTEMPTS = 4; // inicial + 3 retentativas (D-30)

interface Raw {
  id: number;
  alert_id: number | null;
  health_event_id: number | null;
  observation_id: number | null;
  kind: NotificationKind;
  idempotency_key: string;
  status: NotificationStatus;
  mode: 'real' | 'teste';
  simulated: number;
  attempts: number;
  next_attempt_at: string | null;
  provider_message_id: string | null;
  accepted_at: string | null;
  failure_reason: string | null;
  product_code: string | null;
  product_name: string | null;
  product_slug: string | null;
  size: string | null;
  price_cents: number | null;
  target_cents: number | null;
  margin_bp: number | null;
  observed_at: string | null;
  source: string | null;
  degraded: number;
  already_in_band: number;
  created_at: string;
  updated_at: string;
}

const toRow = (r: Raw): NotificationRow => ({
  id: r.id,
  alertId: r.alert_id,
  healthEventId: r.health_event_id,
  observationId: r.observation_id,
  kind: r.kind,
  idempotencyKey: r.idempotency_key,
  status: r.status,
  mode: r.mode,
  simulated: r.simulated === 1,
  attempts: r.attempts,
  nextAttemptAt: r.next_attempt_at as IsoUtc | null,
  providerMessageId: r.provider_message_id,
  acceptedAt: r.accepted_at as IsoUtc | null,
  failureReason: r.failure_reason,
  productCode: r.product_code,
  productName: r.product_name,
  productSlug: r.product_slug,
  size: r.size,
  priceCents: r.price_cents as Cents | null,
  targetCents: r.target_cents as Cents | null,
  marginBp: r.margin_bp as BasisPoints | null,
  observedAt: r.observed_at as IsoUtc | null,
  source: r.source as SourceName | null,
  degraded: r.degraded === 1,
  alreadyInBand: r.already_in_band === 1,
  createdAt: r.created_at as IsoUtc,
  updatedAt: r.updated_at as IsoUtc,
});

export class SqliteNotificationRepo implements NotificationRepo {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  insertIfAbsent(n: NewNotification): { id: number; created: boolean } {
    // ON CONFLICT sem alvo cobre as duas barreiras: idempotency_key e (alert, obs, kind)
    const info = this.db
      .prepare(
        `INSERT INTO notifications (alert_id, health_event_id, observation_id, kind, idempotency_key, mode,
           next_attempt_at, product_code, product_name, product_slug, size, price_cents, target_cents, margin_bp,
           observed_at, source, degraded, already_in_band, created_at, updated_at)
         VALUES (@alertId, @healthEventId, @observationId, @kind, @idempotencyKey, @mode,
           @now, @productCode, @productName, @productSlug, @size, @priceCents, @targetCents, @marginBp,
           @observedAt, @source, @degraded, @alreadyInBand, @now, @now)
         ON CONFLICT DO NOTHING`,
      )
      .run({ ...n, degraded: n.degraded ? 1 : 0, alreadyInBand: n.alreadyInBand ? 1 : 0 });
    if (info.changes === 1) return { id: Number(info.lastInsertRowid), created: true };
    const hit = this.db
      .prepare(
        `SELECT id FROM notifications WHERE idempotency_key = ?
         UNION ALL
         SELECT id FROM notifications WHERE alert_id = ? AND observation_id = ? AND kind = ?`,
      )
      .get(n.idempotencyKey, n.alertId, n.observationId, n.kind) as { id: number };
    return { id: hit.id, created: false };
  }

  claimDue(now: IsoUtc, limit: number): NotificationRow[] {
    return transaction(this.db, () => {
      // crash após o 4º claim deixaria a linha presa (attempts+1 violaria o CHECK): encerra
      this.db
        .prepare(
          `UPDATE notifications SET status = 'FALHA', failure_reason = 'tentativas_esgotadas', next_attempt_at = NULL, updated_at = ?
           WHERE status = 'PENDENTE' AND attempts >= ? AND next_attempt_at <= ?`,
        )
        .run(now, MAX_ATTEMPTS, now);
      const due = this.db
        .prepare(
          `SELECT n.id FROM notifications n LEFT JOIN price_alerts a ON a.id = n.alert_id
           WHERE n.status = 'PENDENTE' AND n.next_attempt_at <= ? AND (n.alert_id IS NULL OR a.status = 'ATIVO')
           ORDER BY n.next_attempt_at, n.id LIMIT ?`,
        )
        .all(now, limit) as { id: number }[];
      const lease = new Date(Date.parse(now) + LEASE_MS).toISOString();
      const bump = this.db.prepare(
        `UPDATE notifications SET attempts = attempts + 1, next_attempt_at = ?, updated_at = ? WHERE id = ?`,
      );
      const get = this.db.prepare(`SELECT * FROM notifications WHERE id = ?`);
      return due.map(({ id }) => {
        bump.run(lease, now, id);
        return toRow(get.get(id) as Raw);
      });
    });
  }

  markAccepted(id: number, r: { providerMessageId: string; now: IsoUtc; simulated: boolean }): void {
    this.db
      .prepare(
        `UPDATE notifications SET status = 'ACEITO', provider_message_id = ?, accepted_at = ?, simulated = ?,
           next_attempt_at = NULL, failure_reason = NULL, updated_at = ?
         WHERE id = ? AND status = 'PENDENTE'`,
      )
      .run(r.providerMessageId, r.now, r.simulated ? 1 : 0, r.now, id);
  }

  markAttemptFailed(id: number, r: { nextAttemptAt: IsoUtc | null; reason: string; now: IsoUtc }): void {
    const status = r.nextAttemptAt === null ? 'FALHA' : 'PENDENTE';
    this.db
      .prepare(
        `UPDATE notifications SET status = ?, next_attempt_at = ?, failure_reason = ?, updated_at = ?
         WHERE id = ? AND status = 'PENDENTE'`,
      )
      .run(status, r.nextAttemptAt, r.reason.slice(0, 200), r.now, id);
  }

  resend(id: number, now: IsoUtc): boolean {
    const info = this.db
      .prepare(
        `UPDATE notifications SET status = 'PENDENTE', attempts = 0, next_attempt_at = ?, failure_reason = NULL, updated_at = ?
         WHERE id = ? AND status = 'FALHA'`,
      )
      .run(now, now, id);
    return info.changes === 1;
  }

  listForAlert(alertId: number): NotificationRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM notifications WHERE alert_id = ? ORDER BY created_at DESC, id DESC`)
      .all(alertId) as Raw[];
    return rows.map(toRow);
  }
}
