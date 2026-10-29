// Adaptador fino de IndexedDB (navegador / service worker). Testado pelo db-contract no selftest.html.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { ConstraintError, ambientTx, type Db, type KeyRange, type QueryOpts } from './db.ts';
import { MIGRATIONS, type Migration, type Migrator } from './schema.ts';

type IdbApi = { indexedDB: any; IDBKeyRange: any };

const mapErr = (e: any): unknown => (e?.name === 'ConstraintError' ? new ConstraintError(e.message ?? 'ConstraintError') : e);

// Resolve com o resultado; preventDefault evita que o erro do request aborte a transação (igual à memória).
const rq = <T>(r: any): Promise<T> =>
  new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = (ev: any) => {
      ev?.preventDefault?.();
      ev?.stopPropagation?.();
      rej(mapErr(r.error));
    };
  });

const done = (t: any): Promise<void> => {
  const p = new Promise<void>((res, rej) => {
    t.oncomplete = () => res();
    t.onabort = () => rej(t.error ?? new Error('AbortError'));
  });
  p.catch(() => {}); // evita rejeição não tratada quando o erro já chegou pelo request
  return p;
};

function migrator(idb: any, utx: any): Migrator {
  return {
    createStore: (name, o) => void idb.createObjectStore(name, { keyPath: o.keyPath, autoIncrement: !!o.autoIncrement }),
    createIndex: (s, name, keyPath, o) => void utx.objectStore(s).createIndex(name, keyPath, { unique: !!o?.unique }),
    deleteStore: (name) => idb.deleteObjectStore(name),
    forEach: (s, fn) => {
      const r = utx.objectStore(s).openCursor();
      r.onsuccess = () => {
        const c = r.result;
        if (!c) return;
        const nv = fn(c.value);
        if (nv !== undefined) c.update(nv);
        c.continue();
      };
    },
  };
}

export type IdbDb = Db & { close(): void };

/** Abre (e migra) a base. Rejeita com VersionError nativo se a base for mais nova que o código. */
export function openIdb(
  name = 'vans-alert',
  migrations: readonly Migration[] = MIGRATIONS,
  api: IdbApi = globalThis as any,
): Promise<IdbDb> {
  return new Promise((res, rej) => {
    const req = api.indexedDB.open(name, migrations.length);
    req.onupgradeneeded = (ev: any) => {
      const m = migrator(req.result, req.transaction);
      for (let n = ev.oldVersion; n < migrations.length; n++) migrations[n]!(m);
    };
    req.onerror = () => rej(req.error);
    req.onsuccess = () => res(wrap(req.result, api));
  });
}

function wrap(db: any, api: IdbApi): IdbDb {
  let cur: any; // transação ambiente
  let curDone: Promise<void> | undefined;
  const tx = ambientTx({
    begin: () => {
      cur = db.transaction([...db.objectStoreNames], 'readwrite');
      curDone = done(cur);
    },
    commit: async () => { await curDone; cur = undefined; },
    rollback: () => { try { cur?.abort(); } catch { /* já finalizada */ } cur = undefined; },
  });

  async function run<T>(mode: 'readonly' | 'readwrite', store: string, fn: (os: any) => Promise<T>): Promise<T> {
    if (cur) return fn(cur.objectStore(store));
    const t = db.transaction(store, mode);
    const d = done(t);
    const v = await fn(t.objectStore(store));
    await d;
    return v;
  }

  const range = (r?: KeyRange): any => {
    if (!r) return undefined;
    const K = api.IDBKeyRange;
    if (r.eq !== undefined) return K.only(r.eq);
    const lo = r.gte ?? r.gt;
    const hi = r.lte ?? r.lt;
    if (lo !== undefined && hi !== undefined) return K.bound(lo, hi, r.gt !== undefined, r.lt !== undefined);
    if (lo !== undefined) return K.lowerBound(lo, r.gt !== undefined);
    if (hi !== undefined) return K.upperBound(hi, r.lt !== undefined);
    return undefined;
  };
  const src = (os: any, o?: QueryOpts) => (o?.index ? os.index(o.index) : os);

  return {
    get: (s, k) => run('readonly', s, (os) => rq(os.get(k))),
    add: (s, v) => run('readwrite', s, (os) => rq(os.add(v))),
    put: (s, v) => run('readwrite', s, (os) => rq(os.put(v))),
    delete: (s, k) => run('readwrite', s, async (os) => void (await rq(os.delete(k)))),
    clear: (s) => run('readwrite', s, async (os) => void (await rq(os.clear()))),
    count: (s, o) => run('readonly', s, (os) => rq(src(os, o).count(range(o?.range)))),
    getAll: <T>(s: string, o?: QueryOpts) =>
      run('readonly', s, (os) =>
        new Promise<T[]>((res, rej) => {
          const out: T[] = [];
          const r = src(os, o).openCursor(range(o?.range), o?.direction ?? 'next');
          r.onsuccess = () => {
            const c = r.result;
            if (!c || (o?.limit !== undefined && out.length >= o.limit)) return res(out);
            out.push(c.value);
            c.continue();
          };
          r.onerror = (ev: any) => { ev?.preventDefault?.(); rej(mapErr(r.error)); };
        })),
    tx,
    close: () => db.close(),
  };
}
