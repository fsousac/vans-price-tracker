import { SystemClock, type Clock } from '../../shared/clock.ts';
import type { FailureClass } from '../../shared/types.ts';
import type { HttpClient, HttpResult } from '../ports.ts';
import { MAX_BODY_BYTES, parseRetryAfter, validateOutboundRequest } from './outbound-url.ts';

// HttpClient do service worker MV3 (extension-architecture.md 185). DNS/TLS ficam com o navegador;
// o User-Agent não é controlável (ADR-0006).

const TIMEOUT_MS = 15_000;

export interface FetchHttpOptions {
  fetch?: typeof fetch; // injetável nos testes
  clock?: Clock;
  timeoutMs?: number;
}

class Fail extends Error {
  readonly failure: FailureClass;
  readonly status: number | undefined;
  constructor(failure: FailureClass, status?: number) {
    super(failure);
    this.failure = failure;
    this.status = status;
  }
}

export class FetchHttpClient implements HttpClient {
  readonly #fetch: typeof fetch;
  readonly #clock: Clock;
  readonly #timeoutMs: number;

  constructor(o: FetchHttpOptions = {}) {
    this.#fetch = o.fetch ?? ((...a) => fetch(...a));
    this.#clock = o.clock ?? new SystemClock();
    this.#timeoutMs = o.timeoutMs ?? TIMEOUT_MS;
  }

  async get(req: { url: URL; headers?: Record<string, string>; accept: 'json' | 'html' }): Promise<HttpResult> {
    if (!validateOutboundRequest(req.url)) return { ok: false, failure: 'host_nao_autorizado' };
    const ac = new AbortController();
    // ponytail: timer real (não o Clock); cobre também a leitura do corpo.
    const timer = setTimeout(() => ac.abort(), this.#timeoutMs);
    try {
      return await this.#run(req, ac.signal);
    } catch (e) {
      if (e instanceof Fail) return { ok: false, failure: e.failure, ...(e.status ? { status: e.status } : {}) };
      return { ok: false, failure: 'rede_timeout' };
    } finally {
      clearTimeout(timer);
    }
  }

  async #run(
    req: { url: URL; headers?: Record<string, string>; accept: 'json' | 'html' },
    signal: AbortSignal,
  ): Promise<HttpResult> {
    // Cookie/Authorization nunca saem; Host/UA são do navegador.
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers ?? {})) {
      if (!['cookie', 'authorization', 'host', 'user-agent', 'accept', 'accept-encoding'].includes(k.toLowerCase())) headers[k] = v;
    }
    headers.accept = req.accept === 'json' ? 'application/json' : 'text/html';

    const res = await this.#fetch(req.url.href, {
      method: 'GET',
      headers,
      credentials: 'omit',
      redirect: 'manual',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      signal,
    });
    const status = res.status;
    if (res.type === 'opaqueredirect' || (status >= 300 && status < 400)) {
      void res.body?.cancel().catch(() => {});
      throw new Fail('host_nao_autorizado', status || undefined); // redirect nunca é seguido
    }
    const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'), this.#clock.now().getTime());
    const extra = retryAfterMs === undefined ? {} : { retryAfterMs };
    if (res.ok) {
      const contentType = res.headers.get('content-type') ?? '';
      const mime = contentType.split(';')[0]!.trim().toLowerCase();
      if (res.headers.get('cf-mitigated') !== null) {
        void res.body?.cancel().catch(() => {});
        return { ok: false, failure: 'http_403_ou_desafio', status, ...extra }; // desafio vence o status
      }
      if (mime !== 'application/json' && mime !== 'text/html') {
        void res.body?.cancel().catch(() => {});
        throw new Fail('formato_desconhecido', status);
      }
      const body = await readBody(res, true);
      return { ok: true, status, body, contentType, ...extra };
    }
    const failure: FailureClass =
      res.headers.get('cf-mitigated') !== null || status === 403 ? 'http_403_ou_desafio'
      : status === 429 ? 'http_429'
      : status >= 500 ? 'http_5xx'
      : 'formato_desconhecido'; // 400/404: quem conhece o contrato (source) decide produto_removido
    return { ok: false, failure, status, body: await readBody(res, false).catch(() => ''), ...extra };
  }
}

// Lê em stream e aborta em 2 MB. Em erro (strict=false) trunca: o corpo serve só de amostra.
async function readBody(res: Response, strict: boolean): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        if (strict) throw new Fail('formato_desconhecido');
        break;
      }
      chunks.push(value);
    }
  } catch (e) {
    if (strict) throw e; // timeout/abort vira rede_timeout no chamador
  }
  const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of chunks) { all.set(c, off); off += c.length; }
  return new TextDecoder().decode(all);
}
