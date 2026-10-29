import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '../observability/logger.ts';
import type { Mailer, MailResult, OutgoingEmail } from './ports.ts';

// Modo teste (RNF-SEC-05): não abre conexão. Sink de arquivo é opt-in (contém PII local).
// ponytail: nome do .eml = idempotencyKey (hex de 64, gerado pelo sistema), pois o Mailer não recebe o id da
// notificação; mudar o contrato de OutgoingEmail só se o dono exigir o id numérico.
export class SimulatedMailer implements Mailer {
  readonly mode = 'teste';
  #n = 0;
  readonly #log: Logger;
  readonly #sinkDir: string | null;

  constructor(log: Logger, sinkDir: string | null = null) {
    this.#log = log;
    this.#sinkDir = sinkDir;
  }

  async send(msg: OutgoingEmail): Promise<MailResult> {
    const id = `simulated:${++this.#n}`;
    if (this.#sinkDir) {
      try {
        const name = /^[0-9a-f]{64}$/.test(msg.idempotencyKey) ? msg.idempotencyKey : `n${this.#n}`;
        await mkdir(this.#sinkDir, { recursive: true });
        await writeFile(
          join(this.#sinkDir, `${name}.eml`),
          `To: ${msg.to}\r\nSubject: ${msg.subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${msg.text}`,
          'utf8',
        );
      } catch {
        this.#log.warn('email_sink_falhou'); // sink é diagnóstico; não derruba o envio simulado
      }
    }
    this.#log.info('email_simulado');
    return { kind: 'accepted', providerMessageId: id };
  }
}
