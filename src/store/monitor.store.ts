import { ConstraintError, prefixRange, type Db } from './db.ts';
import {
  StoreConstraintError,
  type ClaimResult, type ProductRepo, type ProductRow, type RequestLog, type RunRepo, type RunRow, type VariantRow,
} from './ports.ts';
import type { IsoUtc, ProductCode } from '../shared/types.ts';

// Repositórios do monitor sobre a porta Db (extension-architecture 6 e 7). Espelha monitor.repo.ts (SQLite) com retomada.
const MAX_SAMPLE = 262_144; // 256 KiB (T-FLH-11)
const ms = (iso: IsoUtc) => Date.parse(iso);
const minus = (iso: IsoUtc, d: number): IsoUtc => new Date(ms(iso) - d).toISOString();

interface ItemRow { runId: number; seq: number; productCode: ProductCode; outcome: string; finishedAt: IsoUtc }

export function createProductRepo(db: Db): ProductRepo {
  const need = async (code: ProductCode) => {
    const p = await db.get<ProductRow>('products', code);
    if (!p) throw new StoreConstraintError('products.code', `produto inexistente: ${code}`);
    return p;
  };
  return {
    async upsertProduct(p, now) {
      await db.tx(async () => {
        const old = await db.get<ProductRow>('products', p.code);
        await db.put('products', {
          code: p.code, name: p.name, legacySku: p.legacySku,
          lastSlug: p.slug ?? old?.lastSlug ?? null,
          state: old?.state ?? 'ativo',
          consecutiveFailures: old?.consecutiveFailures ?? 0,
          notFoundStreak: old?.notFoundStreak ?? 0,
          degradedSince: old?.degradedSince ?? null,
          lastAttemptAt: old?.lastAttemptAt ?? null,
          lastOkAt: old?.lastOkAt ?? null,
          createdAt: old?.createdAt ?? now,
          updatedAt: now,
        } satisfies ProductRow);
      });
    },
    async upsertVariants(code, vs, now) {
      await db.tx(async () => {
        await need(code); // FK
        for (const v of vs) {
          await db.put('variants', { variantCode: v.variantCode, productCode: code, size: v.size, ean: v.ean, lastSeenAt: now } satisfies VariantRow);
        }
      });
    },
    async get(code) {
      return (await db.get<ProductRow>('products', code)) ?? null;
    },
    async listVariants(code) {
      const vs = await db.getAll<VariantRow>('variants', { index: 'productCode', range: { eq: code } });
      return vs.sort((a, b) => (a.variantCode < b.variantCode ? -1 : a.variantCode > b.variantCode ? 1 : 0));
    },
    async getVariant(v) {
      return (await db.get<VariantRow>('variants', v)) ?? null;
    },
    // Só produto 'ativo' com alerta ATIVO; nunca lido primeiro, depois o mais antigo (RF-06-AC7).
    async dueForCollection(now, minIntervalMs) {
      const cutoff = minus(now, minIntervalMs);
      const alerts = await db.getAll<{ variantCode: string }>('alerts', { index: 'status', range: { eq: 'ATIVO' } });
      const wanted = new Set<string>();
      for (const v of new Set(alerts.map((a) => a.variantCode))) {
        const row = await db.get<VariantRow>('variants', v);
        if (row) wanted.add(row.productCode);
      }
      const ps = await db.getAll<ProductRow>('products', { index: 'state', range: { eq: 'ativo' } });
      return ps
        .filter((p) => wanted.has(p.code) && (p.lastOkAt === null || p.lastOkAt <= cutoff))
        .sort((a, b) =>
          (a.lastOkAt === null ? 0 : 1) - (b.lastOkAt === null ? 0 : 1) ||
          (a.lastOkAt ?? '').localeCompare(b.lastOkAt ?? '') ||
          a.code.localeCompare(b.code))
        .map((p) => p.code);
    },
    async recordSuccess(code, o) {
      await db.tx(async () => {
        const p = await need(code);
        await db.put('products', {
          ...p, consecutiveFailures: 0, notFoundStreak: 0,
          degradedSince: o.degraded ? (p.degradedSince ?? o.now) : null,
          lastAttemptAt: o.now, lastOkAt: o.now, updatedAt: o.now,
        });
      });
    },
    // Toda falha conta; só produto_removido conta no streak (RN-19: 2 => removido).
    async recordFailure(code, f) {
      return db.tx(async () => {
        const p = await need(code);
        const removed = f.class === 'produto_removido';
        const streak = removed ? p.notFoundStreak + 1 : 0;
        const next: ProductRow = {
          ...p, consecutiveFailures: p.consecutiveFailures + 1, notFoundStreak: streak,
          state: removed && streak >= 2 ? 'removido' : p.state, lastAttemptAt: f.now, updatedAt: f.now,
        };
        await db.put('products', next);
        return { consecutiveFailures: next.consecutiveFailures, notFoundStreak: streak, state: next.state };
      });
    },
    async setState(code, s, now) {
      await db.tx(async () => {
        await db.put('products', { ...(await need(code)), state: s, updatedAt: now });
      });
    },
    async saveFailureSample(code, s) {
      await db.put('failure_samples', {
        productCode: code, runId: s.runId, capturedAt: s.capturedAt,
        httpStatus: s.httpStatus ?? null, contentType: s.contentType?.slice(0, 100) ?? null,
        body: s.body.slice(0, MAX_SAMPLE),
      });
    },
    async clearFailureSample(code) {
      await db.delete('failure_samples', code);
    },
  };
}

