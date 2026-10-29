import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { loadConfig, ConfigError } from '../../src/config.ts';

const SMTP = { EMAIL_MODE: 'real', SMTP_HOST: 'smtp.x.test', SMTP_PORT: '587', SMTP_USER: 'usr-secreto', SMTP_PASS: 'senha-super-secreta', SMTP_FROM: 'a@x.test' };

function fails(env: Record<string, string>, variable: string, leak?: string): void {
  assert.throws(() => loadConfig(env), (e: unknown) => {
    assert.ok(e instanceof ConfigError);
    assert.equal(e.variable, variable);
    assert.ok(e.message.includes(variable));
    if (leak) assert.ok(!e.message.includes(leak));
    return true;
  });
}

test('T-MNT-03 padrões seguros com ambiente vazio (EMAIL_MODE=test, loopback, 4 h, CONFIRM_REREAD=1)', () => {
  const c = loadConfig({});
  assert.equal(c.port, 3000);
  assert.equal(c.bindHost, '127.0.0.1');
  assert.equal(c.dbPath, 'data/vans-alert.db');
  assert.equal(c.monitorIntervalHours, 4);
  assert.equal(c.monitorEnabled, true);
  assert.equal(c.confirmReread, true);
  assert.equal(c.emailMode, 'test');
  assert.equal(c.smtp, null);
  assert.equal(c.ownerEmail, null);
  assert.deepEqual(c.warnings, []);
});

test('T-MNT-03 strings vazias (.env.example) contam como ausentes', () => {
  assert.equal(loadConfig({ PORT: '', EMAIL_MODE: '', SMTP_HOST: '' }).port, 3000);
});

test('T-MNT-03 objeto congelado', () => {
  const c = loadConfig({});
  assert.ok(Object.isFrozen(c));
  assert.throws(() => { (c as { port: number }).port = 1; }, TypeError);
});

test('T-MNT-03 CONFIRM_REREAD=0 desliga; valor inválido nomeia a variável', () => {
  assert.equal(loadConfig({ CONFIRM_REREAD: '0' }).confirmReread, false);
  fails({ CONFIRM_REREAD: 'sim' }, 'CONFIRM_REREAD');
  fails({ MONITOR_ENABLED: 'x' }, 'MONITOR_ENABLED');
});

test('T-MON-02 intervalo fora de 2-6 h é recusado, limites aceitos', () => {
  for (const v of ['1.9', '0', '6.1', '7', 'abc', '-3']) fails({ MONITOR_INTERVAL_HOURS: v }, 'MONITOR_INTERVAL_HOURS');
  assert.equal(loadConfig({ MONITOR_INTERVAL_HOURS: '2' }).monitorIntervalHours, 2);
  assert.equal(loadConfig({ MONITOR_INTERVAL_HOURS: '6' }).monitorIntervalHours, 6);
});

test('T-MNT-03 PORT e enums inválidos falham nomeando a chave', () => {
  for (const v of ['0', '65536', 'abc', '30.5']) fails({ PORT: v }, 'PORT');
  fails({ LOG_LEVEL: 'trace' }, 'LOG_LEVEL');
  fails({ EMAIL_MODE: 'prod' }, 'EMAIL_MODE');
  fails({ EMAIL_TEST_SINK: 'x' }, 'EMAIL_TEST_SINK');
  assert.equal(loadConfig({ EMAIL_TEST_SINK: 'file' }).emailTestSink, 'file');
});

test('T-SEC-03 BIND_HOST fora de loopback exige ALLOW_NON_LOCAL_BIND=1 e emite aviso', () => {
  for (const h of ['127.0.0.1', 'localhost', '::1']) assert.equal(loadConfig({ BIND_HOST: h }).bindHost, h);
  fails({ BIND_HOST: '0.0.0.0' }, 'BIND_HOST');
  fails({ BIND_HOST: '0.0.0.0', ALLOW_NON_LOCAL_BIND: '0' }, 'BIND_HOST');
  const c = loadConfig({ BIND_HOST: '0.0.0.0', ALLOW_NON_LOCAL_BIND: '1' });
  assert.equal(c.bindHost, '0.0.0.0');
  assert.equal(c.warnings.length, 1);
});

test('T-NOT-03 EMAIL_MODE=real sem cada SMTP_* falha nomeando a variável, sem valores', () => {
  for (const k of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM']) {
    const env: Record<string, string> = { ...SMTP };
    delete env[k];
    assert.throws(() => loadConfig(env), (e: unknown) => {
      assert.ok(e instanceof ConfigError && e.variable === k);
      for (const v of ['usr-secreto', 'senha-super-secreta', 'smtp.x.test']) assert.ok(!e.message.includes(v));
      return true;
    });
  }
});

test('T-NOT-03 SMTP completo carrega; SMTP_SECURE padrão por porta; inválido recusado', () => {
  const c = loadConfig(SMTP);
  assert.equal(c.smtp?.host, 'smtp.x.test');
  assert.equal(c.smtp?.port, 587);
  assert.equal(c.smtp?.secure, false);
  assert.equal(loadConfig({ ...SMTP, SMTP_PORT: '465' }).smtp?.secure, true);
  assert.equal(loadConfig({ ...SMTP, SMTP_SECURE: 'true' }).smtp?.secure, true);
  fails({ ...SMTP, SMTP_SECURE: 'talvez' }, 'SMTP_SECURE');
  fails({ ...SMTP, SMTP_PORT: 'x' }, 'SMTP_PORT');
});

test('T-NOT-03 / T-SEC-05 segredos mascarados em String, JSON, inspect e mensagens', () => {
  const c = loadConfig(SMTP);
  const dump = [JSON.stringify(c), inspect(c, { depth: 5 }), `${c.smtp?.pass}`, `${c.smtp?.user}`].join('|');
  assert.ok(!dump.includes('senha-super-secreta'));
  assert.ok(!dump.includes('usr-secreto'));
  assert.equal(c.smtp?.pass.reveal(), 'senha-super-secreta');
});

test('T-SEC-05 OWNER_EMAIL válido; inválido (CR/LF, vírgula, espaço) nomeia a chave sem o valor', () => {
  assert.equal(loadConfig({ OWNER_EMAIL: 'dono@x.test' }).ownerEmail, 'dono@x.test');
  for (const v of ['semarroba', 'a@b.test,c@d.test', 'a b@x.test', 'a@x.test\r\nBcc: z@z.test']) {
    fails({ OWNER_EMAIL: v }, 'OWNER_EMAIL', v);
  }
});
