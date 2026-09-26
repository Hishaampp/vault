import { describe, expect, it } from 'vitest';
import { ecDecode, ecEncode, joinShards } from '../gf256';
import { parseKey, pieceKey } from '../keys';
import { pickRepairTarget, placeAcrossRacks, rackLoad } from '../placement';
import { bytesOf } from './testkit';

const nodes = Array.from({ length: 9 }, (_, i) => ({ id: `n${i + 1}`, rack: 'ABC'[i % 3] }));

describe('placeAcrossRacks', () => {
  it('spreads 6 pieces 2-2-2 over 3 racks, all on different nodes', () => {
    for (let k = 0; k < 200; k++) {
      const out = placeAcrossRacks(nodes, `obj${k}#0`, 6);
      expect(new Set(out.map((n) => n.id)).size).toBe(6);
      const perRack = ['A', 'B', 'C'].map((r) => out.filter((n) => n.rack === r).length);
      expect(perRack).toEqual([2, 2, 2]);
    }
  });

  it('is deterministic for a key and spreads load across nodes', () => {
    expect(placeAcrossRacks(nodes, 'x', 3)).toEqual(placeAcrossRacks(nodes, 'x', 3));
    const counts = new Map<string, number>();
    for (let k = 0; k < 900; k++) for (const n of placeAcrossRacks(nodes, `k${k}`, 3)) counts.set(n.id, (counts.get(n.id) ?? 0) + 1);
    for (const c of counts.values()) expect(c).toBeGreaterThan(200); // 300 expected each
  });

  it('adding a node moves only a small share of placements (rendezvous hashing)', () => {
    const more = [...nodes, { id: 'n10', rack: 'A' }];
    let moved = 0;
    for (let k = 0; k < 1000; k++) {
      const before = placeAcrossRacks(nodes, `k${k}`, 1)[0].id;
      const after = placeAcrossRacks(more, `k${k}`, 1)[0].id;
      if (before !== after) moved++;
    }
    expect(moved / 1000).toBeLessThan(0.2);
  });

  it('returns fewer nodes when not enough exist', () => {
    expect(placeAcrossRacks(nodes.slice(0, 2), 'k', 6)).toHaveLength(2);
    expect(placeAcrossRacks([], 'k', 3)).toEqual([]);
  });
});

describe('rackLoad and pickRepairTarget', () => {
  const rackOf = (id: string) => nodes.find((n) => n.id === id)?.rack;

  it('counts live pieces per rack, optionally excluding one', () => {
    const pieces = [{ node: 'n1' }, { node: 'n4' }, { node: 'n2' }, { node: null }];
    expect(rackLoad(pieces, rackOf)).toEqual(new Map([['A', 2], ['B', 1]]));
    expect(rackLoad(pieces, rackOf, 0)).toEqual(new Map([['A', 1], ['B', 1]]));
  });

  it('prefers the least-loaded rack, then the emptiest node, and never reuses a node', () => {
    const load = new Map([['A', 2], ['B', 2], ['C', 1]]);
    const refs = new Map([['n3', 10], ['n6', 2], ['n9', 5]]);
    const t = pickRepairTarget(nodes, new Set(['n1', 'n2']), load, refs, 'k');
    expect(t?.id).toBe('n6');
    expect(pickRepairTarget(nodes, new Set(nodes.map((n) => n.id)), load, refs, 'k')).toBeNull();
  });
});

describe('ecDecode', () => {
  it('recovers all data shards with one call for every 2-shard loss', () => {
    const seg = bytesOf(5000, 4);
    const { shards, shardLen } = ecEncode(4, 2, seg);
    for (let a = 0; a < 6; a++) for (let b = a + 1; b < 6; b++) {
      const avail = shards.map((bytes, idx) => ({ idx, bytes })).filter(({ idx }) => idx !== a && idx !== b);
      const data = ecDecode(4, 2, avail, shardLen);
      expect(Buffer.compare(Buffer.from(joinShards(data, shardLen, seg.length)), Buffer.from(seg))).toBe(0);
    }
  });

  it('returns surviving data shards without any math when none are missing', () => {
    const { shards, shardLen } = ecEncode(4, 2, bytesOf(100));
    const avail = shards.map((bytes, idx) => ({ idx, bytes }));
    const data = ecDecode(4, 2, avail, shardLen);
    data.forEach((d, i) => expect(d).toBe(shards[i]));
  });

  it('refuses when fewer than k shards remain', () => {
    const { shards, shardLen } = ecEncode(4, 2, bytesOf(100));
    expect(() => ecDecode(4, 2, shards.slice(0, 3).map((bytes, idx) => ({ idx, bytes })), shardLen)).toThrow('need 4 shards');
  });
});

describe('piece keys', () => {
  it('round-trip through pieceKey and parseKey', () => {
    expect(parseKey(pieceKey('a/b@c#d.txt', 7, 2, 5))).toEqual({ name: 'a/b@c#d.txt', ver: 7, s: 2, i: 5 });
  });
});