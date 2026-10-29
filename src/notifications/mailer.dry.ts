import type { Mailer, MailResult, OutgoingEmail } from './ports.ts';

// Modo teste (RNF-SEC-05): zero rede, zero armazenamento; "aceito" é simulado, nunca entrega.
export class DryRunMailer implements Mailer {
  readonly mode = 'teste';
  #n = 0;
  async send(_msg: OutgoingEmail): Promise<MailResult> {
    return { kind: 'accepted', providerMessageId: `simulated:${++this.#n}` };
  }
}
