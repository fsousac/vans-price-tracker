import type { Random } from '../../src/shared/random.ts';

// mulberry32: PRNG semeado, determinístico.
export class SeededRandom implements Random {
  #s: number;
  constructor(seed: number) {
    this.#s = seed >>> 0;
  }
  next(): number {
    this.#s = (this.#s + 0x6d2b79f5) >>> 0;
    let t = this.#s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}
