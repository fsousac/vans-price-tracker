import type { Db } from '../db/connection.ts';
import type { VariantCode } from '../shared/types.ts';
import type { NewObservation, ObservationRepo, ObservationRow } from './ports.ts';

const COLS = `id, variant_code AS variantCode, run_id AS runId, seq, observed_at AS observedAt,
  original_cents AS originalCents, current_cents AS currentCents, available, confirmed, degraded, source,
  confirmed_by AS confirmedBy`;

type Raw = Omit<ObservationRow, 'available' | 'confirmed' | 'degraded'> & { available: number; confirmed: number; degraded: number };
const toRow = (r: Raw): ObservationRow => ({ ...r, available: r.available === 1, confirmed: r.confirmed === 1, degraded: r.degraded === 1 });

export class SqliteObservationRepo implements ObservationRepo {
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  // lança em UNIQUE(run_id,variant_code,seq) e nos CHECKs (current_cents > 0 etc.)
  insert(o: NewObservation): number {
    const r = this.#db
      .prepare(
        `INSERT INTO price_observations (variant_code, run_id, seq, observed_at, original_cents, current_cents, available, confirmed, degraded, source)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(o.variantCode, o.runId, o.seq, o.observedAt, o.originalCents, o.currentCents, +o.available, +o.confirmed, +o.degraded, o.source);
    return Number(r.lastInsertRowid);
  }

  // único UPDATE permitido na tabela (RN-09c)
  confirm(id: number, confirmedBy: number): void {
    this.#db.prepare('UPDATE price_observations SET confirmed = 1, confirmed_by = ? WHERE id = ?').run(confirmedBy, id);
  }

  latestConfirmed(v: VariantCode): ObservationRow | null {
    return this.#latest(v, 1);
  }

  latestUnconfirmed(v: VariantCode): ObservationRow | null {
    return this.#latest(v, 0);
  }

  history(v: VariantCode, limit: number, offset: number): ObservationRow[] {
    const rows = this.#db
      .prepare(`SELECT ${COLS} FROM price_observations WHERE variant_code = ? ORDER BY observed_at DESC, seq DESC, id DESC LIMIT ? OFFSET ?`)
      .all(v, limit, offset) as Raw[];
    return rows.map(toRow);
  }

  stats(v: VariantCode): { minCents: number; maxCents: number; count: number } | null {
    const r = this.#db
      .prepare('SELECT MIN(current_cents) AS minCents, MAX(current_cents) AS maxCents, COUNT(*) AS count FROM price_observations WHERE variant_code = ? AND confirmed = 1')
      .get(v) as { minCents: number | null; maxCents: number | null; count: number };
    return r.count === 0 ? null : { minCents: r.minCents!, maxCents: r.maxCents!, count: r.count };
  }

  #latest(v: VariantCode, confirmed: 0 | 1): ObservationRow | null {
    const r = this.#db
      .prepare(`SELECT ${COLS} FROM price_observations WHERE variant_code = ? AND confirmed = ? ORDER BY observed_at DESC, seq DESC, id DESC LIMIT 1`)
      .get(v, confirmed) as Raw | undefined;
    return r ? toRow(r) : null;
  }
}
