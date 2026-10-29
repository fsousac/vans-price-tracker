// Contrato da porta Db, sem node:test: recebe um `assert` mínimo e uma fábrica de Db NOVO (esquema real).
// Roda em Node contra a memória e no navegador (selftest.html) contra idb.ts.
import { prefixRange, type Db } from './db.ts';

export interface Assert {
  equal(a: unknown, b: unknown, msg?: string): void;
  deepEqual(a: unknown, b: unknown, msg?: string): void;
  ok(v: unknown, msg?: string): void;
}
export type OpenDb = () => Promise<Db>;

async function failsWith(a: Assert, name: string, p: Promise<unknown>) {
  let err: unknown;
  try { await p; } catch (e) { err = e; }
  a.equal((err as { name?: string } | undefined)?.name, name, `esperava ${name}`);
}

const obs = (variantCode: string, observedAt: string, seq: number, runId = 1) => ({
  variantCode, observedAt, seq, runId, currentCents: 1000 + seq,
});

export const dbContractCases: [string, (a: Assert, open: OpenDb) => Promise<void>][] = [
  ['get/put/delete/count/clear em store de chave simples', async (a, open) => {
    const db = await open();
    a.equal(await db.get('kv', 'x'), undefined);
    await db.put('kv', { key: 'x', value: 1 });
    await db.put('kv', { key: 'x', value: 2 });
    await db.put('kv', { key: 'y', value: 3 });
    a.deepEqual(await db.get('kv', 'x'), { key: 'x', value: 2 });
    a.equal(await db.count('kv'), 2);
    await db.delete('kv', 'x');
    a.equal(await db.get('kv', 'x'), undefined);
    await db.clear('kv');
    a.equal(await db.count('kv'), 0);
  }],

  ['add rejeita chave duplicada (ConstraintError) sem alterar o existente', async (a, open) => {
    const db = await open();
    await db.add('kv', { key: 'x', value: 1 });
    await failsWith(a, 'ConstraintError', db.add('kv', { key: 'x', value: 2 }));
    a.deepEqual(await db.get('kv', 'x'), { key: 'x', value: 1 });
  }],

  ['valores são copiados (mutar o retorno não altera a base)', async (a, open) => {
    const db = await open();
    const v = { key: 'x', value: { n: 1 } };
    await db.put('kv', v);
    v.value.n = 9;
    const r = (await db.get<typeof v>('kv', 'x'))!;
    a.equal(r.value.n, 1);
    r.value.n = 7;
    a.equal(((await db.get<typeof v>('kv', 'x'))!).value.n, 1);
  }],

  ['autoincremento devolve a chave e a grava no registro', async (a, open) => {
    const db = await open();
    const k1 = await db.add('alerts', { variantCode: 'A', status: 'ativo' });
    const k2 = await db.add('alerts', { variantCode: 'B', status: 'ativo' });
    a.equal(k1, 1);
    a.equal(k2, 2);
    a.deepEqual(await db.get('alerts', 2), { id: 2, variantCode: 'B', status: 'ativo' });
  }],

  ['índice simples: ordem por chave do índice e depois pela primária', async (a, open) => {
    const db = await open();
    for (const [v, s] of [['A', 'z'], ['B', 'a'], ['C', 'z'], ['D', 'a']]) await db.add('alerts', { variantCode: v, status: s });
    const r = await db.getAll<{ variantCode: string }>('alerts', { index: 'status' });
    a.deepEqual(r.map((x) => x.variantCode), ['B', 'D', 'A', 'C']);
    const p = await db.getAll<{ variantCode: string }>('alerts', { index: 'status', direction: 'prev' });
    a.deepEqual(p.map((x) => x.variantCode), ['C', 'A', 'D', 'B']);
    a.equal(await db.count('alerts', { index: 'status', range: { eq: 'a' } }), 2);
  }],

  ['índice composto: prefixo, intervalo, direção e limite', async (a, open) => {
    const db = await open();
    await db.add('observations', obs('V1', '2026-10-01T00:00:00Z', 1));
    await db.add('observations', obs('V2', '2026-10-01T00:00:00Z', 2));
    await db.add('observations', obs('V1', '2026-10-03T00:00:00Z', 3));
    await db.add('observations', obs('V1', '2026-10-02T00:00:00Z', 4));
    const seqs = (r: { seq: number }[]) => r.map((x) => x.seq);
    const all = await db.getAll<{ seq: number }>('observations', { index: 'byVariant', range: prefixRange('V1') });
    a.deepEqual(seqs(all), [1, 4, 3]);
    const last = await db.getAll<{ seq: number }>('observations', { index: 'byVariant', range: prefixRange('V1'), direction: 'prev', limit: 1 });
    a.deepEqual(seqs(last), [3]);
    const mid = await db.getAll<{ seq: number }>('observations', {
      index: 'byVariant',
      range: { gte: ['V1', '2026-10-02T00:00:00Z'], lte: ['V1', '2026-10-03T00:00:00Z'] },
    });
    a.deepEqual(seqs(mid), [4, 3]);
    const excl = await db.getAll<{ seq: number }>('observations', {
      index: 'byVariant', range: { gt: ['V1', '2026-10-01T00:00:00Z'], lt: ['V1', '2026-10-03T00:00:00Z'] },
    });
    a.deepEqual(seqs(excl), [4]);
    a.equal(await db.count('observations', { index: 'byVariant', range: prefixRange('V1') }), 3);
    a.equal(await db.count('observations'), 4);
    a.deepEqual(await db.getAll('observations', { limit: 0 }), []);
  }],

  ['chave primária composta e intervalo na primária', async (a, open) => {
    const db = await open();
    for (const [r, s] of [[1, 1], [1, 2], [2, 1]]) await db.put('run_items', { runId: r, seq: s, productCode: 'P' });
    a.equal((await db.getAll('run_items', { range: prefixRange(1) })).length, 2);
    a.ok(await db.get('run_items', [2, 1]));
    a.equal(await db.count('run_items', { index: 'productCode', range: { eq: 'P' } }), 3);
  }],

  ['índice único composto: add rejeita, put do mesmo registro não', async (a, open) => {
    const db = await open();
    const id = await db.add('observations', obs('V1', '2026-10-01T00:00:00Z', 1));
    await failsWith(a, 'ConstraintError', db.add('observations', obs('V1', '2026-10-02T00:00:00Z', 1)));
    await db.put('observations', { ...obs('V1', '2026-10-01T00:00:00Z', 1), id, currentCents: 5 });
    a.equal(await db.count('observations'), 1);
    await failsWith(a, 'ConstraintError', db.put('observations', obs('V1', '2026-10-02T00:00:00Z', 1)));
    a.equal(await db.count('observations'), 1);
  }],

  ['registro sem chave de índice válida não entra no índice', async (a, open) => {
    const db = await open();
    await db.add('alerts', { variantCode: 'A' }); // sem status
    await db.add('alerts', { variantCode: 'B', status: 'x' });
    a.equal((await db.getAll('alerts', { index: 'status' })).length, 1);
    a.equal(await db.count('alerts'), 2);
  }],

  ['tx confirma várias stores', async (a, open) => {
    const db = await open();
    const r = await db.tx(async () => {
      await db.put('kv', { key: 'a', value: 1 });
      await db.put('products', { code: 'P', state: 'ativo' });
      return (await db.get<{ value: number }>('kv', 'a'))!.value;
    });
    a.equal(r, 1);
    a.ok(await db.get('products', 'P'));
  }],

  ['tx rejeitada faz rollback total (inclui autoincremento e clear)', async (a, open) => {
    const db = await open();
    await db.put('kv', { key: 'keep', value: 1 });
    let err: unknown;
    try {
      await db.tx(async () => {
        await db.put('kv', { key: 'new', value: 2 });
        await db.add('alerts', { variantCode: 'A', status: 's' });
        await db.clear('kv');
        throw new Error('falha injetada');
      });
    } catch (e) { err = e; }
    a.equal((err as Error).message, 'falha injetada');
    a.deepEqual(await db.get('kv', 'keep'), { key: 'keep', value: 1 });
    a.equal(await db.get('kv', 'new'), undefined);
    a.equal(await db.count('alerts'), 0);
  }],

  ['ConstraintError capturado dentro da tx não impede o commit do resto', async (a, open) => {
    const db = await open();
    await db.add('kv', { key: 'x', value: 1 });
    await db.tx(async () => {
      try { await db.add('kv', { key: 'x', value: 2 }); } catch { /* esperado */ }
      await db.put('kv', { key: 'y', value: 3 });
    });
    a.equal(await db.count('kv'), 2);
    a.deepEqual(await db.get('kv', 'x'), { key: 'x', value: 1 });
  }],

  ['transações são exclusivas e serializadas (sem perda de atualização)', async (a, open) => {
    const db = await open();
    await db.put('kv', { key: 'n', value: 0 });
    const inc = () => db.tx(async () => {
      const r = (await db.get<{ value: number }>('kv', 'n'))!;
      await db.put('kv', { key: 'n', value: r.value + 1 });
    });
    await Promise.all([inc(), inc(), inc(), inc(), inc()]);
    a.equal(((await db.get<{ value: number }>('kv', 'n'))!).value, 5);
  }],

  ['tx aninhada reaproveita a corrente; falha externa desfaz também a interna', async (a, open) => {
    const db = await open();
    try {
      await db.tx(async () => {
        await db.tx(async () => { await db.put('kv', { key: 'i', value: 1 }); });
        throw new Error('x');
      });
    } catch { /* esperado */ }
    a.equal(await db.get('kv', 'i'), undefined);
  }],

  ['tx que falha não trava as seguintes', async (a, open) => {
    const db = await open();
    await db.tx(async () => { throw new Error('x'); }).catch(() => {});
    await db.tx(async () => { await db.put('kv', { key: 'ok', value: 1 }); });
    a.ok(await db.get('kv', 'ok'));
  }],
];

export async function runDbContract(assert: Assert, open: OpenDb): Promise<{ name: string; error?: unknown }[]> {
  const out: { name: string; error?: unknown }[] = [];
  for (const [name, fn] of dbContractCases) {
    try { await fn(assert, open); out.push({ name }); } catch (error) { out.push({ name, error }); }
  }
  return out;
}
