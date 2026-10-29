import type { Mailer, MailResult, OutgoingEmail } from './ports.ts';

// Mailer de testes: registra `sent`, respostas programáveis, ou "falha se chamado".
export class FakeMailer implements Mailer {
  readonly mode: 'real' | 'teste';
  readonly sent: OutgoingEmail[] = [];
  readonly #queue: MailResult[] = [];
  #forbidden = false;

  constructor(mode: 'real' | 'teste' = 'teste') {
    this.mode = mode;
  }

  // próximas respostas, em ordem; esgotada a fila, aceita.
  enqueue(...r: MailResult[]): this {
    this.#queue.push(...r);
    return this;
  }

  failIfCalled(): this {
    this.#forbidden = true;
    return this;
  }

  send(msg: OutgoingEmail): Promise<MailResult> {
    if (this.#forbidden) throw new Error('FakeMailer.send chamado, mas não deveria');
    this.sent.push(msg);
    return Promise.resolve(this.#queue.shift() ?? { kind: 'accepted', providerMessageId: `fake:${this.sent.length}` });
  }
}
