import type { Db } from '../db/connection.ts';
import type { IsoUtc, ProductCode } from '../shared/types.ts';
import {
  type AlertPatch,
  type AlertRepo,
  type AlertRow,
  type AlertStatus,
  AlertDuplicate,
  type Decision,
  type NewAlert,
  VariantNotFound,
} from './ports.ts';

interface Raw {
  id: number;
  variant_code: string;
  target_cents: number;
  margin_bp: number;
  email: string;
  status: AlertStatus;
  paused_at: string | null;
  revision: number;
  episode_proximo: number;
  episode_atingido: number;
  armed_proximo: number;
  armed_atingido: number;
  last_sent_proximo_at: string | null;
  last_sent_atingido_at: string | null;
  rearm_not_before_proximo: string | null;
  rearm_not_before_atingido: string | null;
  evaluated_once: number;
  created_at: string;
  updated_at: string;
}

const COLS = `a.id, a.variant_code, a.target_cents, a.margin_bp, a.email, a.status, a.paused_at, a.revision,
  a.episode_proximo, a.episode_atingido, a.armed_proximo, a.armed_atingido, a.last_sent_proximo_at,
  a.last_sent_atingido_at, a.rearm_not_before_proximo, a.rearm_not_before_atingido, a.evaluated_once,
  a.created_at, a.updated_at`;

const toRow = (r: Raw): AlertRow => ({
  id: r.id,
  variantCode: r.variant_code,
  targetCents: r.target_cents,
  marginBp: r.margin_bp,
  email: r.email,
  status: r.status,
  pausedAt: r.paused_at,
  revision: r.revision,
  episodeProximo: r.episode_proximo,
  episodeAtingido: r.episode_atingido,
  armedProximo: r.armed_proximo === 1,
  armedAtingido: r.armed_atingido === 1,
  lastSentProximoAt: r.last_sent_proximo_at,
  lastSentAtingidoAt: r.last_sent_atingido_at,
  rearmNotBeforeProximo: r.rearm_not_before_proximo,
  rearmNotBeforeAtingido: r.rearm_not_before_atingido,
  evaluatedOnce: r.evaluated_once === 1,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const code = (e: unknown): string => (e as { code?: string }).code ?? '';

export function createAlertRepo(db: Db): AlertRepo {
  const get = (id: number): AlertRow | null => {
    const r = db.prepare(`SELECT ${COLS} FROM price_alerts a WHERE a.id = ?`).get(id) as Raw | undefined;
    return r ? toRow(r) : null;
  };

  return {
    create(a: NewAlert, now: IsoUtc): number {
      try {
        const info = db
          .prepare(
            `INSERT INTO price_alerts (variant_code, target_cents, margin_bp, email, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(a.variantCode, a.targetCents, a.marginBp, a.email, now, now);
        return Number(info.lastInsertRowid);
      } catch (e) {
        if (code(e) === 'SQLITE_CONSTRAINT_UNIQUE') throw new AlertDuplicate('alerta idêntico já existe');
        if (code(e) === 'SQLITE_CONSTRAINT_FOREIGNKEY') throw new VariantNotFound(a.variantCode);
        throw e;
      }
    },

    get,

    list: () => (db.prepare(`SELECT ${COLS} FROM price_alerts a ORDER BY a.id`).all() as Raw[]).map(toRow),

    activeByProduct: (p: ProductCode) =>
      (
        db
          .prepare(
            `SELECT ${COLS} FROM price_alerts a JOIN product_variants v ON v.variant_code = a.variant_code
             WHERE v.product_code = ? AND a.status = 'ATIVO' ORDER BY a.id`,
          )
          .all(p) as Raw[]
      ).map(toRow),

    update(id: number, patch: AlertPatch, now: IsoUtc): void {
      const cur = get(id);
      if (!cur) return;
      const target = patch.targetCents ?? cur.targetCents;
      const margin = patch.marginBp ?? cur.marginBp;
      const status = patch.status ?? cur.status;
      // RN-14: mudar alvo/margem reabre as duas travas e muda a revisão; só e-mail/status não.
      const reopen = target !== cur.targetCents || margin !== cur.marginBp;
      const pausedAt = status === 'PAUSADO' ? (cur.status === 'PAUSADO' ? cur.pausedAt : now) : null;
      try {
        db.prepare(
          `UPDATE price_alerts SET target_cents = ?, margin_bp = ?, email = ?, status = ?, paused_at = ?,
             revision = revision + ?, armed_proximo = CASE WHEN ? THEN 1 ELSE armed_proximo END,
             armed_atingido = CASE WHEN ? THEN 1 ELSE armed_atingido END,
             rearm_not_before_proximo = CASE WHEN ? THEN NULL ELSE rearm_not_before_proximo END,
             rearm_not_before_atingido = CASE WHEN ? THEN NULL ELSE rearm_not_before_atingido END,
             updated_at = ? WHERE id = ?`,
        ).run(target, margin, patch.email ?? cur.email, status, pausedAt, reopen ? 1 : 0, +reopen, +reopen, +reopen, +reopen, now, id);
      } catch (e) {
        if (code(e) === 'SQLITE_CONSTRAINT_UNIQUE') throw new AlertDuplicate('alerta idêntico já existe');
        throw e;
      }
    },

    applyDecision(id: number, next: Decision['next'], fire: Decision['fire'], now: IsoUtc): void {
      db.prepare(
        `UPDATE price_alerts SET armed_proximo = ?, armed_atingido = ?, episode_proximo = ?, episode_atingido = ?,
           rearm_not_before_proximo = ?, rearm_not_before_atingido = ?, evaluated_once = ?,
           last_sent_proximo_at = CASE WHEN ? THEN ? ELSE last_sent_proximo_at END,
           last_sent_atingido_at = CASE WHEN ? THEN ? ELSE last_sent_atingido_at END,
           updated_at = ? WHERE id = ?`,
      ).run(
        +next.armedProximo,
        +next.armedAtingido,
        next.episodeProximo,
        next.episodeAtingido,
        next.rearmNotBeforeProximo,
        next.rearmNotBeforeAtingido,
        +next.evaluatedOnce,
        +(fire?.kind === 'PROXIMO'),
        now,
        +(fire?.kind === 'ATINGIDO'),
        now,
        now,
        id,
      );
    },

    delete(id: number): void {
      db.prepare('DELETE FROM price_alerts WHERE id = ?').run(id); // cascade em notifications
    },
  };
}
