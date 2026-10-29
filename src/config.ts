// Único lugar que lê process.env (security.md 3). Mensagens citam a chave, nunca o valor.
export class ConfigError extends Error {
  readonly variable: string;
  constructor(variable: string, reason: string) {
    super(`Configuração inválida: ${variable} ${reason}`);
    this.name = 'ConfigError';
    this.variable = variable;
  }
}

// Segredo que não vaza em String(), JSON, template nem console.log; só reveal() entrega o valor.
export interface Secret {
  reveal(): string;
  toString(): string;
  toJSON(): string;
}
function secret(value: string): Secret {
  const masked = () => '***';
  const s = { reveal: () => value, toString: masked, toJSON: masked };
  Object.defineProperty(s, Symbol.for('nodejs.util.inspect.custom'), { value: masked });
  return Object.freeze(s);
}

export interface SmtpConfig {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly user: Secret;
  readonly pass: Secret;
  readonly from: string;
}

export interface Config {
  readonly port: number;
  readonly bindHost: string;
  readonly allowNonLocalBind: boolean;
  readonly dbPath: string;
  readonly monitorIntervalHours: number;
  readonly monitorEnabled: boolean;
  readonly confirmReread: boolean;
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
  readonly emailMode: 'test' | 'real';
  readonly emailTestSink: 'none' | 'file';
  readonly ownerEmail: string | null;
  readonly smtp: SmtpConfig | null;
  readonly warnings: readonly string[];
}

type Env = Readonly<Record<string, string | undefined>>;

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

export function loadConfig(env: Env = process.env): Config {
  const get = (k: string): string | undefined => {
    const v = env[k]?.trim();
    return v ? v : undefined;
  };
  const int = (k: string, def: number, min: number, max: number): number => {
    const v = get(k);
    if (v === undefined) return def;
    const n = Number(v);
    if (!/^\d+$/.test(v) || n < min || n > max) throw new ConfigError(k, `deve ser inteiro entre ${min} e ${max}`);
    return n;
  };
  const oneOf = <T extends string>(k: string, def: T, allowed: readonly T[]): T => {
    const v = get(k);
    if (v === undefined) return def;
    if (!(allowed as readonly string[]).includes(v)) throw new ConfigError(k, `deve ser um de: ${allowed.join(', ')}`);
    return v as T;
  };
  const flag = (k: string, def: boolean): boolean => {
    const v = get(k);
    if (v === undefined) return def;
    if (v !== '0' && v !== '1') throw new ConfigError(k, 'deve ser 0 ou 1');
    return v === '1';
  };
  const email = (k: string): string | null => {
    const v = get(k);
    if (v === undefined) return null;
    if (v.length > 254 || !/^[^\s,@]+@[^\s,@]+\.[^\s,@]+$/.test(v)) throw new ConfigError(k, 'não é um e-mail válido');
    return v;
  };

  const warnings: string[] = [];
  const bindHost = get('BIND_HOST') ?? '127.0.0.1';
  const allowNonLocalBind = flag('ALLOW_NON_LOCAL_BIND', false);
  if (!LOOPBACK.has(bindHost)) {
    if (!allowNonLocalBind) throw new ConfigError('BIND_HOST', 'fora de loopback exige ALLOW_NON_LOCAL_BIND=1');
    warnings.push('BIND_HOST fora de loopback: servidor sem autenticação exposto na rede');
  }

  const intervalRaw = get('MONITOR_INTERVAL_HOURS');
  const monitorIntervalHours = intervalRaw === undefined ? 4 : Number(intervalRaw);
  if (!Number.isFinite(monitorIntervalHours) || monitorIntervalHours < 2 || monitorIntervalHours > 6) {
    throw new ConfigError('MONITOR_INTERVAL_HOURS', 'deve estar entre 2 e 6');
  }

  const emailMode = oneOf('EMAIL_MODE', 'test', ['test', 'real'] as const);
  let smtp: SmtpConfig | null = null;
  if (emailMode === 'real') {
    const need = (k: string): string => {
      const v = get(k);
      if (v === undefined) throw new ConfigError(k, 'é obrigatória com EMAIL_MODE=real');
      return v;
    };
    const host = need('SMTP_HOST');
    need('SMTP_PORT');
    const port = int('SMTP_PORT', 0, 1, 65535);
    const user = need('SMTP_USER');
    const pass = need('SMTP_PASS');
    const from = need('SMTP_FROM');
    const secureRaw = get('SMTP_SECURE');
    if (secureRaw !== undefined && secureRaw !== 'true' && secureRaw !== 'false') {
      throw new ConfigError('SMTP_SECURE', 'deve ser true ou false');
    }
    // ponytail: SMTP_SECURE ausente = true só na 465 (TLS implícito); nas demais o mailer usa requireTLS.
    smtp = Object.freeze({
      host, port, user: secret(user), pass: secret(pass), from,
      secure: secureRaw === undefined ? port === 465 : secureRaw === 'true',
    });
  }

  return Object.freeze({
    port: int('PORT', 3000, 1, 65535),
    bindHost,
    allowNonLocalBind,
    dbPath: get('DB_PATH') ?? 'data/vans-alert.db',
    monitorIntervalHours,
    monitorEnabled: flag('MONITOR_ENABLED', true),
    confirmReread: flag('CONFIRM_REREAD', true),
    logLevel: oneOf('LOG_LEVEL', 'info', ['debug', 'info', 'warn', 'error'] as const),
    emailMode,
    emailTestSink: oneOf('EMAIL_TEST_SINK', 'none', ['none', 'file'] as const),
    ownerEmail: email('OWNER_EMAIL'),
    smtp,
    warnings: Object.freeze(warnings),
  });
}
