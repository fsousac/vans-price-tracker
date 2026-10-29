import { err, ok, type Result } from '../shared/result.ts';
import type { Clock } from '../shared/clock.ts';
import type { FailureClass, IsoUtc } from '../shared/types.ts';
import type { HttpClient, HttpResult, RunTrigger } from '../price-monitor/ports.ts';
import type { CircuitStatus } from '../scheduler/circuit.ts';
import { PAGE_SIZE } from '../catalog/catalog.source.ts';
import { parseListing } from '../catalog/catalog.parser.ts';
import type { CatalogStore } from '../store/catalog.store.ts';
import type { CatalogItem } from '../store/ports.ts';
import { BudgetExceededError } from './rate-gate.ts';

// Busca local + atualização do catálogo por geração, em fatias com cursor (EA 7.3; RF-01, D-25).
// Páginas ficam invisíveis até commitGen; cortesia 2-5 s e orçamento vêm do RateGate que embrulha `http`.

export const CATALOG_MIN_INTERVAL_MS = 24 * 3_600_000;
export const SLICE_MS = 150_000;
const MAX_PAGES = 100; // mesma trava de catalog.source
const BASE = 'https://www.vans.com.br/arezzocoocc/v2/vans/products/search';

export type RefreshRefusal =
  | { reason: 'intervalo_minimo'; nextAllowedAt: IsoUtc }
  | { reason: 'circuito_aberto'; until: IsoUtc }
  | { reason: 'em_andamento' }
  | { reason: 'orcamento_esgotado' }
  | { reason: 'falha'; failure: FailureClass; httpStatus?: number; circuitOpened: boolean };

// Subconjunto do CircuitStore (síncrono hoje, assíncrono em E28): `await` serve aos dois.
export interface CatalogCircuit {
  status(now: IsoUtc): CircuitStatus | Promise<CircuitStatus>;
  open(reason: string, now: IsoUtc): unknown;
}

export interface CatalogAppDeps {
  store: CatalogStore;
  http: HttpClient; // gate.forPurpose('catalog')
  circuit: CatalogCircuit;
  clock: Clock;
  sliceMs?: number;
}
/** done=false: fatia esgotada, chamar de novo (alarme) para retomar do cursor. */
export type RefreshOutcome = { done: boolean; pages: number; skipped: number; count: number | null };

export function createCatalogApp(d: CatalogAppDeps) {
  const { store, http, circuit, clock } = d;
  const sliceMs = d.sliceMs ?? SLICE_MS;
  let busy = false; // ponytail: trava só em memória; SW morto libera sozinha, o cursor persiste

  const pageUrl = (page: number): URL => {
    const u = new URL(BASE);
    u.searchParams.set('category', 'SAPATOS');
    u.searchParams.set('currentPage', String(page));
    u.searchParams.set('pageSize', String(PAGE_SIZE));
    return u;
  };

  async function refreshInner(): Promise<Result<RefreshOutcome, RefreshRefusal>> {
    const t0 = clock.now().getTime();
    const now = clock.now().toISOString();
    const c = await circuit.status(now);
    if (c.state === 'open') return err({ reason: 'circuito_aberto', until: c.until });

    let cur = await store.getCursor(); // cursor vivo = atualização interrompida: retoma sem a trava de 24 h
    if (cur === null) {
      const last = await store.refreshedAt();
      if (last !== null) {
        const next = new Date(Date.parse(last) + CATALOG_MIN_INTERVAL_MS).toISOString();
        if (next > now) return err({ reason: 'intervalo_minimo', nextAllowedAt: next });
      }
      cur = { gen: await store.begin(), page: 0 };
    }

    let pages = 0;
    let skipped = 0;
    for (;;) {
      let res: HttpResult;
      try {
        res = await http.get({ url: pageUrl(cur.page), accept: 'json' });
      } catch (e) {
        if (e instanceof BudgetExceededError) return err({ reason: 'orcamento_esgotado' });
        throw e;
      }
      if (!res.ok) {
        // 429/403: para, sinaliza o circuito (RN-18) e deixa a geração visível intacta (RF-01-AC5)
        const f = res.failure;
        const open = f === 'http_429' || f === 'http_403_ou_desafio';
        if (open) await circuit.open(f, clock.now().toISOString());
        return err({ reason: 'falha', failure: f, httpStatus: res.status, circuitOpened: open });
      }
      const parsed = parseListing(res.body);
      if (!parsed.ok) return err({ reason: 'falha', failure: parsed.error, httpStatus: res.status, circuitOpened: false });
      // Listagem sem nenhum item válido na 1ª página nunca substitui o catálogo (falha de extração não vira dado)
      if (cur.page === 0 && parsed.value.items.length === 0)
        return err({ reason: 'falha', failure: 'formato_desconhecido', httpStatus: res.status, circuitOpened: false });

      await store.putPage(cur.gen, parsed.value.items); // idempotente: repetir após "morte" não duplica
      skipped += parsed.value.skipped;
      pages++;
      if (cur.page + 1 >= Math.min(parsed.value.totalPages, MAX_PAGES)) {
        await store.commitGen(cur.gen, clock.now().toISOString());
        return ok({ done: true, pages, skipped, count: await store.count() });
      }
      cur = { gen: cur.gen, page: cur.page + 1 };
      await store.setCursor(cur);
      if (clock.now().getTime() - t0 >= sliceMs) return ok({ done: false, pages, skipped, count: null });
    }
  }

  return {
    // Nunca toca a rede (RF-01-AC1/AC2).
    search: (q: string, limit = 50): Promise<CatalogItem[]> => store.search(q, limit),
    isEmpty: async (): Promise<boolean> => (await store.count()) === 0,
    lastRefreshAt: (): Promise<IsoUtc | null> => store.refreshedAt(),

    async refresh(_trigger: RunTrigger = 'manual'): Promise<Result<RefreshOutcome, RefreshRefusal>> {
      if (busy) return err({ reason: 'em_andamento' });
      busy = true;
      try {
        return await refreshInner();
      } finally {
        busy = false;
      }
    },
  };
}
