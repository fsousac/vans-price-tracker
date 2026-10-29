import type { Clock } from '../shared/clock.ts';
import type { Random } from '../shared/random.ts';
import { courtesyMs } from '../scheduler/backoff.ts';
import type { HttpClient, HttpResult, RequestPurpose } from '../price-monitor/ports.ts';
import type { RequestLog } from '../store/ports.ts';

// Funil único de saída da extensão (RNF-REL-03/04): 1 em voo, cortesia 2-5 s, orçamento 400/24 h,
// registro em outbound_requests ANTES da requisição. Versão assíncrona de price-monitor/http/rate-gate.ts.
// ponytail: fila só em memória; se o SW morrer, a cortesia recomeça (o orçamento persiste no log).

export const DAILY_BUDGET = 400;
const DAY_MS = 24 * 3_600_000;

export class BudgetExceededError extends Error {
  constructor() {
    super('Orçamento diário de requisições esgotado');
    this.name = 'BudgetExceededError';
  }
}

export interface RateGate extends HttpClient {
  forPurpose(purpose: RequestPurpose): HttpClient;
}

export function withRateGate(inner: HttpClient, deps: { clock: Clock; random: Random; log: RequestLog }): RateGate {
  const { clock, random, log } = deps;
  let tail: Promise<unknown> = Promise.resolve();
  let lastEnd: number | null = null;

  const run = async (req: Parameters<HttpClient['get']>[0], purpose: RequestPurpose): Promise<HttpResult> => {
    if (lastEnd !== null) {
      const wait = lastEnd + courtesyMs(random) - clock.now().getTime();
      if (wait > 0) await clock.sleep(wait);
    }
    const now = clock.now();
    if ((await log.countSince(new Date(now.getTime() - DAY_MS).toISOString())) >= DAILY_BUDGET) throw new BudgetExceededError();
    await log.record(purpose, now.toISOString());
    try {
      return await inner.get(req);
    } finally {
      lastEnd = clock.now().getTime();
    }
  };

  const forPurpose = (purpose: RequestPurpose): HttpClient => ({
    get(req) {
      const p = tail.then(() => run(req, purpose));
      tail = p.catch(() => undefined);
      return p;
    },
  });
  return { ...forPurpose('monitor'), forPurpose };
}
