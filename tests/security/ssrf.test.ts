import { test } from 'node:test';
import assert from 'node:assert/strict';
import type dns from 'node:dns';
import { ALLOWED_HOSTS, guardedLookup, isForbiddenIp, validateOutboundUrl } from '../../src/price-monitor/http/safe-http.ts';

test('T-SEC-01 allowlist exata (regressão S5): só www.vans.com.br', () => {
  assert.deepEqual([...ALLOWED_HOSTS], ['www.vans.com.br']);
});

test('T-SEC-01 validateOutboundUrl aceita só https/443 na allowlist exata', () => {
  for (const ok of ['https://www.vans.com.br/api', 'https://www.vans.com.br:443/x?q=1'])
    assert.equal(validateOutboundUrl(new URL(ok)), true, ok);
  for (const bad of [
    'http://www.vans.com.br/',
    'https://www.vans.com.br:8443/',
    'https://user:pw@www.vans.com.br/',
    'https://www.vans.com.br@evil.test/',
    'https://vans.com.br.evil.test/',
    'https://vans.com.br/',
    'https://secure-static.vans.com.br/',
    'https://evil.www.vans.com.br/',
    'https://169.254.169.254/',
    'https://127.0.0.1/',
    'https://[::1]/',
    'file:///etc/passwd',
  ])
    assert.equal(validateOutboundUrl(new URL(bad)), false, bad);
});

test('T-SEC-01 IPs proibidos: loopback, privados, CGNAT, link-local/metadados, v6, mapeado, multicast', () => {
  for (const ip of [
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', '169.254.169.254',
    '0.0.0.0', '224.0.0.1', '::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8', 'ff02::1', 'lixo',
  ])
    assert.equal(isForbiddenIp(ip), true, ip);
  for (const ip of ['8.8.8.8', '104.16.0.1', '172.15.0.1', '172.32.0.1', '100.63.0.1', '2606:4700::1111'])
    assert.equal(isForbiddenIp(ip), false, ip);
});

type Addr = dns.LookupAddress;
const fake = (addrs: Addr[], error?: Error) =>
  ((_h: string, _o: unknown, cb: (e: Error | null, a?: Addr[]) => void) => cb(error ?? null, addrs)) as unknown as typeof dns.lookup;
const run = (resolver: typeof dns.lookup, all: boolean) =>
  new Promise<{ err: NodeJS.ErrnoException | null; res: unknown; family?: number }>((resolve) =>
    guardedLookup(resolver)('www.vans.com.br', { all }, (err, res, family) => resolve({ err, res, family })),
  );

test('T-SEC-01 lookup com resolvedor falso: IP proibido é recusado (all:true e all:false)', async () => {
  for (const all of [true, false]) {
    const r = await run(fake([{ address: '127.0.0.1', family: 4 }]), all);
    assert.equal(r.err?.code, 'EFORBIDDENIP');
    assert.equal(r.res, undefined);
  }
});

test('T-SEC-07 lookup all:true com endereço misto (público + proibido) rejeita tudo, sem filtrar', async () => {
  const r = await run(
    fake([
      { address: '104.16.0.1', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ]),
    true,
  );
  assert.equal(r.err?.code, 'EFORBIDDENIP');
  assert.equal(r.res, undefined);
});

test('T-SEC-07 lookup trata as duas formas de retorno quando público', async () => {
  const addrs: Addr[] = [
    { address: '104.16.0.1', family: 4 },
    { address: '2606:4700::1111', family: 6 },
  ];
  const a = await run(fake(addrs), true);
  assert.equal(a.err, null);
  assert.deepEqual(a.res, addrs);
  const b = await run(fake(addrs), false);
  assert.equal(b.err, null);
  assert.equal(b.res, '104.16.0.1');
  assert.equal(b.family, 4);
});

test('T-SEC-01 lookup: erro do resolvedor e lista vazia propagam falha', async () => {
  assert.ok((await run(fake([], new Error('ENOTFOUND')), true)).err);
  assert.ok((await run(fake([]), true)).err);
});
