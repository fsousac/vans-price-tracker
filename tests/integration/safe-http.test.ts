import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';
import { MAX_BODY_BYTES, SafeHttpClient, USER_AGENT } from '../../src/price-monitor/http/safe-http.ts';

// Servidor https local com certificado de teste (openssl, SAN www.vans.com.br) gerado em tmp.
type Handler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void;
let handler: Handler = (_q, r) => r.end();
let server: https.Server;
let cert: string;
let dir: string;
const seen: { url: string; headers: Record<string, string | string[] | undefined> }[] = [];

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'safe-http-'));
  const key = join(dir, 'k.pem');
  const crt = join(dir, 'c.pem');
  execFileSync(
    'openssl',
    ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', crt, '-days', '2', '-subj', '/CN=www.vans.com.br', '-addext', 'subjectAltName=DNS:www.vans.com.br'],
    { stdio: 'ignore' },
  );
  cert = readFileSync(crt, 'utf8');
  server = https.createServer({ key: readFileSync(key), cert }, (q, r) => {
    seen.push({ url: q.url ?? '', headers: q.headers });
    handler(q, r);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
});
after(() => {
  server.closeAllConnections();
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

const client = (o: ConstructorParameters<typeof SafeHttpClient>[0] = {}) =>
  new SafeHttpClient({ ca: cert, connect: { host: '127.0.0.1', port: (server.address() as AddressInfo).port }, ...o });
const U = (p: string) => new URL('https://www.vans.com.br' + p);
const CODE = '1003800580026U';
const PRODUCT = `/p/${CODE}`;

test('T-FLH-01 200 json: ok, UA fixo, sem cookie, Host com o nome, accept pedido', async () => {
  seen.length = 0;
  handler = (_q, r) => {
    r.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'set-cookie': 'JSESSIONID=x' });
    r.end('{"a":1}');
  };
  const c = client();
  const r = await c.get({ url: U('/occ/x'), accept: 'json', headers: { cookie: 'a=b', 'User-Agent': 'evil', 'x-ok': '1' } });
  assert.ok(r.ok);
  assert.equal(r.body, '{"a":1}');
  assert.equal(r.status, 200);
  const h = seen[0]!.headers;
  assert.equal(h['user-agent'], USER_AGENT);
  assert.equal(h.cookie, undefined);
  assert.equal(h.host, 'www.vans.com.br');
  assert.equal(h.accept, 'application/json');
  assert.equal(h['x-ok'], '1');
  // segunda chamada não reenvia o Set-Cookie recebido (sem cookie jar)
  await c.get({ url: U('/occ/x'), accept: 'json' });
  assert.equal(seen[1]!.headers.cookie, undefined);
});

test('T-SEC-02 certificado não confiável é recusado (verificação nunca desligada)', async () => {
  const r = await client({ ca: undefined }).get({ url: U('/occ/x'), accept: 'json' });
  assert.equal(r.ok, false);
});

test('T-SEC-02 gzip e br decodificados', async () => {
  for (const [enc, fn] of [['gzip', zlib.gzipSync], ['br', zlib.brotliCompressSync]] as const) {
    handler = (_q, r) => {
      r.writeHead(200, { 'content-type': 'text/html', 'content-encoding': enc });
      r.end(fn(Buffer.from('<p>olá</p>')));
    };
    const r = await client().get({ url: U('/x'), accept: 'html' });
    assert.ok(r.ok, enc);
    assert.equal(r.body, '<p>olá</p>');
  }
});

test('T-FLH-10 corpo > 2 MB é descartado', async () => {
  handler = (_q, r) => {
    r.writeHead(200, { 'content-type': 'application/json' });
    r.end(Buffer.alloc(MAX_BODY_BYTES + 1, 97));
  };
  const r = await client().get({ url: U('/occ/x'), accept: 'json' });
  assert.deepEqual([r.ok, r.ok ? '' : r.failure], [false, 'formato_desconhecido']);
});

test('T-FLH-10 corpo exatamente 2 MB passa', async () => {
  handler = (_q, r) => {
    r.writeHead(200, { 'content-type': 'application/json' });
    r.end(Buffer.alloc(MAX_BODY_BYTES, 97));
  };
  assert.ok((await client().get({ url: U('/occ/x'), accept: 'json' })).ok);
});

test('T-FLH-10 gzip bomba: limite vale para o corpo descomprimido', async () => {
  const bomb = zlib.gzipSync(Buffer.alloc(MAX_BODY_BYTES * 3, 97)); // poucos KB comprimido
  assert.ok(bomb.length < 100_000);
  handler = (_q, r) => {
    r.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
    r.end(bomb);
  };
  const r = await client().get({ url: U('/x'), accept: 'html' });
  assert.deepEqual([r.ok, r.ok ? '' : r.failure], [false, 'formato_desconhecido']);
});

test('T-FLH-10 Content-Type inesperado e content-encoding desconhecido são descartados', async () => {
  handler = (_q, r) => {
    r.writeHead(200, { 'content-type': 'image/png' });
    r.end('x');
  };
  const a = await client().get({ url: U('/x'), accept: 'html' });
  assert.deepEqual([a.ok, a.ok ? '' : a.failure], [false, 'formato_desconhecido']);
  handler = (_q, r) => {
    r.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'deflate-x' });
    r.end('x');
  };
  const b = await client().get({ url: U('/x'), accept: 'html' });
  assert.deepEqual([b.ok, b.ok ? '' : b.failure], [false, 'formato_desconhecido']);
});

