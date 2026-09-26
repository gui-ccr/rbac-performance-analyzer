// PRNG determinístico (mulberry32). Mesma semente => mesma sequência, em qualquer
// máquina — é o que garante "mesmo gerador, mesma seed" entre RLS e Middleware
// (docs/METODOLOGIA.md, variáveis controladas).

export interface Rng {
  /** Float em [0, 1). */
  next(): number;
  /** Inteiro em [0, max). */
  int(max: number): number;
  pick<T>(items: readonly T[]): T;
  /** UUID v4 determinístico. */
  uuid(): string;
}

export function createRng(seed: number): Rng {
  let a = seed >>> 0;

  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const int = (max: number): number => Math.floor(next() * max);

  return {
    next,
    int,
    pick<T>(items: readonly T[]): T {
      return items[int(items.length)] as T;
    },
    uuid(): string {
      const bytes = Array.from({ length: 16 }, () => int(256));
      bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40; // versão 4
      bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80; // variante RFC 4122
      const hex = bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    },
  };
}
