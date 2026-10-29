import type { Db } from '../db/connection.ts';
import type { IsoUtc, ProductCode } from '../shared/types.ts';
import type {
  ProductRepo,
  ProductRow,
  RequestLog,
  RunKind,
  RunRepo,
  RunRow,
  VariantRow,
} from './ports.ts';

const MAX_SAMPLE = 262_144; // CHECK de failure_samples.body

type Row = Record<string, unknown>;

const productRow = (r: Row): ProductRow => ({
  code: r.code as string,
  name: r.name as string,
  legacySku: r.legacy_sku as string | null,
  lastSlug: r.last_slug as string | null,
  state: r.state as ProductRow['state'],
  consecutiveFailures: r.consecutive_failures as number,
  notFoundStreak: r.not_found_streak as number,
  degradedSince: r.degraded_since as string | null,
  lastAttemptAt: r.last_attempt_at as string | null,
  lastOkAt: r.last_ok_at as string | null,
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
});

const runRow = (r: Row): RunRow => ({
  id: r.id as number,
  kind: r.kind as RunRow['kind'],
  trigger: r.trigger as RunRow['trigger'],
  status: r.status as RunRow['status'],
  skipReason: r.skip_reason as RunRow['skipReason'],
  startedAt: r.started_at as string,
  finishedAt: r.finished_at as string | null,
  itemsTotal: r.items_total as number,
  itemsOk: r.items_ok as number,
  itemsFailed: r.items_failed as number,
  requestsMade: r.requests_made as number,
  circuitOpened: r.circuit_opened === 1,
});

const minus = (iso: IsoUtc, ms: number): IsoUtc => new Date(Date.parse(iso) - ms).toISOString();

export function createProductRepo(db: Db): ProductRepo {
  const q = (sql: string) => db.prepare(sql);
  const repo: ProductRepo = {
    upsertProduct(p, now) {
      q(
        `INSERT INTO products (code, name, legacy_sku, last_slug, created_at, updated_at)
         VALUES (@code, @name, @legacySku, @slug, @now, @now)
         ON CONFLICT(code) DO UPDATE SET name = excluded.name, legacy_sku = excluded.legacy_sku,
           last_slug = COALESCE(excluded.last_slug, last_slug), updated_at = excluded.updated_at`,
      ).run({ code: p.code, name: p.name, legacySku: p.legacySku, slug: p.slug, now });
    },
    upsertVariants(code, vs, now) {
      const st = q(
        `INSERT INTO product_variants (variant_code, product_code, size, ean, last_seen_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(variant_code) DO UPDATE SET size = excluded.size, ean = excluded.ean, last_seen_at = excluded.last_seen_at`,
      );
      for (const v of vs) st.run(v.variantCode, code, v.size, v.ean, now);
    },
    get(code) {
      const r = q('SELECT * FROM products WHERE code = ?').get(code) as Row | undefined;
      return r ? productRow(r) : null;
    },
    listVariants(code) {
      return (q('SELECT * FROM product_variants WHERE product_code = ? ORDER BY variant_code').all(code) as Row[]).map(
        (r): VariantRow => ({
          variantCode: r.variant_code as string,
          productCode: r.product_code as string,
          size: r.size as string,
          ean: r.ean as string | null,
          lastSeenAt: r.last_seen_at as string,
        }),
      );
    },
    // Lê price_alerts só para leitura (exceção declarada em architecture.md 2). Nunca lido primeiro, depois o mais antigo.
    dueForCollection(now, minIntervalMs) {
      const rows = q(
        `SELECT p.code FROM products p
         WHERE p.state = 'ativo'
           AND (p.last_ok_at IS NULL OR p.last_ok_at <= @cutoff)
           AND EXISTS (SELECT 1 FROM price_alerts a JOIN product_variants v ON v.variant_code = a.variant_code
                       WHERE v.product_code = p.code AND a.status = 'ATIVO')
         ORDER BY p.last_ok_at IS NOT NULL, p.last_ok_at, p.code`,
      ).all({ cutoff: minus(now, minIntervalMs) }) as { code: string }[];
      return rows.map((r) => r.code);
    },
    recordSuccess(code, o) {
      q(
        `UPDATE products SET consecutive_failures = 0, not_found_streak = 0,
           degraded_since = CASE WHEN @degraded = 1 THEN COALESCE(degraded_since, @now) ELSE NULL END,
           last_attempt_at = @now, last_ok_at = @now, updated_at = @now WHERE code = @code`,
      ).run({ code, degraded: o.degraded ? 1 : 0, now: o.now });
    },
    // Toda falha conta em consecutive_failures; só produto_removido conta em not_found_streak (RN-19: 2 => removido).
    recordFailure(code, f) {
      const removed = f.class === 'produto_removido';
      q(
        `UPDATE products SET consecutive_failures = consecutive_failures + 1,
           not_found_streak = CASE WHEN @removed = 1 THEN not_found_streak + 1 ELSE 0 END,
           state = CASE WHEN @removed = 1 AND not_found_streak + 1 >= 2 THEN 'removido' ELSE state END,
           last_attempt_at = @now, updated_at = @now WHERE code = @code`,
      ).run({ code, removed: removed ? 1 : 0, now: f.now });
      const p = repo.get(code);
      if (!p) throw new Error('produto inexistente');
      return { consecutiveFailures: p.consecutiveFailures, notFoundStreak: p.notFoundStreak, state: p.state };
    },
    setState(code, s, now) {
      q('UPDATE products SET state = ?, updated_at = ? WHERE code = ?').run(s, now, code);
    },
    saveFailureSample(code, s) {
      q(
        `INSERT INTO failure_samples (product_code, run_id, captured_at, http_status, content_type, body)
         VALUES (@code, @runId, @capturedAt, @httpStatus, @contentType, @body)
         ON CONFLICT(product_code) DO UPDATE SET run_id = excluded.run_id, captured_at = excluded.captured_at,
           http_status = excluded.http_status, content_type = excluded.content_type, body = excluded.body`,
      ).run({
        code,
        runId: s.runId,
        capturedAt: s.capturedAt,
        httpStatus: s.httpStatus ?? null,
        contentType: s.contentType?.slice(0, 100) ?? null,
        body: s.body.slice(0, MAX_SAMPLE),
      });
    },
    clearFailureSample(code) {
      q('DELETE FROM failure_samples WHERE product_code = ?').run(code);
    },
  };
  return repo;
}

