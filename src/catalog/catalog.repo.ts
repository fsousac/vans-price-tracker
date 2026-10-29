import { transaction, type Db } from '../db/connection.ts';
import type { IsoUtc } from '../shared/types.ts';
import type { CatalogItem, CatalogRepo } from './ports.ts';

// minúsculas sem acento (coluna name_search; data-model.md)
export const normalizeSearch = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

type Row = { code: string; name: string; last_slug: string | null; price_cents: number | null };

export class SqliteCatalogRepo implements CatalogRepo {
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  replaceAll(items: CatalogItem[], now: IsoUtc): void {
    const ins = this.#db.prepare(
      'INSERT INTO catalog_items (code, name, name_search, last_slug, price_cents, fetched_at) VALUES (?,?,?,?,?,?)',
    );
    transaction(this.#db, () => {
      this.#db.exec('DELETE FROM catalog_items');
      for (const i of items) ins.run(i.code, i.name, normalizeSearch(i.name), i.lastSlug, i.priceCents, now);
    });
  }

  search(q: string, limit: number): CatalogItem[] {
    const term = normalizeSearch(q.trim()).replace(/[\\%_]/g, '\\$&');
    const rows = this.#db
      .prepare(
        `SELECT code, name, last_slug, price_cents FROM catalog_items
         WHERE name_search LIKE ? ESCAPE '\\' ORDER BY name_search, code LIMIT ?`,
      )
      .all(`%${term}%`, limit) as Row[];
    return rows.map((r) => ({ code: r.code, name: r.name, lastSlug: r.last_slug, priceCents: r.price_cents }));
  }

  count(): number {
    return (this.#db.prepare('SELECT count(*) AS n FROM catalog_items').get() as { n: number }).n;
  }
}
