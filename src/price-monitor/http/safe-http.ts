import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';
import type { Readable } from 'node:stream';
import { SystemClock, type Clock } from '../../shared/clock.ts';
import type { FailureClass } from '../../shared/types.ts';
import type { HttpClient, HttpResult } from '../ports.ts';
import { ALLOWED_HOSTS, MAX_BODY_BYTES, parseRetryAfter, validateOutboundUrl } from './outbound-url.ts';

export { ALLOWED_HOSTS, MAX_BODY_BYTES, validateOutboundUrl }; // compat: testes e chamadores antigos

// Único ponto de saída de rede do price-monitor (architecture.md 126; security.md S2..S5).

export const USER_AGENT = 'VansPriceWatcher/0.1 (uso pessoal)'; // fixo; nunca trocado para evasão (RNF-LEG-02)
export const MAX_REDIRECTS = 3;
const CONNECT_TIMEOUT_MS = 5_000;
const TOTAL_TIMEOUT_MS = 15_000;
const PRODUCT_PATH = /^\/(?:[a-z0-9-]+\/)?p\/([A-Za-z0-9]{8,20})$/;
const REDIRECT_PATH = /^\/[a-z0-9-]+\/p\/([A-Za-z0-9]{8,20})$/;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

// --- IPs proibidos (S3) -------------------------------------------------------------------
const FORBIDDEN = new net.BlockList();
for (const [a, p] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.168.0.0', 16], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) FORBIDDEN.addSubnet(a, p, 'ipv4');
for (const [a, p] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) FORBIDDEN.addSubnet(a, p, 'ipv6');

export function isForbiddenIp(address: string): boolean {
  const v = net.isIP(address);
  if (v === 0 || /^::ffff:/i.test(address)) return true; // IPv4 mapeado em IPv6 (BlockList o trata como v4, por isso fora da lista)
  return FORBIDDEN.check(address, v === 4 ? 'ipv4' : 'ipv6');
}

type Resolver = typeof dns.lookup;
type LookupCb = (err: NodeJS.ErrnoException | null, address?: string | dns.LookupAddress[], family?: number) => void;
export type LookupFn = (hostname: string, options: dns.LookupOptions, cb: LookupCb) => void;

// Resolve (sempre com all:true), rejeita a resolução inteira se qualquer endereço for proibido
// e devolve no formato pedido (all:true => array; senão o primeiro). Node 24 usa all:true.
export function guardedLookup(resolver: Resolver = dns.lookup): LookupFn {
  return (hostname, options, cb) => {
    resolver(hostname, { ...options, all: true }, (e, addrs) => {
      if (e) return cb(e);
      const list = addrs as dns.LookupAddress[];
      if (list.length === 0 || list.some((a) => isForbiddenIp(a.address))) {
        const ee: NodeJS.ErrnoException = new Error('endereco_proibido');
        ee.code = 'EFORBIDDENIP';
        return cb(ee);
      }
      if (options.all) return cb(null, list);
      cb(null, list[0]!.address, list[0]!.family);
    });
  };
}

// --- cliente ------------------------------------------------------------------------------
// ca/lookup/connect/timeouts: só para teste (nunca lidos de ambiente); rejectUnauthorized nunca é desligado.
export interface SafeHttpOptions {
  ca?: string | Buffer;
  lookup?: LookupFn;
  connect?: { host: string; port: number }; // testes: conecta aqui; SNI e Host mantêm o nome
  connectTimeoutMs?: number;
  totalTimeoutMs?: number;
  clock?: Clock;
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

interface Raw {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export class SafeHttpClient implements HttpClient {
  readonly #o: SafeHttpOptions;
  readonly #lookup: LookupFn;
  readonly #clock: Clock;

  constructor(o: SafeHttpOptions = {}) {
    this.#o = o;
    this.#lookup = o.lookup ?? guardedLookup();
    this.#clock = o.clock ?? new SystemClock();
  }

  async get(req: { url: URL; headers?: Record<string, string>; accept: 'json' | 'html' }): Promise<HttpResult> {
    const ac = new AbortController();
    // ponytail: timers reais (não o Clock); o total cobre redirects. Testes encurtam via opções.
    const timer = setTimeout(() => ac.abort(new Fail('rede_timeout')), this.#o.totalTimeoutMs ?? TOTAL_TIMEOUT_MS);
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
    if (!validateOutboundUrl(req.url)) throw new Fail('host_nao_autorizado');
    const origin = new URL(req.url.href);
    const code = PRODUCT_PATH.exec(origin.pathname)?.[1]; // só página de produto segue redirect
    let url = origin;
    for (let hops = 0; ; hops++) {
      const raw = await this.#once(url, req, signal);
      const { status, headers } = raw;
      if (REDIRECT_STATUS.has(status)) {
        const loc = headers.location;
        if (code === undefined || typeof loc !== 'string') throw new Fail('formato_desconhecido', status);
        if (hops >= MAX_REDIRECTS) throw new Fail('host_nao_autorizado', status);
        let next: URL;
        try {
          next = new URL(loc, url);
        } catch {
          throw new Fail('host_nao_autorizado', status);
        }
        if (
          !validateOutboundUrl(next) ||
          next.hostname !== origin.hostname ||
          REDIRECT_PATH.exec(next.pathname)?.[1] !== code
        )
          throw new Fail('host_nao_autorizado', status);
        next.search = '';
        next.hash = '';
        url = next;
        continue;
      }
      const retryAfterMs = parseRetryAfter(headers['retry-after'], this.#clock.now().getTime());
      const extra = retryAfterMs === undefined ? {} : { retryAfterMs };
      if (status >= 200 && status < 300) {
        const contentType = String(headers['content-type'] ?? '');
        const mime = contentType.split(';')[0]!.trim().toLowerCase();
        if (mime !== 'application/json' && mime !== 'text/html') throw new Fail('formato_desconhecido', status);
        return { ok: true, status, body: raw.body, contentType, ...extra };
      }
      const failure: FailureClass =
        status === 429 ? 'http_429'
        : status === 403 || headers['cf-mitigated'] !== undefined ? 'http_403_ou_desafio'
        : status >= 500 ? 'http_5xx'
        : 'formato_desconhecido'; // 400/404: quem conhece o contrato (source) decide produto_removido
      return { ok: false, failure, status, body: raw.body, ...extra };
    }
  }

  #once(
    url: URL,
    req: { headers?: Record<string, string>; accept: 'json' | 'html' },
    signal: AbortSignal,
  ): Promise<Raw> {
    // sem cookie jar: nada de Cookie/Set-Cookie; UA fixo
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers ?? {})) {
      const lk = k.toLowerCase();
      if (!['cookie', 'authorization', 'host', 'user-agent', 'accept', 'accept-encoding'].includes(lk)) headers[lk] = v;
    }
    headers.host = url.hostname;
    headers['user-agent'] = USER_AGENT;
    headers.accept = req.accept === 'json' ? 'application/json' : 'text/html';
    headers['accept-encoding'] = 'gzip, br';

    return new Promise<Raw>((resolve, reject) => {
      const r = https.request(
        {
          method: 'GET',
          host: this.#o.connect?.host ?? url.hostname,
          port: this.#o.connect?.port ?? 443,
          path: url.pathname + url.search,
          headers,
          agent: false,
          lookup: this.#lookup as never,
          rejectUnauthorized: true,
          servername: url.hostname,
          ...(this.#o.ca === undefined ? {} : { ca: this.#o.ca }),
          signal,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            res.resume();
            return resolve({ status, headers: res.headers, body: '' });
          }
          readBody(res, status >= 200 && status < 300).then(
            (body) => resolve({ status, headers: res.headers, body }),
            reject,
          );
        },
      );
      r.on('socket', (s) => {
        const t = setTimeout(
          () => r.destroy(new Fail('rede_timeout')),
          this.#o.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
        );
        s.once('secureConnect', () => clearTimeout(t));
        s.once('close', () => clearTimeout(t));
      });
      r.on('error', (e) => {
        if (e instanceof Fail) return reject(e);
        if (signal.aborted && signal.reason instanceof Fail) return reject(signal.reason);
        reject((e as NodeJS.ErrnoException).code === 'EFORBIDDENIP' ? new Fail('host_nao_autorizado') : new Fail('rede_timeout'));
      });
      r.end();
    });
  }
}

// Lê em stream, descomprime e aborta em 2 MB do corpo descomprimido. Em respostas de erro
// (strict=false) trunca em vez de falhar: o corpo serve só de amostra.
function readBody(res: Readable & { headers: Record<string, unknown> }, strict: boolean): Promise<string> {
  const enc = String(res.headers['content-encoding'] ?? 'identity').toLowerCase();
  let src: Readable = res;
  if (enc === 'gzip') src = res.pipe(zlib.createGunzip());
  else if (enc === 'br') src = res.pipe(zlib.createBrotliDecompress());
  else if (enc !== 'identity') {
    res.destroy();
    return Promise.reject(new Fail('formato_desconhecido'));
  }
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const done = (): void => resolve(Buffer.concat(chunks).toString('utf8'));
    src.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        res.destroy();
        src.destroy();
        return strict ? reject(new Fail('formato_desconhecido')) : done();
      }
      chunks.push(c);
    });
    src.on('end', done);
    src.on('error', () => reject(new Fail(strict ? 'formato_desconhecido' : 'rede_timeout')));
    res.on('error', () => reject(new Fail('rede_timeout')));
  });
}