export function createRunRepo(db: Db): RunRepo {
  const q = (sql: string) => db.prepare(sql);
  return {
    tryStart(kind, trigger, now) {
      try {
        const r = q(`INSERT INTO monitoring_runs (kind, trigger, status, started_at) VALUES (?, ?, 'running', ?)`).run(
          kind,
          trigger,
          now,
        );
        return { runId: Number(r.lastInsertRowid) };
      } catch (e) {
        // ux_runs_single_running (RNF-REL-03)
        if ((e as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') return { skipped: 'anterior_em_andamento' };
        throw e;
      }
    },
    recordSkipped(kind, trigger, reason, now) {
      q(
        `INSERT INTO monitoring_runs (kind, trigger, status, skip_reason, started_at, finished_at)
         VALUES (?, ?, 'skipped', ?, ?, ?)`,
      ).run(kind, trigger, reason, now, now);
    },
    addItem(runId, i) {
      const skipped = i.outcome === 'pulado';
      q(
        `INSERT INTO run_items (run_id, product_code, seq, outcome, failure_class, skip_reason, http_status, source,
           requests, attempts, duration_ms, observations_written, finished_at)
         VALUES (@runId, @code, @seq, @outcome, @failureClass, @skipReason, @httpStatus, @source,
           @requests, @attempts, @durationMs, @obs, @finishedAt)`,
      ).run({
        runId,
        code: i.productCode,
        seq: i.seq,
        outcome: i.outcome,
        failureClass: i.outcome === 'falha' ? i.failureClass : null,
        skipReason: skipped ? i.skipReason : null,
        httpStatus: skipped ? null : (i.httpStatus ?? null),
        source: skipped ? null : (i.source ?? null),
        requests: skipped ? 0 : i.requests,
        attempts: skipped ? 1 : i.attempts,
        durationMs: skipped ? null : (i.durationMs ?? null),
        obs: i.outcome === 'ok' || i.outcome === 'degradado' ? i.observationsWritten : 0,
        finishedAt: i.finishedAt,
      });
    },
    // Toda saída de 'running' grava finished_at na mesma UPDATE (CHECK da tabela).
    finish(runId, s, now) {
      q(
        `UPDATE monitoring_runs SET status = @status, finished_at = @now, items_total = @total, items_ok = @ok,
           items_failed = @failed, requests_made = @requests, circuit_opened = @circuit
         WHERE id = @id AND status = 'running'`,
      ).run({
        id: runId,
        status: s.status,
        now,
        total: s.itemsTotal,
        ok: s.itemsOk,
        failed: s.itemsFailed,
        requests: s.requestsMade,
        circuit: s.circuitOpened ? 1 : 0,
      });
    },
    markInterruptedOnStartup(now) {
      return q(`UPDATE monitoring_runs SET status = 'interrupted', finished_at = ? WHERE status = 'running'`).run(now)
        .changes;
    },
    // ponytail: ignora 'running' e 'skipped' (rodada pulada não reinicia a agenda); desempate por id.
    lastFinished(kind: RunKind) {
      const r = q(
        `SELECT * FROM monitoring_runs WHERE kind = ? AND status NOT IN ('running','skipped')
         ORDER BY started_at DESC, id DESC LIMIT 1`,
      ).get(kind) as Row | undefined;
      return r ? runRow(r) : null;
    },
    lastSuccessfulItemAt(code: ProductCode) {
      const r = q(
        `SELECT MAX(finished_at) AS at FROM run_items WHERE product_code = ? AND outcome IN ('ok','degradado')`,
      ).get(code) as { at: string | null };
      return r.at;
    },
  };
}

export function createRequestLog(db: Db): RequestLog {
  return {
    record(purpose, now) {
      db.prepare('INSERT INTO outbound_requests (at, purpose) VALUES (?, ?)').run(now, purpose);
    },
    countSince(since) {
      return (db.prepare('SELECT COUNT(*) AS n FROM outbound_requests WHERE at >= ?').get(since) as { n: number }).n;
    },
  };
}
