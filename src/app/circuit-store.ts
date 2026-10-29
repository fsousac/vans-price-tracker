import type { CircuitStatus } from '../scheduler/circuit.ts';
import { CIRCUIT_OPEN_MS } from '../scheduler/circuit.ts';
import type { IsoUtc } from '../shared/types.ts';
import type { KvRepo } from '../store/ports.ts';

// Disjuntor global em storage (RN-18): versão assíncrona de scheduler/circuit.ts#CircuitStore, sobre KvRepo.
// O SW morre entre rodadas; nada fica em variável de módulo.
export class CircuitStore {
  readonly #kv: KvRepo;
  constructor(kv: KvRepo) {
    this.#kv = kv;
  }

  async status(now: IsoUtc): Promise<CircuitStatus> {
    const until = await this.#kv.get('circuit_open_until');
    if (until === null) return { state: 'closed' };
    const reason = await this.#kv.get('circuit_reason');
    return until > now ? { state: 'open', until, reason } : { state: 'half_open', reason };
  }

  // created=true só no início do episódio (1 aviso, 1 health_event); reabrir após sonda falha não cria outro.
  async open(reason: string, now: IsoUtc): Promise<{ created: boolean; until: IsoUtc }> {
    const created = (await this.#kv.get('circuit_open_until')) === null;
    const until = new Date(Date.parse(now) + CIRCUIT_OPEN_MS).toISOString();
    await this.#kv.set('circuit_open_until', until);
    if (created) await this.#kv.set('circuit_reason', reason);
    await this.#kv.delete('circuit_probe_pending');
    return { created, until };
  }

  async beginProbe(): Promise<void> {
    await this.#kv.set('circuit_probe_pending', '1');
  }

  async probeFailed(now: IsoUtc): Promise<{ until: IsoUtc }> {
    return { until: (await this.open((await this.#kv.get('circuit_reason')) ?? 'sonda_falhou', now)).until };
  }

  async close(): Promise<void> {
    for (const k of ['circuit_open_until', 'circuit_reason', 'circuit_probe_pending'] as const) await this.#kv.delete(k);
  }
}
