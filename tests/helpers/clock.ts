import type { Clock } from '../../src/shared/clock.ts';

type Timer = { due: number; seq: number; resolve: () => void };

export class ManualClock implements Clock {
  #t: number;
  #seq = 0;
  #timers: Timer[] = [];

  constructor(start: string | Date) {
    this.#t = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.#t);
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const timer: Timer = { due: this.#t + Math.max(0, ms), seq: this.#seq++, resolve };
      this.#timers.push(timer);
      signal?.addEventListener(
        'abort',
        () => {
          this.#timers = this.#timers.filter((x) => x !== timer);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  }

  // Avança e resolve, em ordem de vencimento (empate: ordem de chamada), os sleep() vencidos.
  async advance(ms: number): Promise<void> {
    const target = this.#t + ms;
    for (;;) {
      const next = this.#timers
        .filter((x) => x.due <= target)
        .sort((a, b) => a.due - b.due || a.seq - b.seq)[0];
      if (!next) break;
      this.#timers = this.#timers.filter((x) => x !== next);
      this.#t = Math.max(this.#t, next.due);
      next.resolve();
      // deixa as continuações (e novos sleeps encadeados) rodarem antes do próximo vencimento
      await new Promise<void>((r) => setImmediate(r));
    }
    this.#t = target;
  }
}
