import { describe, expect, it } from 'vitest';
import { fnv64, hash32, mulberry32, sha256 } from '../hash';
import { parseKey, pieceKey } from '../cluster';

describe('hashing helpers', () => {
  it('computes the standard SHA-256 of "abc"', async () => {
    expect(await sha256(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('a single flipped bit changes the checksum', async () => {
    const a = new Uint8Array(1024);
    const b = a.slice();
    b[500] ^= 1;
    expect(await sha256(a)).not.toBe(await sha256(b));
    expect(fnv64(a)).not.toBe(fnv64(b));
  });

  it('hash32 is stable and spreads inputs', () => {
    expect(hash32('seg|n1')).toBe(hash32('seg|n1'));
    const seen = new Set(Array.from({ length: 500 }, (_, i) => hash32(`k${i}`)));
    expect(seen.size).toBe(500);
  });

  it('seeded RNG is reproducible and within [0, 1)', () => {
    const a = mulberry32(7), b = mulberry32(7);
    for (let i = 0; i < 100; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it('piece keys round-trip, even with @ and # in object names', () => {
    const k = pieceKey('mail/a@b#c.txt', 12, 3, 5);
    expect(parseKey(k)).toEqual({ name: 'mail/a@b#c.txt', ver: 12, s: 3, i: 5 });
  });
});
