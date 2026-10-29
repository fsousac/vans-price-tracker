import type { Clock } from '../../shared/clock.ts';
import type { Random } from '../../shared/random.ts';
import { courtesyMs } from '../../scheduler/backoff.ts';
import type { HttpClient, HttpResult, RequestLog, RequestPurpose } from '../ports.ts';

// Único funil de saída (RNF-REL-03/04): serializa (1 em voo no processo), espaça 2-5 s e registra cada
// requisição em outbound_requests. Orçamento 400/24 h de qualquer origem.

export const DAILY_BUDGET = 400;
const DAY_MS = 24 * 3_600_000;

export class BudgetExceededError extends Error {
  constructor() {
    super('Orçamento diário de requisições esgotado');
    this.name = 'BudgetExceededError';
  }
}

export interface RateGate extends HttpClient {
  // Cliente que registra a requisição com a origem dada (get() direto usa 'monitor').
  forPurpose(purpose: RequestPurpose): HttpClient;
}

export function withRateGate(inner: HttpClient, deps: { clock: Clock; random: Random; log: RequestLog }): RateGate {
  const { clock, random, log } = deps;
  let tail: Promise<unknown> = Promise.resolve();
  let lastEnd: number | null = null; // fim da requisição anterior (relógio do Clock)

  const run = async (req: Parameters<HttpClient['get']>[0], purpose: RequestPurpose): Promise<HttpResult> => {
    if (lastEnd !== null) {
      const wait = lastEnd + courtesyMs(random) - clock.now().getTime();
      if (wait > 0) await clock.sleep(wait);
    }
    const now = clock.now();
    if (log.countSince(new Date(now.getTime() - DAY_MS).toISOString()) >= DAILY_BUDGET) throw new BudgetExceededError();
    log.record(purpose, now.toISOString());
    try {
      return await inner.get(req);
    } finally {
      lastEnd = clock.now().getTime();
    }
  };

  const forPurpose = (purpose: RequestPurpose): HttpClient => ({
    get(req) {
      const p = tail.then(() => run(req, purpose));
      tail = p.catch(() => undefined); // uma falha não trava a fila
      return p;
    },
  });
  return { ...forPurpose('monitor'), forPurpose };
}
