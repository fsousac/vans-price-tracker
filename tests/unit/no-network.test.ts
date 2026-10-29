import '../helpers/no-network.ts';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import test from 'node:test';
import { fixture, withBadPrice, withDiscountAbovePrice, withoutBaseOptions, withPriceVariations, withZeroPrice } from '../helpers/fixtures.ts';

test('T-TST-01 https.get para vans.com.br e bloqueado', async () => {
  const err = await new Promise<Error>((resolve, reject) => {
    try {
      https.get('https://www.vans.com.br', () => reject(new Error('conectou'))).on('error', resolve);
    } catch (e) {
      resolve(e as Error); // tls.connect bloqueia de forma síncrona
    }
  });
  assert.match(err.message, /bloqueada/);
});

test('T-TST-01 dns.lookup externo falha, loopback passa', async () => {
  const e = await new Promise<Error | null>((r) => dns.lookup('www.vans.com.br', (er) => r(er)));
  assert.match(String(e?.message), /bloqueada/);
  const ok = await new Promise<Error | null>((r) => dns.lookup('localhost', (er) => r(er)));
  assert.equal(ok, null);
});

test('T-TST-01 loopback continua funcionando', async () => {
  const srv = http.createServer((_, res) => res.end('ok')).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const { port } = srv.address() as { port: number };
  const body = await new Promise<string>((resolve, reject) => {
    http.get({ host: '127.0.0.1', port }, (res) => {
      let s = '';
      res.on('data', (c) => (s += c)).on('end', () => resolve(s));
    }).on('error', reject);
  });
  srv.close();
  assert.equal(body, 'ok');
});

test('T-TST-01 fixture() carrega por import.meta.url e construtores adulteram sem mutar', () => {
  const occ = fixture('occ_disc_1003800580026U.json');
  assert.equal(occ.price.value, 649.99);
  assert.equal(withZeroPrice(occ).price.value, 0);
  assert.equal(withBadPrice(occ, 'abc').discountPrice.value, 'abc');
  const d = withDiscountAbovePrice(occ);
  assert.ok(d.discountPrice.value > d.price.value);
  assert.equal(withPriceVariations(occ).hasPriceVariations, true);
  assert.equal(withoutBaseOptions(occ).baseOptions[0].options, undefined);
  assert.equal(occ.price.value, 649.99);
  assert.ok(occ.baseOptions[0].options.length === 13);
});
