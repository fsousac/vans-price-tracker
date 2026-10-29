import { err, ok, type Result } from '../shared/result.ts';
import type { Clock } from '../shared/clock.ts';
import type { FailureClass, IsoUtc } from '../shared/types.ts';
import type { StateRepo } from '../observability/ports.ts';
import type { HttpClient, RunRepo, RunTrigger } from '../price-monitor/ports.ts';
import type { CircuitStore } from '../scheduler/circuit.ts';
import { fetchCatalog } from './catalog.source.ts';
import type { CatalogItem, CatalogRepo } from './ports.ts';

// Busca local + atualização manual (RF-01, D-25). A cortesia de 2-5 s entre páginas vem do RateGate que embrulha `http`.

export const CATALOG_MIN_INTERVAL_MS = 24 * 3_600_000;

export type RefreshRefusal =
  | { reason: 'intervalo_minimo'; nextAllowedAt: IsoUtc }
  | { reason: 'circuito_aberto'; until: IsoUtc }
  | { reason: 'em_andamento' }
  | { reason: 'falha'; failure: FailureClass; httpStatus?: number; circuitOpened: boolean };

export interface CatalogServiceDeps {
  repo: CatalogRepo;
  http: HttpClient; // gate.forPurpose('catalog')
  state: StateRepo;
  circuit: CircuitStore;
  runs: RunRepo;
  clock: Clock;
}

export class CatalogService {
  readonly #d: CatalogServiceDeps;
  constructor(deps: CatalogServiceDeps) {
    this.#d = deps;
  }

  // Nunca toca a rede (RF-01-AC1/AC2).
  search(q: string, limit = 50): CatalogItem[] {
    return this.#d.repo.search(q, limit);
  }

  isEmpty(): boolean {
    return this.#d.repo.count() === 0;
  }

  lastRefreshAt(): IsoUtc | null {
    return this.#d.state.get('catalog_last_refresh_at');
  }

  async refresh(trigger: RunTrigger = 'manual'): Promise<Result<{ count: number; skipped: number }, RefreshRefusal>> {
    const { repo, state, circuit, runs, clock } = this.#d;
    const now = clock.now().toISOString();

    const last = state.get('catalog_last_refresh_at');
    if (last !== null) {
      const next = new Date(Date.parse(last) + CATALOG_MIN_INTERVAL_MS).toISOString();
      if (next > now) return err({ reason: 'intervalo_minimo', nextAllowedAt: next });
    }
    const c = circuit.status(now);
    if (c.state === 'open') return err({ reason: 'circuito_aberto', until: c.until });

    const run = runs.tryStart('catalog', trigger, now);
    if ('skipped' in run) return err({ reason: 'em_andamento' });

    const finish = (status: 'ok' | 'failed', requests: number, circuitOpened: boolean): void =>
      runs.finish(
        run.runId,
        { status, itemsTotal: 0, itemsOk: 0, itemsFailed: 0, requestsMade: requests, circuitOpened },
        clock.now().toISOString(),
      );

    try {
      const res = await fetchCatalog(this.#d.http);
      if (!res.ok) {
        // 429/403: para, abre o circuito (RN-18) e mantém o catálogo anterior (RF-01-AC5)
        const f = res.error.failure;
        const open = f === 'http_429' || f === 'http_403_ou_desafio';
        if (open) circuit.open(f, clock.now().toISOString());
        finish('failed', 0, open);
        return err({ reason: 'falha', failure: f, httpStatus: res.error.httpStatus, circuitOpened: open });
      }
      // Listagem sem nenhum item válido não apaga o catálogo existente.
      if (res.value.items.length === 0) {
        finish('failed', 0, false);
        return err({ reason: 'falha', failure: 'formato_desconhecido', circuitOpened: false });
      }
      const at = clock.now().toISOString();
      repo.replaceAll(res.value.items, at);
      state.set('catalog_last_refresh_at', at, at);
      finish('ok', 0, false);
      return ok({ count: res.value.items.length, skipped: res.value.skipped });
    } catch (e) {
      finish('failed', 0, false);
      throw e;
    }
  }
}
