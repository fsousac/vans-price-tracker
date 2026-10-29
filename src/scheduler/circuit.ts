import type { StateRepo } from '../observability/ports.ts';
import type { FailureClass, IsoUtc } from '../shared/types.ts';

// Disjuntor global (architecture.md 5; RN-18). Contagem da rodada pura; persistência via StateRepo.

export const CIRCUIT_OPEN_MS = 24 * 3_600_000;
const TRANSPORT = new Set<FailureClass>(['rede_timeout', 'http_5xx', 'http_429', 'http_403_ou_desafio', 'host_nao_autorizado']);
const BAD_CONTENT = new Set<FailureClass>(['formato_desconhecido', 'preco_invalido']);

export type RoundDecision =
  | { action: 'continue' }
  | { action: 'open_circuit'; reason: string }
  | { action: 'end_partial' }; // 3 produtos seguidos com conteúdo ruim: sem circuito (T-FLH-13)

// Uma instância por rodada. Chamar observe() a cada tentativa concluída (null = sucesso).
// "Seguidas": qualquer resultado fora da classe quebra a sequência; conteúdo ruim não conta como transporte.
export class RoundBreaker {
  #transport = 0;
  #r429 = 0;
  #content = 0;

  observe(c: FailureClass | null): RoundDecision {
    this.#transport = c && TRANSPORT.has(c) ? this.#transport + 1 : 0;
    this.#r429 = c === 'http_429' ? this.#r429 + 1 : 0;
    this.#content = c && BAD_CONTENT.has(c) ? this.#content + 1 : 0;
    if (c === 'http_403_ou_desafio') return { action: 'open_circuit', reason: 'http_403_ou_desafio' };
    if (this.#r429 >= 2) return { action: 'open_circuit', reason: 'http_429_repetido' };
    if (this.#transport >= 3) return { action: 'open_circuit', reason: 'falhas_de_transporte' };
    if (this.#content >= 3) return { action: 'end_partial' };
    return { action: 'continue' };
  }
}

export type CircuitStatus =
  | { state: 'closed' }
  | { state: 'open'; until: IsoUtc; reason: string | null }
  | { state: 'half_open'; reason: string | null }; // venceu: a próxima requisição é a sonda

export class CircuitStore {
  #state: StateRepo;
  constructor(state: StateRepo) {
    this.#state = state;
  }

  status(now: IsoUtc): CircuitStatus {
    const until = this.#state.get('circuit_open_until');
    if (until === null) return { state: 'closed' };
    const reason = this.#state.get('circuit_reason');
    return until > now ? { state: 'open', until, reason } : { state: 'half_open', reason };
  }

  // Abre (ou reabre após sonda falha) por 24 h. created=true só no início do episódio (1 aviso, 1 health_event).
  open(reason: string, now: IsoUtc): { created: boolean; until: IsoUtc } {
    const created = this.#state.get('circuit_open_until') === null;
    const until = new Date(Date.parse(now) + CIRCUIT_OPEN_MS).toISOString();
    this.#state.set('circuit_open_until', until, now);
    if (created) this.#state.set('circuit_reason', reason, now);
    this.#state.delete('circuit_probe_pending');
    return { created, until };
  }

  beginProbe(now: IsoUtc): void {
    this.#state.set('circuit_probe_pending', '1', now);
  }

  probeFailed(now: IsoUtc): { until: IsoUtc } {
    return { until: this.open(this.#state.get('circuit_reason') ?? 'sonda_falhou', now).until };
  }

  close(): void {
    this.#state.delete('circuit_open_until');
    this.#state.delete('circuit_reason');
    this.#state.delete('circuit_probe_pending');
  }
}
