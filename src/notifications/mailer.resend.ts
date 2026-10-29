import type { Mailer, MailResult, OutgoingEmail } from './ports.ts';

export const RESEND_URL = 'https://api.resend.com/emails';
export interface ResendConfig { apiKey: string; from: string; timeoutMs?: number }
type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

// "accepted" = aceito pelo provedor (2xx com id), nunca "entregue". Razões fixas: sem corpo/chave/destinatário (RNF-SEC).
export class ResendMailer implements Mailer {
  readonly mode = 'real';
  readonly #cfg: ResendConfig;
  readonly #fetch: FetchFn;

  constructor(cfg: ResendConfig, fetchImpl: FetchFn = (u, i) => fetch(u, i)) {
    this.#cfg = cfg;
    this.#fetch = fetchImpl;
  }

  async send(msg: OutgoingEmail): Promise<MailResult> {
    try {
      const res = await this.#fetch(RESEND_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.#cfg.apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': msg.idempotencyKey,
        },
        body: JSON.stringify({ from: this.#cfg.from, to: [msg.to], subject: msg.subject, text: msg.text, html: msg.html }),
        credentials: 'omit',
        redirect: 'error',
        signal: AbortSignal.timeout(this.#cfg.timeoutMs ?? 15_000),
      });
      const s = res.status;
      if (s >= 200 && s < 300) {
        const id = ((await res.json().catch(() => null)) as { id?: unknown } | null)?.id;
        return typeof id === 'string' && id
          ? { kind: 'accepted', providerMessageId: id }
          : { kind: 'temporary_error', reason: `resend ${s} sem_id` }; // sem id não prova aceite
      }
      if (s === 429 || s >= 500) return { kind: 'temporary_error', reason: `resend ${s}` };
      return { kind: 'permanent_error', reason: `resend ${s}` };
    } catch {
      return { kind: 'temporary_error', reason: 'resend rede' }; // rede/timeout/redirect/permissão ausente
    }
  }
}
