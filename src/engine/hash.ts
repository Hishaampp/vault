export const hex = (u: Uint8Array): string => Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');

/** Non-cryptographic fallback, only used when SubtleCrypto is unavailable (plain http). */
export function fnv64(bytes: Uint8Array): string {
  let a = 0x811c9dc5;
  let b = 0x9747b28c;
  for (let i = 0; i < bytes.length; i++) {
    a ^= bytes[i];
    a = Math.imul(a, 16777619);
    b ^= bytes[i];
    b = Math.imul(b, 0x5bd1e995);
    b ^= b >>> 15;
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) return hex(new Uint8Array(await subtle.digest('SHA-256', bytes as BufferSource)));
  return fnv64(bytes);
}

/** Fast 32-bit string hash used for rendezvous placement. */
export function hash32(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return h >>> 0;
}

/** Small seeded PRNG so tests are deterministic. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) globalThis.crypto.getRandomValues(b.subarray(i, Math.min(n, i + 65536)));
  return b;
}
