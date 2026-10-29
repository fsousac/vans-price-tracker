// Db em memória (testes em Node): mesma semântica de ordem/unicidade/abort do IndexedDB.
import {
  ConstraintError, VersionError, ambientTx, compareKeys, inRange, keyAt,
  type Db, type Key, type QueryOpts,
} from './db.ts';
import { MIGRATIONS, type Migration, type Migrator } from './schema.ts';

type KeyPath = string | string[];
interface Row { k: Key; v: unknown }
interface Store {
  keyPath: KeyPath;
  autoIncrement: boolean;
  nextId: number;
  indexes: Record<string, { keyPath: KeyPath; unique: boolean }>;
  rows: Map<string, Row>;
}
export interface MemState { version: number; stores: Record<string, Store> }

const enc = (k: Key): string => JSON.stringify(k);
const clone = <T>(v: T): T => structuredClone(v);

export interface MemoryDb extends Db {
  /** Cópia do estado (inclui version) para reabrir com `createMemoryDb({ state })`. */
  dump(): MemState;
}

export function createMemoryDb(opts: { state?: MemState; migrations?: readonly Migration[] } = {}): MemoryDb {
  const migrations = opts.migrations ?? MIGRATIONS;
  // Migra sobre cópia: falha no upgrade não altera o estado de origem.
  let state: MemState = opts.state ? clone(opts.state) : { version: 0, stores: {} };
  if (state.version > migrations.length) {
    throw new VersionError(`base v${state.version} é mais nova que o código v${migrations.length}`);
  }
  for (let n = state.version; n < migrations.length; n++) migrations[n]!(migrator(state));
  state.version = migrations.length;

  const store = (name: string): Store => {
    const s = state.stores[name];
    if (!s) throw new Error(`store inexistente: ${name}`);
    return s;
  };

  function entries(name: string, o: QueryOpts = {}) {
    const s = store(name);
    const def = o.index ? s.indexes[o.index] : undefined;
    if (o.index && !def) throw new Error(`índice inexistente: ${name}.${o.index}`);
    let list: { ik: Key; pk: Key; v: unknown }[] = [];
    for (const r of s.rows.values()) {
      const ik = def ? keyAt(r.v, def.keyPath) : r.k;
      if (ik !== undefined && inRange(ik, o.range)) list.push({ ik, pk: r.k, v: r.v });
    }
    // ponytail: ordena a cada consulta (O(n log n)); é só dublê de teste, IndexedDB real usa B-tree.
    list.sort((a, b) => compareKeys(a.ik, b.ik) || compareKeys(a.pk, b.pk));
    if (o.direction === 'prev') list.reverse();
    return o.limit === undefined ? list : list.slice(0, o.limit);
  }

  function write(name: string, value: unknown, isAdd: boolean): Key {
    const s = store(name);
    const v = clone(value) as Record<string, unknown>;
    let k = keyAt(v, s.keyPath);
    let auto = false;
    if (k === undefined) {
      if (!s.autoIncrement || typeof s.keyPath !== 'string') throw new Error('DataError: chave ausente');
      k = s.nextId;
      auto = true;
    }
    const e = enc(k);
    if (isAdd && s.rows.has(e)) throw new ConstraintError(`${name}: chave duplicada`);
    for (const [iname, def] of Object.entries(s.indexes)) {
      if (!def.unique) continue;
      const ik = keyAt(auto ? { ...v, [s.keyPath as string]: k } : v, def.keyPath);
      if (ik === undefined) continue;
      for (const r of s.rows.values()) {
        const rk = keyAt(r.v, def.keyPath);
        if (rk !== undefined && compareKeys(rk, ik) === 0 && enc(r.k) !== e) {
          throw new ConstraintError(`${name}.${iname}: valor duplicado`);
        }
      }
    }
    if (auto) v[s.keyPath as string] = k;
    if (typeof k === 'number' && k >= s.nextId) s.nextId = Math.floor(k) + 1;
    s.rows.set(e, { k, v });
    return k;
  }

  let snap: MemState | undefined;
  const tx = ambientTx({
    begin: () => { snap = clone(state); },
    commit: () => { snap = undefined; },
    rollback: () => { if (snap) state = snap; snap = undefined; },
  });

  return {
    get: async (name, key) => {
      const r = store(name).rows.get(enc(key));
      return r ? (clone(r.v) as never) : undefined;
    },
    add: async (name, value) => write(name, value, true),
    put: async (name, value) => write(name, value, false),
    delete: async (name, key) => { store(name).rows.delete(enc(key)); },
    getAll: async (name, o) => entries(name, o).map((e) => clone(e.v)) as never,
    count: async (name, o) => entries(name, o).length,
    clear: async (name) => { store(name).rows.clear(); },
    tx,
    dump: () => clone(state),
  };
}

function migrator(state: MemState): Migrator {
  const get = (n: string) => {
    const s = state.stores[n];
    if (!s) throw new Error(`store inexistente: ${n}`);
    return s;
  };
  return {
    createStore: (name, o) => {
      if (state.stores[name]) throw new Error(`store já existe: ${name}`);
      state.stores[name] = { keyPath: o.keyPath, autoIncrement: !!o.autoIncrement, nextId: 1, indexes: {}, rows: new Map() };
    },
    createIndex: (name, iname, keyPath, o) => {
      const s = get(name);
      if (o?.unique) {
        const seen = new Set<string>();
        for (const r of s.rows.values()) {
          const ik = keyAt(r.v, keyPath);
          if (ik === undefined) continue;
          if (seen.has(enc(ik))) throw new ConstraintError(`${name}.${iname}: dados existentes violam unicidade`);
          seen.add(enc(ik));
        }
      }
      s.indexes[iname] = { keyPath, unique: !!o?.unique };
    },
    deleteStore: (name) => { get(name); delete state.stores[name]; },
    forEach: (name, fn) => {
      for (const r of get(name).rows.values()) {
        const nv = fn(clone(r.v));
        if (nv !== undefined) r.v = clone(nv);
      }
    },
  };
}
