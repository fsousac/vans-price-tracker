import type { Db } from './db.ts';
import type { CatalogItem, CatalogRepo } from './ports.ts';
import type { IsoUtc } from '../shared/types.ts';

// Catálogo por geração (extension-architecture 7.3). O store `catalog` tem chave `code`; para duas gerações
// coexistirem a chave física é `${gen}|${code}` e o código real fica em `itemCode`.
interface Row extends CatalogItem { code: string; itemCode: string; gen: number; nameSearch: string }
interface Kv { key: string; value: string }
export interface CatalogCursor { gen: number; page: number }

export const normalizeSearch = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

export interface CatalogStore extends CatalogRepo {
  /** Nova geração (maior existente + 1), descarta restos de tentativas abandonadas e zera o cursor. */
  begin(): Promise<number>;
  getCursor(): Promise<CatalogCursor | null>;
  setCursor(c: CatalogCursor): Promise<void>;
  refreshedAt(): Promise<IsoUtc | null>;
}

export function createCatalogStore(db: Db): CatalogStore {
  const kvGet = async (key: string) => (await db.get<Kv>('kv', key))?.value ?? null;
  const kvSet = (key: string, value: string) => db.put('kv', { key, value });
  const visibleGen = async (): Promise<number | null> => {
    const v = await kvGet('catalog_gen');
    return v === null ? null : Number(v);
  };
  const dropWhere = async (drop: (gen: number) => boolean) => {
    for (const r of await db.getAll<Row>('catalog')) if (drop(r.gen)) await db.delete('catalog', r.code);
  };

  return {
    async begin() {
      return db.tx(async () => {
        const vis = await visibleGen();
        const top = await db.getAll<Row>('catalog', { index: 'gen', direction: 'prev', limit: 1 });
        const gen = Math.max(vis ?? 0, top[0]?.gen ?? 0) + 1;
        await dropWhere((g) => g !== vis);
        await kvSet('catalog_cursor', JSON.stringify({ gen, page: 0 }));
        return gen;
      });
    },
    async putPage(gen, items) {
      await db.tx(async () => {
        for (const i of items) {
          const row: Row = { ...i, code: `${gen}|${i.code}`, itemCode: i.code, gen, nameSearch: normalizeSearch(i.name) };
          await db.put('catalog', row);
        }
      });
    },
    async commitGen(gen, now) {
      await db.tx(async () => {
        await kvSet('catalog_gen', String(gen));
        await kvSet('catalog_refreshed_at', now);
        await dropWhere((g) => g !== gen);
        await db.delete('kv', 'catalog_cursor');
      });
    },
    async search(q, limit) {
      const vis = await visibleGen();
      if (vis === null) return [];
      const term = normalizeSearch(q.trim());
      // ponytail: varre a geração inteira (centenas de itens); índice por prefixo se passar de milhares.
      const rows = await db.getAll<Row>('catalog', { index: 'gen', range: { eq: vis } });
      return rows
        .filter((r) => r.nameSearch.includes(term))
        .sort((a, b) => (a.nameSearch < b.nameSearch ? -1 : a.nameSearch > b.nameSearch ? 1 : a.itemCode < b.itemCode ? -1 : 1))
        .slice(0, limit)
        .map((r) => ({ code: r.itemCode, name: r.name, lastSlug: r.lastSlug, priceCents: r.priceCents }));
    },
    async count() {
      const vis = await visibleGen();
      return vis === null ? 0 : db.count('catalog', { index: 'gen', range: { eq: vis } });
    },
    async getCursor() {
      const v = await kvGet('catalog_cursor');
      return v === null ? null : (JSON.parse(v) as CatalogCursor);
    },
    async setCursor(c) {
      await kvSet('catalog_cursor', JSON.stringify(c));
    },
    refreshedAt: async () => (await kvGet('catalog_refreshed_at')) as IsoUtc | null,
  };
}
