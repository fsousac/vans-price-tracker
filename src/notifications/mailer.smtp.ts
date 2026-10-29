import nodemailer from 'nodemailer';
import type { SmtpConfig } from '../config.ts';
import type { Logger } from '../observability/logger.ts';
import type { Mailer, MailResult, OutgoingEmail } from './ports.ts';

export interface SmtpTransport {
  sendMail(m: Record<string, unknown>): Promise<{ messageId?: string; response?: string }>;
}

// TLS obrigatório (S16): 465 = TLS implícito; demais = STARTTLS exigido. rejectUnauthorized nunca false.
export function transportOptions(cfg: SmtpConfig) {
  return {
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    requireTLS: !cfg.secure,
    auth: { user: cfg.user.reveal(), pass: cfg.pass.reveal() },
    tls: { rejectUnauthorized: true },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  };
}

// 4yz = temporário; 5yz, credencial e destinatário inválido = permanente; sem código (rede/TLS) = temporário.
// A razão nunca usa err.message (pode conter o destinatário).
export function classify(err: unknown): MailResult {
  const e = (err ?? {}) as { code?: unknown; responseCode?: unknown };
  const rc = typeof e.responseCode === 'number' ? e.responseCode : null;
  const code = typeof e.code === 'string' && /^[A-Z_]{2,20}$/.test(e.code) ? e.code : 'ERRO';
  if (rc !== null && rc >= 500) return { kind: 'permanent_error', reason: `smtp ${rc} ${code}` };
  if (rc !== null && rc >= 400) return { kind: 'temporary_error', reason: `smtp ${rc} ${code}` };
  if (code === 'EAUTH' || code === 'EENVELOPE') return { kind: 'permanent_error', reason: `smtp ${code}` };
  return { kind: 'temporary_error', reason: `smtp ${code}` };
}

export class SmtpMailer implements Mailer {
  readonly mode = 'real';
  readonly #cfg: SmtpConfig;
  readonly #log: Logger;
  readonly #transport: SmtpTransport;

  constructor(cfg: SmtpConfig, log: Logger, transport?: SmtpTransport) {
    this.#cfg = cfg;
    this.#log = log;
    this.#transport = transport ?? nodemailer.createTransport(transportOptions(cfg));
  }

  async send(msg: OutgoingEmail): Promise<MailResult> {
    try {
      const info = await this.#transport.sendMail({
        from: this.#cfg.from,
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
        messageId: `<${msg.idempotencyKey}@vans-alert.local>`,
      });
      return { kind: 'accepted', providerMessageId: info.messageId ?? msg.idempotencyKey };
    } catch (err) {
      const r = classify(err);
      this.#log.warn('smtp_falha');
      return r;
    }
  }
}