export function createRunRepo(db: Db): RunRepo & {
  /** Fecha toda rodada 'running' como 'interrupted' (ex. onStartup). Devolve quantas. */
  markInterrupted(now: IsoUtc): Promise<number>;
} {
  const running = () => db.getAll<RunRow>('runs', { index: 'status', range: { eq: 'running' } });
  const must = async (id: number) => {
    const r = await db.get<RunRow>('runs', id);
    if (!r) throw new StoreConstraintError('runs.id', `rodada inexistente: ${id}`);
    return r;
  };
  return {
    async markInterrupted(now) {
      return db.tx(async () => {
        const rs = await running();
        for (const r of rs) await db.put('runs', { ...r, status: 'interrupted', finishedAt: now, resumeAt: null });
        return rs.length;
      });
    },
    // Uma 'running' por vez: garantido pelo mutex da tx (sem índice único no IndexedDB).
    async claim(a) {
      return db.tx<ClaimResult>(async () => {
        const [cur] = await running();
        if (cur) {
          const beat = ms(cur.heartbeatAt ?? cur.startedAt);
          if (ms(a.now) - beat < a.leaseMs) return { action: 'busy' };
          if (cur.kind === a.kind && ms(a.now) - ms(cur.startedAt) <= a.maxResumeAgeMs) {
            const run: RunRow = { ...cur, heartbeatAt: a.now, resumeAt: null };
            await db.put('runs', run);
            return { action: 'resumed', run };
          }
          await db.put('runs', { ...cur, status: 'interrupted', finishedAt: a.now, resumeAt: null });
        }
        const row = {
          kind: a.kind, trigger: a.trigger, status: 'running', skipReason: null, startedAt: a.now, finishedAt: null,
          itemsTotal: 0, itemsOk: 0, itemsFailed: 0, requestsMade: 0, circuitOpened: false,
          queue: [...a.queue], heartbeatAt: a.now, resumeAt: null,
        };
        const id = (await db.add('runs', row)) as number;
        return { action: 'started', run: { ...row, id } as RunRow };
      });
    },
    async heartbeat(runId, now) {
      await db.tx(async () => {
        const r = await must(runId);
        if (r.status === 'running') await db.put('runs', { ...r, heartbeatAt: now });
      });
    },
    async setResumeAt(runId, at) {
      await db.tx(async () => {
        const r = await must(runId);
        if (r.status === 'running') await db.put('runs', { ...r, resumeAt: at });
      });
    },
    async recordSkipped(kind, trigger, reason, now) {
      await db.add('runs', {
        kind, trigger, status: 'skipped', skipReason: reason, startedAt: now, finishedAt: now,
        itemsTotal: 0, itemsOk: 0, itemsFailed: 0, requestsMade: 0, circuitOpened: false,
        queue: [], heartbeatAt: null, resumeAt: null,
      });
    },
    // Idempotente por (runId, productCode): cobre retomada após morte entre fetch e gravação.
    async addItem(runId, i) {
      return db.tx(async () => {
        const dup = (await db.getAll<ItemRow>('run_items', { index: 'productCode', range: { eq: i.productCode } }))
          .some((x) => x.runId === runId);
        if (dup) return false;
        const skipped = i.outcome === 'pulado';
        try {
          await db.add('run_items', {
            runId, seq: i.seq, productCode: i.productCode, outcome: i.outcome, finishedAt: i.finishedAt,
            failureClass: i.outcome === 'falha' ? i.failureClass : null,
            skipReason: skipped ? i.skipReason : null,
            httpStatus: skipped ? null : (i.httpStatus ?? null),
            source: skipped ? null : (i.source ?? null),
            requests: skipped ? 0 : i.requests,
            attempts: skipped ? 1 : i.attempts,
            durationMs: skipped ? null : (i.durationMs ?? null),
            observationsWritten: i.outcome === 'ok' || i.outcome === 'degradado' ? i.observationsWritten : 0,
          });
        } catch (e) {
          if (e instanceof ConstraintError) throw new StoreConstraintError('run_items.seq', e.message); // seq repetido com outro produto
          throw e;
        }
        return true;
      });
    },
    async doneCodes(runId) {
      return (await db.getAll<ItemRow>('run_items', { range: prefixRange(runId) })).map((x) => x.productCode);
    },
    // Só sai de 'running' uma vez; chamada repetida não sobrescreve.
    async finish(runId, s, now) {
      await db.tx(async () => {
        const r = await must(runId);
        if (r.status !== 'running') return;
        await db.put('runs', { ...r, ...s, finishedAt: now, resumeAt: null });
      });
    },
    async getRunning(kind) {
      return (await running()).find((r) => r.kind === kind) ?? null;
    },
    // ponytail: ignora 'running' e 'skipped' (rodada pulada não reinicia a agenda); varre `runs` (poucas linhas).
    async lastFinished(kind) {
      const rs = await db.getAll<RunRow>('runs', { index: 'startedAt', direction: 'prev' });
      return rs.find((r) => r.kind === kind && r.status !== 'running' && r.status !== 'skipped') ?? null;
    },
    async lastSuccessfulItemAt(code) {
      const items = await db.getAll<ItemRow>('run_items', { index: 'productCode', range: { eq: code } });
      return items.filter((x) => x.outcome === 'ok' || x.outcome === 'degradado').map((x) => x.finishedAt).sort().pop() ?? null;
    },
  };
}

export function createRequestLog(db: Db): RequestLog & { prune(before: IsoUtc): Promise<number> } {
  return {
    async record(purpose, now) {
      await db.add('outbound_requests', { at: now, purpose });
    },
    countSince: (since) => db.count('outbound_requests', { index: 'at', range: { gte: since } }),
    /** Apaga requisições anteriores a `before` (política: > 48 h). */
    async prune(before) {
      return db.tx(async () => {
        const old = await db.getAll<{ id: number }>('outbound_requests', { index: 'at', range: { lt: before } });
        for (const r of old) await db.delete('outbound_requests', r.id);
        return old.length;
      });
    },
  };
}
