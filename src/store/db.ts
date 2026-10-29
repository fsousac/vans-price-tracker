// Porta Db (extension-architecture 7.2). Sem dependência de IndexedDB: memory.ts e idb.ts a implementam.
export type Key = number | string | readonly Key[];

// Intervalo de chaves (da chave primária ou do índice). `eq` equivale a gte=lte.
export interface KeyRange {
  eq?: Key;
  gt?: Key;
  gte?: Key;
  lt?: Key;
  lte?: Key;
}

export interface QueryOpts {
  index?: string;
  range?: KeyRange;
  direction?: 'next' | 'prev';
  limit?: number;
}

export interface Db {
  get<T = unknown>(store: string, key: Key): Promise<T | undefined>;
  /** Rejeita ConstraintError se a chave primária ou um índice único já existir. */
  add(store: string, value: unknown): Promise<Key>;
  put(store: string, value: unknown): Promise<Key>;
  delete(store: string, key: Key): Promise<void>;
  getAll<T = unknown>(store: string, opts?: QueryOpts): Promise<T[]>;
  count(store: string, opts?: Pick<QueryOpts, 'index' | 'range'>): Promise<number>;
  clear(store: string): Promise<void>;
  /**
   * Transação ambiente e exclusiva: dentro de `fn`, as chamadas da Db usam a transação corrente;
   * `fn` rejeitar = rollback total. Dentro só se aguardam operações da Db e cálculo puro
   * (nunca fetch/sleep/chrome.*). Aninhada = reaproveita a corrente.
   */
  tx<T>(fn: () => Promise<T>): Promise<T>;
}

export class ConstraintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConstraintError';
  }
}

export class VersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VersionError';
  }
}

// Intervalo "todas as chaves que começam com `parts`" para índices compostos (array > string/número).
export function prefixRange(...parts: Key[]): KeyRange {
  return { gte: parts, lt: [...parts, []] };
}

// ---- utilitários puros compartilhados (ordem de chaves igual à do IndexedDB: número < string < array)

const rank = (k: Key): number => (typeof k === 'number' ? 0 : typeof k === 'string' ? 1 : 2);

export function compareKeys(a: Key, b: Key): number {
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra < rb ? -1 : 1;
  if (typeof a === 'number' || typeof a === 'string') return a < (b as typeof a) ? -1 : a > (b as typeof a) ? 1 : 0;
  const bb = b as readonly Key[];
  const n = Math.min(a.length, bb.length);
  for (let i = 0; i < n; i++) {
    const c = compareKeys(a[i] as Key, bb[i] as Key);
    if (c) return c;
  }
  return a.length - bb.length;
}

export function isKey(k: unknown): k is Key {
  if (typeof k === 'number') return !Number.isNaN(k);
  if (typeof k === 'string') return true;
  return Array.isArray(k) && k.every(isKey);
}

const at = (v: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((o, p) => (o != null && typeof o === 'object' ? (o as Record<string, unknown>)[p] : undefined), v);

/** Chave de `value` por keyPath (string com pontos ou array); undefined se ausente/inválida (não indexa). */
export function keyAt(value: unknown, keyPath: string | readonly string[]): Key | undefined {
  const k = typeof keyPath === 'string' ? at(value, keyPath) : keyPath.map((p) => at(value, p));
  return isKey(k) ? k : undefined;
}

export function inRange(k: Key, r?: KeyRange): boolean {
  if (!r) return true;
  const lo = r.eq ?? r.gte;
  const hi = r.eq ?? r.lte;
  if (lo !== undefined && compareKeys(k, lo) < 0) return false;
  if (hi !== undefined && compareKeys(k, hi) > 0) return false;
  if (r.gt !== undefined && compareKeys(k, r.gt) <= 0) return false;
  if (r.lt !== undefined && compareKeys(k, r.lt) >= 0) return false;
  return true;
}

/** Exclusão mútua + escopo ambiente de `tx`. Hooks por implementação. */
export function ambientTx(hooks: { begin(): void | Promise<void>; commit(): void | Promise<void>; rollback(): void }) {
  let active = false;
  let chain: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    if (active) return fn(); // aninhada
    const p = chain.then(async () => {
      active = true;
      try {
        await hooks.begin();
        const r = await fn();
        await hooks.commit();
        return r;
      } catch (e) {
        hooks.rollback();
        throw e;
      } finally {
        active = false;
      }
    });
    chain = p.catch(() => {});
    return p;
  };
}
// ponytail: chamadas fora de `tx` feitas durante uma `tx` ativa entram nela (sem AsyncLocalStorage no navegador);
// a regra de uso (7.2) proíbe. Upgrade: token por chamada se isso virar problema.
