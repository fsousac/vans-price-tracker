import { ConstraintError, prefixRange, type Db } from './db.ts';
import { StoreConstraintError, type NewObservation, type ObservationRepo, type ObservationRow } from './ports.ts';

const S = 'observations';
const pos = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0;

/** Observações (RF-07). Falha de extração nunca chega aqui: preço <= 0 é recusado (RN-04, RF-11-AC2). */
export function createObservationRepo(db: Db): ObservationRepo {
  // Mais novas primeiro; desempate por seq e id (igual ao repositório SQLite).
  // ponytail: lê a série inteira da variante e ordena/filtra em memória; paginar por cursor se passar de ~10 mil linhas.
  const series = async (v: string, confirmed?: boolean): Promise<ObservationRow[]> => {
    const rows = await db.getAll<ObservationRow>(S, { index: 'byVariant', range: prefixRange(v) });
    return rows
      .filter((r) => confirmed === undefined || r.confirmed === confirmed)
      .sort((a, b) => (a.observedAt < b.observedAt ? 1 : a.observedAt > b.observedAt ? -1 : b.seq - a.seq || b.id - a.id));
  };

  return {
    async insert(o: NewObservation) {
      if (!pos(o.currentCents)) throw new StoreConstraintError('current_cents_positive', 'preço atual deve ser > 0');
      if (!pos(o.originalCents) || o.currentCents > o.originalCents) {
        throw new StoreConstraintError('original_cents', 'preço original inválido ou menor que o atual');
      }
      if (!Number.isSafeInteger(o.runId) || !Number.isSafeInteger(o.seq)) throw new StoreConstraintError('run_seq');
      try {
        // Campos explícitos: nada além do contrato é persistido.
        const id = await db.add(S, {
          variantCode: o.variantCode, runId: o.runId, seq: o.seq, observedAt: o.observedAt,
          originalCents: o.originalCents, currentCents: o.currentCents, available: o.available,
          confirmed: o.confirmed, degraded: o.degraded, source: o.source, confirmedBy: null,
        });
        return id as number;
      } catch (e) {
        if (e instanceof ConstraintError) throw new StoreConstraintError('run_variant_seq', 'observação já gravada para (runId, variantCode, seq)');
        throw e;
      }
    },

    // Único update permitido (RN-09c): marca confirmada e aponta a leitura concordante.
    async confirm(id, confirmedBy) {
      await db.tx(async () => {
        const r = await db.get<ObservationRow>(S, id);
        if (!r) throw new StoreConstraintError('observation_exists', 'observação inexistente');
        await db.put(S, { ...r, confirmed: true, confirmedBy });
      });
    },

    latestConfirmed: async (v) => (await series(v, true))[0] ?? null,
    latestUnconfirmed: async (v) => (await series(v, false))[0] ?? null,
    history: async (v, limit, offset) => (await series(v)).slice(offset, offset + limit),

    async stats(v) {
      const c = await series(v, true);
      if (!c.length) return null;
      const p = c.map((r) => r.currentCents);
      return { minCents: Math.min(...p), maxCents: Math.max(...p), count: c.length };
    },
  };
}