test('T-FLH-09 status HTTP mapeados com Retry-After e corpo de amostra', async () => {
  const cases: [number, string][] = [[429, 'http_429'], [403, 'http_403_ou_desafio'], [503, 'http_5xx'], [400, 'formato_desconhecido'], [404, 'formato_desconhecido']];
  for (const [status, failure] of cases) {
    handler = (_q, r) => {
      r.writeHead(status, { 'content-type': 'application/json', 'retry-after': '7' });
      r.end('{"errors":[1]}');
    };
    const r = await client().get({ url: U('/occ/x'), accept: 'json' });
    assert.ok(!r.ok);
    assert.equal(r.failure, failure);
    assert.equal(r.status, status);
    assert.equal(r.retryAfterMs, 7000);
    assert.equal(r.body, '{"errors":[1]}');
  }
});

test('T-FLH-09 cf-mitigated em qualquer status vira http_403_ou_desafio', async () => {
  handler = (_q, r) => {
    r.writeHead(503, { 'cf-mitigated': 'challenge' });
    r.end();
  };
  const r = await client().get({ url: U('/occ/x'), accept: 'json' });
  assert.ok(!r.ok && r.failure === 'http_403_ou_desafio');
});

test('T-FLH-09 produto: redirect /p/{code} -> /{slug}/p/{code} é seguido', async () => {
  handler = (q, r) => {
    if (q.url === PRODUCT) {
      r.writeHead(301, { location: `/tenis-old-skool/p/${CODE}` });
      return r.end();
    }
    r.writeHead(200, { 'content-type': 'text/html' });
    r.end('ok');
  };
  const r = await client().get({ url: U(PRODUCT + '?fbclid=1'), accept: 'html' });
  assert.ok(r.ok);
  assert.equal(r.body, 'ok');
});

test('T-FLH-09 redirect para host fora da lista, http:, outro code, outro host da lista = host_nao_autorizado', async () => {
  for (const loc of [
    'https://evil.test/x/p/' + CODE,
    `http://www.vans.com.br/x/p/${CODE}`,
    `https://www.vans.com.br:8443/x/p/${CODE}`,
    '/login',
    '/x/p/OUTROCODE123',
    `https://user@www.vans.com.br/x/p/${CODE}`,
  ]) {
    handler = (_q, r) => {
      r.writeHead(302, { location: loc });
      r.end();
    };
    seen.length = 0;
    const r = await client().get({ url: U(PRODUCT), accept: 'html' });
    assert.ok(!r.ok && r.failure === 'host_nao_autorizado', loc);
    assert.equal(seen.length, 1, 'não seguiu: ' + loc);
  }
});

test('T-FLH-09 3 redirects ok, 4 = host_nao_autorizado', async () => {
  let n = 0;
  const run = async (hops: number) => {
    n = 0;
    handler = (_q, r) => {
      if (n++ < hops) {
        r.writeHead(301, { location: `/a${n}/p/${CODE}` });
        return r.end();
      }
      r.writeHead(200, { 'content-type': 'text/html' });
      r.end('fim');
    };
    return client().get({ url: U(PRODUCT), accept: 'html' });
  };
  assert.ok((await run(3)).ok);
  const r4 = await run(4);
  assert.ok(!r4.ok && r4.failure === 'host_nao_autorizado');
});

test('T-FLH-09 OCC/listagem não seguem nenhum redirect (3xx = formato_desconhecido)', async () => {
  for (const p of ['/occ/v2/products/' + CODE, '/c/sapatos']) {
    handler = (_q, r) => {
      r.writeHead(301, { location: p });
      r.end();
    };
    seen.length = 0;
    const r = await client().get({ url: U(p), accept: 'json' });
    assert.ok(!r.ok && r.failure === 'formato_desconhecido' && r.status === 301, p);
    assert.equal(seen.length, 1);
  }
});

test('T-SEC-01 URL inicial fora da allowlist nem abre conexão', async () => {
  seen.length = 0;
  for (const u of ['http://www.vans.com.br/x', 'https://evil.test/x', 'https://www.vans.com.br:8443/x']) {
    const r = await client().get({ url: new URL(u), accept: 'html' });
    assert.ok(!r.ok && r.failure === 'host_nao_autorizado', u);
  }
  assert.equal(seen.length, 0);
});

test('T-SEC-02 timeout total (15 s, encurtado no teste) vira rede_timeout', async () => {
  handler = (_q, r) => {
    r.writeHead(200, { 'content-type': 'text/html' });
    r.write('x'); // nunca termina
  };
  const r = await client({ totalTimeoutMs: 150 }).get({ url: U('/x'), accept: 'html' });
  assert.ok(!r.ok && r.failure === 'rede_timeout');
});

test('T-SEC-02 Retry-After em data HTTP usa o relógio injetado', async () => {
  const { ManualClock } = await import('../helpers/clock.ts');
  handler = (_q, r) => {
    r.writeHead(429, { 'retry-after': 'Wed, 14 Oct 2026 12:00:30 GMT' });
    r.end();
  };
  const r = await client({ clock: new ManualClock('2026-10-14T12:00:00.000Z') }).get({ url: U('/occ/x'), accept: 'json' });
  assert.ok(!r.ok);
  assert.equal(r.retryAfterMs, 30_000);
});

test('T-SEC-01 requisição com lookup real rejeita host que resolve para loopback (sem rede)', async () => {
  // sem `connect`: usa guardedLookup com resolvedor injetado => IP proibido => host_nao_autorizado
  const c = new SafeHttpClient({
    lookup: (_h, _o, cb) => {
      const e: NodeJS.ErrnoException = new Error('endereco_proibido');
      e.code = 'EFORBIDDENIP';
      cb(e);
    },
  });
  writeFileSync(join(dir, 'noop'), '');
  const r = await c.get({ url: U('/x'), accept: 'html' });
  assert.ok(!r.ok);
  assert.ok(['host_nao_autorizado', 'rede_timeout'].includes(r.failure));
});
