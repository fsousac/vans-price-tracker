export interface Random {
  next(): number; // [0,1); jitter e testes determinísticos
}

export class SystemRandom implements Random {
  next(): number {
    return Math.random();
  }
}
