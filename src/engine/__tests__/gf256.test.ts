import { describe, expect, it } from 'vitest';
import { ecEncode, ecRebuild, encMatrix, ginv, gmul, invertMat } from '../gf256';
import { bytesOf } from './testkit';

describe('GF(256) arithmetic', () => {
  it('every non-zero element times its inverse is 1', () => {
    for (let a = 1; a < 256; a++) expect(gmul(a, ginv(a))).toBe(1);
  });

  it('multiplication is commutative and zero absorbs', () => {
    for (let a = 0; a < 256; a += 7) {
      expect(gmul(a, 0)).toBe(0);
      for (let b = 0; b < 256; b += 11) expect(gmul(a, b)).toBe(gmul(b, a));
    }
  });

  it('distributes over addition (XOR)', () => {
    for (let a = 1; a < 256; a += 13) for (let b = 0; b < 256; b += 17) for (let c = 0; c < 256; c += 19) {
      expect(gmul(a, b ^ c)).toBe(gmul(a, b) ^ gmul(a, c));
    }
  });

  it('refuses to invert zero', () => {
    expect(() => ginv(0)).toThrow(RangeError);
  });
});

describe('matrix inversion', () => {
  it('inverts the identity to itself', () => {
    const I = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    expect(invertMat(I)).toEqual(I);
  });

  it('detects a singular matrix', () => {
    expect(() => invertMat([[1, 2], [1, 2]])).toThrow('singular');
  });

  it('every k-row subset of the encoding matrix is invertible (MDS property)', () => {
    const M = encMatrix(4, 2);
    const rows = [0, 1, 2, 3, 4, 5];
    const subsets: number[][] = [];
    const pick = (start: number, acc: number[]) => {
      if (acc.length === 4) { subsets.push(acc); return; }
      for (let i = start; i < rows.length; i++) pick(i + 1, [...acc, rows[i]]);
    };
    pick(0, []);
    expect(subsets).toHaveLength(15);
    for (const s of subsets) expect(() => invertMat(s.map((r) => M[r]))).not.toThrow();
  });
});

describe('Reed-Solomon 4+2', () => {
  it('keeps data shards identical to the input (systematic code)', () => {
    const seg = bytesOf(4000, 3);
    const { shards, shardLen } = ecEncode(4, 2, seg);
    expect(shards).toHaveLength(6);
    const joined = new Uint8Array(4 * shardLen);
    shards.slice(0, 4).forEach((s, i) => joined.set(s, i * shardLen));
    expect(joined.subarray(0, seg.length)).toEqual(seg);
  });

  it('rebuilds every shard after losing any 2 of 6', () => {
    const seg = bytesOf(3001, 9);
    const { shards, shardLen } = ecEncode(4, 2, seg);
    for (let a = 0; a < 6; a++) for (let b = a + 1; b < 6; b++) {
      const avail = shards.map((bytes, idx) => ({ idx, bytes })).filter(({ idx }) => idx !== a && idx !== b);
      expect(ecRebuild(4, 2, avail, a, shardLen)).toEqual(shards[a]);
      expect(ecRebuild(4, 2, avail, b, shardLen)).toEqual(shards[b]);
    }
  });

  it('handles tiny and uneven segment sizes', () => {
    for (const len of [1, 2, 3, 5, 7, 1023]) {
      const { shards, shardLen } = ecEncode(4, 2, bytesOf(len, len));
      const avail = shards.slice(2).map((bytes, i) => ({ idx: i + 2, bytes }));
      expect(ecRebuild(4, 2, avail, 0, shardLen)).toEqual(shards[0]);
    }
  });

  it('fails loudly when fewer than k shards remain', () => {
    const { shards, shardLen } = ecEncode(4, 2, bytesOf(100));
    const avail = shards.slice(0, 3).map((bytes, idx) => ({ idx, bytes }));
    expect(() => ecRebuild(4, 2, avail, 5, shardLen)).toThrow('need 4 shards');
  });
});
