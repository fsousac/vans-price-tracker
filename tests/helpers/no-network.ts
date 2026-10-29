// Preload: bloqueia rede exceto loopback (RNF-TEST-01/02). Uso: node --import ./tests/helpers/no-network.ts
import dns from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '[::1]']);
const FLAG = Symbol.for('vans.noNetwork');

export class NetworkBlockedError extends Error {
  constructor(host: string) {
    super(`rede bloqueada nos testes: ${host}`);
    this.name = 'NetworkBlockedError';
  }
}

function assertLoopback(host: unknown): void {
  const h = typeof host === 'string' && host !== '' ? host : 'localhost';
  if (!LOOPBACK.has(h)) throw new NetworkBlockedError(h);
}

// ponytail: host/path extraídos só das formas (options) e (port, host); socket unix passa.
function hostOf(args: unknown[]): unknown {
  const a = args[0];
  if (typeof a === 'object' && a !== null) {
    const o = a as { host?: string; path?: string };
    return o.path ? 'localhost' : o.host;
  }
  if (typeof a === 'string' && Number.isNaN(Number(a))) return 'localhost'; // path
  return typeof args[1] === 'string' ? args[1] : undefined;
}

const g = globalThis as Record<symbol, unknown>;
if (!g[FLAG]) {
  g[FLAG] = true;

  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    try {
      assertLoopback(hostOf(args));
    } catch (e) {
      queueMicrotask(() => this.destroy(e as Error));
      return this;
    }
    return (connect as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof connect;

  const lookup = dns.lookup;
  dns.lookup = function (host: string, ...rest: unknown[]) {
    const cb = rest[rest.length - 1] as (e: Error) => void;
    if (LOOPBACK.has(host)) return (lookup as (...a: unknown[]) => unknown)(host, ...rest);
    queueMicrotask(() => cb(new NetworkBlockedError(host)));
    return {};
  } as unknown as typeof dns.lookup;

  const tlsConnect = tls.connect;
  tls.connect = function (...args: unknown[]) {
    assertLoopback(hostOf(args) ?? (args[0] as { servername?: string })?.servername);
    return (tlsConnect as (...a: unknown[]) => tls.TLSSocket)(...args);
  } as typeof tls.connect;
}
