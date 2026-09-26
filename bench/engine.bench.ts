/**
 * Performance benchmarks for the storage engine hot paths.
 * Run with: npm run bench
 */
import { createHash } from 'node:crypto';
import { bench, describe } from 'vitest';
import { ecDecode, ecEncode, encMatrix, invertMat, joinShards, mulRow } from '../src/engine/gf256';
import { placeAcrossRacks } from '../src/engine/placement';

const SEG = 512 * 1024; // one erasure-coded segment
const seg = new Uint8Array(SEG).map((_, i) => (i * 131 + 7) & 255);
const { shards, shardLen } = ecEncode(4, 2, seg);
// worst case: two data shards lost, decode from 2 data + 2 parity
const survivors = [2, 3, 4, 5].map((idx) => ({ idx, bytes: shards[idx] }));

/**
 * The previous read path, reproduced faithfully: for each missing data shard it called
 * the old ecRebuild, which inverted the matrix and rebuilt every missing shard, then
 * returned just one. Losing 2 shards therefore did 4 row reconstructions instead of 2.
 */
function oldEcRebuild(idx: number) {
  const M = encMatrix(4, 2);
  const inv = invertMat(survivors.map((s) => M[s.idx]));
  const srcs = survivors.map((s) => s.bytes);
  const data: Uint8Array[] = [];
  for (let j = 0; j < 4; j++) {
    const have = survivors.find((s) => s.idx === j);
    data.push(have ? have.bytes : mulRow(inv[j], srcs, shardLen));
  }
  return data[idx];
}
function decodePreviousReadPath() {
  const out = new Uint8Array(4 * shardLen);
  for (let j = 0; j < 4; j++) {
    const have = survivors.find((s) => s.idx === j);
    out.set(have ? have.bytes : oldEcRebuild(j), j * shardLen);
  }
  return out;
}

describe('erasure coding (512 KB segment, 4+2)', () => {
  bench('encode', () => { ecEncode(4, 2, seg); });
  bench('decode after losing 2 data shards (single cached inversion)', () => {
    joinShards(ecDecode(4, 2, survivors, shardLen), shardLen, SEG);
  });
  bench('decode after losing 2 data shards (previous read path)', () => { decodePreviousReadPath(); });
  bench('decode with no losses (fast path)', () => {
    ecDecode(4, 2, shards.slice(0, 4).map((bytes, idx) => ({ idx, bytes })), shardLen);
  });
});

/* ---- repair scheduling: choosing a target node for one missing piece ---- */
// 30 nodes and 10,000 stored pieces (about 1.3 GB of 4+2 data)
const sched = Array.from({ length: 30 }, (_, i) => ({ id: `n${i}`, rack: 'ABC'[i % 3] }));
const pieces = Array.from({ length: 10_000 }, (_, i) => ({ node: `n${(i * 7) % 30}` }));
const countRefs = (id: string) => { let c = 0; for (const p of pieces) if (p.node === id) c++; return c; };

describe('repair scheduling (30 nodes, 10,000 pieces)', () => {
  bench('previous: count references inside the sort comparator', () => {
    [...sched].sort((a, b) => countRefs(a.id) - countRefs(b.id));
  });
  bench('now: count references once, then sort', () => {
    const refs = new Map<string, number>();
    for (const p of pieces) refs.set(p.node, (refs.get(p.node) ?? 0) + 1);
    [...sched].sort((a, b) => (refs.get(a.id) ?? 0) - (refs.get(b.id) ?? 0));
  });
});

describe('integrity', () => {
  bench('SHA-256 of a 128 KB piece', () => { createHash('sha256').update(shards[0]).digest('hex'); });
});

describe('placement', () => {
  const nodes = Array.from({ length: 30 }, (_, i) => ({ id: `n${i}`, rack: 'ABC'[i % 3] }));
  let k = 0;
  bench('place 6 pieces across 30 nodes', () => { placeAcrossRacks(nodes, `obj-${k++}#0`, 6); });
});