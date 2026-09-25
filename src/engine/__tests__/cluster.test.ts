import { describe, expect, it } from 'vitest';
import { ELECTION_TIMEOUT, pieceKey } from '../cluster';
import { POLICIES, faultTolerance, minNeeded, pieceCount, writeQuorum } from '../policies';
import { bytesOf, fullyProtected, sameBytes, setup } from './testkit';

const MB = 1024 * 1024;

describe('policies', () => {
  it('have the expected piece counts, quorums, and fault tolerance', () => {
    expect([pieceCount(POLICIES.rep3), writeQuorum(POLICIES.rep3), faultTolerance(POLICIES.rep3)]).toEqual([3, 2, 2]);
    expect([pieceCount(POLICIES.rep2), writeQuorum(POLICIES.rep2), faultTolerance(POLICIES.rep2)]).toEqual([2, 2, 1]);
    expect([pieceCount(POLICIES.ec42), writeQuorum(POLICIES.ec42), faultTolerance(POLICIES.ec42)]).toEqual([6, 5, 2]);
    expect(minNeeded(POLICIES.ec42)).toBe(4);
  });
});

describe('write and read path', () => {
  it.each(['rep3', 'rep2', 'ec42'] as const)('round-trips bytes exactly with %s', async (pol) => {
    const { cluster } = setup();
    const data = bytesOf(Math.round(1.3 * MB), 5);
    const w = await cluster.putObject('file.bin', data, pol);
    expect(w.ok).toBe(true);
    const r = await cluster.readObject('file.bin');
    expect(r.ok).toBe(true);
    expect(sameBytes(r.bytes, data)).toBe(true);
    expect(r.sha).toBe(r.expected);
  });

  it('handles an empty object', async () => {
    const { cluster } = setup();
    expect((await cluster.putObject('empty', new Uint8Array(0), 'ec42')).ok).toBe(true);
    const r = await cluster.readObject('empty');
    expect(r.ok).toBe(true);
    expect(r.size).toBe(0);
  });

  it('splits objects into segments of the policy size', async () => {
    const { cluster } = setup();
    const w = await cluster.putObject('big', bytesOf(MB + 10), 'rep3');
    expect(w.obj!.segments).toHaveLength(Math.ceil((MB + 10) / POLICIES.rep3.seg));
  });

  it('spreads replicas of each segment across different racks', async () => {
    const { cluster } = setup();
    const { obj } = await cluster.putObject('spread', bytesOf(MB), 'rep3');
    for (const sg of obj!.segments) {
      const racks = sg.pieces.map((p) => cluster.nodeById(p.node)!.rack);
      expect(new Set(racks).size).toBe(3);
    }
  });

  it('never puts two pieces of one erasure-coded segment on the same node', async () => {
    const { cluster } = setup();
    const { obj } = await cluster.putObject('ec', bytesOf(2 * MB), 'ec42');
    for (const sg of obj!.segments) expect(new Set(sg.pieces.map((p) => p.node)).size).toBe(6);
  });

  it('erasure coding stores about 1.5x the data while replication stores 3x', async () => {
    const { cluster } = setup();
    await cluster.putObject('a', bytesOf(2 * MB), 'ec42');
    await cluster.putObject('b', bytesOf(2 * MB), 'rep3');
    const rows = Object.fromEntries(cluster.overhead().rows.map((r) => [r.policy, r.raw / r.logical]));
    expect(rows.ec42).toBeCloseTo(1.5, 2);
    expect(rows.rep3).toBeCloseTo(3, 5);
  });

  it('reports a missing object instead of throwing', async () => {
    const { cluster } = setup();
    const r = await cluster.readObject('nope');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/does not exist/);
  });

  it('delete removes every stored piece', async () => {
    const { cluster } = setup();
    await cluster.putObject('gone', bytesOf(MB), 'ec42');
    expect(cluster.deleteObject('gone')).toBe(true);
    expect(cluster.nodes.every((n) => n.store.size === 0)).toBe(true);
    expect(cluster.deleteObject('gone')).toBe(false);
  });
});

describe('versioning and concurrent writes', () => {
  it('an overwrite creates a new version and garbage-collects the old pieces', async () => {
    const { cluster } = setup();
    await cluster.putObject('doc', bytesOf(300_000, 1), 'rep3');
    const v2 = bytesOf(300_000, 2);
    const w = await cluster.putObject('doc', v2, 'rep3');
    expect(w.obj!.version).toBe(2);
    const keys = cluster.nodes.flatMap((n) => [...n.store.keys()]);
    expect(keys.every((k) => k.startsWith('doc@2#'))).toBe(true);
    expect(sameBytes((await cluster.readObject('doc')).bytes, v2)).toBe(true);
  });

  it('concurrent writers to one key end with exactly one winner (last writer wins)', async () => {
    const { cluster } = setup();
    const results = await Promise.all([1, 2, 3, 4, 5].map((i) => cluster.putObject('hot', bytesOf(40_000, i), 'rep3')));
    const obj = cluster.objects.get('hot')!;
    expect(obj.version).toBe(5);
    expect(results.filter((r) => r.ok).length).toBeGreaterThanOrEqual(1);
    const r = await cluster.readObject('hot');
    expect(r.ok).toBe(true);
    expect(sameBytes(r.bytes, bytesOf(40_000, 5))).toBe(true);
    const stray = cluster.nodes.flatMap((n) => [...n.store.keys()]).filter((k) => !k.startsWith('hot@5#'));
    expect(stray).toEqual([]);
  });
});

describe('write quorum and metadata consensus', () => {
  it('rejects writes when metadata has lost quorum, and resumes after re-election', async () => {
    const { cluster, advance } = setup();
    cluster.toggleMeta('m1');
    cluster.toggleMeta('m2');
    await advance(1000);
    expect(cluster.hasQuorum()).toBe(false);
    const w = await cluster.putObject('x', bytesOf(1000), 'rep3');
    expect(w.ok).toBe(false);
    expect(w.reason).toMatch(/quorum/i);

    cluster.toggleMeta('m2');
    await advance(ELECTION_TIMEOUT + 200);
    expect(cluster.hasQuorum()).toBe(true);
    expect(cluster.term).toBeGreaterThan(1);
    expect((await cluster.putObject('x', bytesOf(1000), 'rep3')).ok).toBe(true);
  });

  it('elects a new leader when the leader crashes, keeping quorum with 2 of 3', async () => {
    const { cluster, advance } = setup();
    expect(cluster.leader).toBe('m1');
    cluster.toggleMeta('m1');
    await advance(ELECTION_TIMEOUT + 200);
    expect(['m2', 'm3']).toContain(cluster.leader);
    expect(cluster.term).toBe(2);
  });

  it('rejects a write and rolls back when too few healthy nodes exist for the quorum', async () => {
    const { cluster, advance } = setup();
    ['n1', 'n2', 'n3', 'n4', 'n5'].forEach((id) => cluster.crashNode(id));
    await advance(6000);
    const w = await cluster.putObject('ec', bytesOf(100_000), 'ec42');
    expect(w.ok).toBe(false);
    expect(w.reason).toMatch(/write quorum is 5/);
    expect(cluster.objects.has('ec')).toBe(false);
    expect(cluster.nodes.every((n) => n.store.size === 0)).toBe(true);
  });

  it('accepts a write with the quorum met and backfills the missing piece later', async () => {
    const { cluster, advance, until } = setup();
    cluster.crashNode('n1');
    // crashed moments ago: the gateway still believes n1 is healthy and tries it
    const w = await cluster.putObject('partial', bytesOf(200_000), 'rep3');
    expect(w.ok).toBe(true);
    cluster.restartNode('n1');
    await advance(200);
    await until(() => fullyProtected(cluster));
    expect(w.obj!.segments.every((sg) => sg.pieces.every((p) => p.node !== null))).toBe(true);
  });
});

describe('failure detection', () => {
  it('moves a crashed node through suspect to dead on schedule', async () => {
    const { cluster, advance } = setup({ deadTimeout: 4000 });
    cluster.crashNode('n4');
    await advance(1000);
    expect(cluster.nodeById('n4')!.status).toBe('healthy');
    await advance(1000);
    expect(cluster.nodeById('n4')!.status).toBe('suspect');
    await advance(2100);
    expect(cluster.nodeById('n4')!.status).toBe('dead');
  });

  it('a brief blip shorter than the dead timeout triggers no repairs', async () => {
    const { cluster, advance } = setup();
    await cluster.putObject('f', bytesOf(MB), 'ec42');
    cluster.crashNode('n2');
    await advance(2500);
    cluster.restartNode('n2');
    await advance(500);
    expect(cluster.nodeById('n2')!.status).toBe('healthy');
    expect(cluster.stats.repaired).toBe(0);
    expect(fullyProtected(cluster)).toBe(true);
  });
});

describe('self-healing', () => {
  it('rebuilds every piece from a dead node and returns to full protection', async () => {
    const { cluster, until } = setup();
    await cluster.putObject('ec', bytesOf(2 * MB, 1), 'ec42');
    await cluster.putObject('rep', bytesOf(MB, 2), 'rep3');
    const lost = cluster.countRefs('n5');
    expect(lost).toBeGreaterThan(0);
    cluster.crashNode('n5');
    await until(() => cluster.nodeById('n5')!.status === 'dead');
    await until(() => fullyProtected(cluster));
    expect(cluster.countRefs('n5')).toBe(0);
    expect(cluster.stats.repaired).toBe(lost);
    expect(cluster.recovery.last).toBeGreaterThan(0);
    expect(sameBytes((await cluster.readObject('ec')).bytes, bytesOf(2 * MB, 1))).toBe(true);
    expect(sameBytes((await cluster.readObject('rep')).bytes, bytesOf(MB, 2))).toBe(true);
  });

  it('erasure-coded data stays readable with two nodes down, before any repair', async () => {
    const { cluster } = setup();
    const data = bytesOf(2 * MB, 8);
    const { obj } = await cluster.putObject('ec', data, 'ec42');
    const holders = obj!.segments[0].pieces.slice(0, 2).map((p) => p.node!); // two data shards
    holders.forEach((id) => cluster.crashNode(id));
    const r = await cluster.readObject('ec');
    expect(r.ok).toBe(true);
    expect(r.decoded).toBeGreaterThan(0);
    expect(sameBytes(r.bytes, data)).toBe(true);
  });

  it('repairs the most at-risk segment first', async () => {
    const { cluster, until } = setup({ concurrency: 1 });
    for (let i = 0; i < 6; i++) await cluster.putObject(`o${i}`, bytesOf(300_000, i), 'rep3');
    cluster.crashNode('n1');
    cluster.crashNode('n2');
    await until(() => cluster.inflight.length > 0);
    const started = cluster.inflight[0].job;
    const startedPri = cluster.jobPriority(started);
    for (const j of cluster.queue) expect(startedPri).toBeLessThanOrEqual(cluster.jobPriority(j));
  });

  it('repair respects the parallel-repair limit', async () => {
    const { cluster, advance } = setup({ concurrency: 2 });
    await cluster.putObject('f', bytesOf(3 * MB), 'ec42');
    cluster.crashNode('n3');
    let peak = 0;
    for (let i = 0; i < 150; i++) { await advance(100); peak = Math.max(peak, cluster.inflight.length); }
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(0);
  });

  it('pauses repairs while metadata quorum is lost', async () => {
    const { cluster, advance, until } = setup();
    const { obj } = await cluster.putObject('f', bytesOf(MB), 'ec42');
    cluster.toggleMeta('m1');
    cluster.toggleMeta('m2');
    cluster.crashNode(obj!.segments[0].pieces[0].node!);
    await advance(7000);
    expect(cluster.stats.repaired).toBe(0);
    expect(cluster.queue.length).toBeGreaterThan(0);
    cluster.toggleMeta('m1');
    await until(() => fullyProtected(cluster));
    expect(cluster.stats.repaired).toBeGreaterThan(0);
  });

  it('honestly reports data as unreadable when too many holders die, then recovers when they return', async () => {
    const { cluster, advance, until } = setup();
    const { obj } = await cluster.putObject('fragile', bytesOf(100_000), 'rep2');
    const holders = obj!.segments[0].pieces.map((p) => p.node!);
    holders.forEach((id) => cluster.crashNode(id));
    await advance(6000);
    expect(cluster.unreadable.has('fragile')).toBe(true);
    expect((await cluster.readObject('fragile')).ok).toBe(false);
    holders.forEach((id) => cluster.restartNode(id));
    await until(() => fullyProtected(cluster));
    expect(cluster.unreadable.size).toBe(0);
    expect((await cluster.readObject('fragile')).ok).toBe(true);
  });

  it('reclaims stale pieces when a dead node rejoins', async () => {
    const { cluster, until, advance } = setup();
    await cluster.putObject('f', bytesOf(2 * MB), 'ec42');
    const had = cluster.nodeById('n7')!.store.size;
    expect(had).toBeGreaterThan(0);
    cluster.crashNode('n7');
    await until(() => cluster.nodeById('n7')!.status === 'dead');
    await until(() => fullyProtected(cluster));
    expect(cluster.nodeById('n7')!.store.size).toBe(had); // still on its disk, but unreferenced
    cluster.restartNode('n7');
    await advance(200);
    expect(cluster.nodeById('n7')!.store.size).toBe(0);
    expect(cluster.log.some((e) => /reclaimed \d+ stale pieces/.test(e.msg))).toBe(true);
  });
});

describe('integrity: bit rot', () => {
  it('the scrubber detects silent corruption and it gets rewritten in place', async () => {
    const { cluster, until } = setup({ scrub: true });
    const data = bytesOf(MB, 4);
    await cluster.putObject('f', data, 'ec42');
    const key = cluster.injectRot('n1')!;
    expect(key).toBeTruthy();
    expect(cluster.silentRotCount()).toBe(1);
    await until(() => cluster.scrub.found === 1);
    await until(() => fullyProtected(cluster) && cluster.nodeById('n1')!.store.get(key)?.rot === false);
    expect(cluster.silentRotCount()).toBe(0);
    expect(cluster.log.some((e) => e.kind === 'repair' && e.msg.includes('Rewrote a corrupt piece'))).toBe(true);
    expect(sameBytes((await cluster.readObject('f')).bytes, data)).toBe(true);
  });

  it('a read that hits a corrupt replica still returns correct data and flags the piece', async () => {
    const { cluster } = setup();
    const data = bytesOf(200_000, 6);
    const { obj } = await cluster.putObject('f', data, 'rep3');
    const first = obj!.segments[0].pieces[0];
    const node = cluster.nodeById(first.node)!;
    const key = pieceKey('f', 1, 0, 0);
    node.store.get(key)!.bytes[10] ^= 0xff;
    const r = await cluster.readObject('f');
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(1);
    expect(sameBytes(r.bytes, data)).toBe(true);
    expect(first.corrupt).toBe(true);
  });

  it('never serves corrupt data: corrupting an erasure-coded shard still yields exact bytes', async () => {
    const { cluster } = setup();
    const data = bytesOf(MB, 12);
    const { obj } = await cluster.putObject('f', data, 'ec42');
    const p = obj!.segments[1].pieces[2];
    cluster.nodeById(p.node)!.store.get(pieceKey('f', 1, 1, 2))!.bytes[0] ^= 0x80;
    const r = await cluster.readObject('f');
    expect(r.ok).toBe(true);
    expect(sameBytes(r.bytes, data)).toBe(true);
    expect(r.decoded).toBeGreaterThan(0);
  });

  it('injected rot really changes the bytes', async () => {
    const { cluster } = setup();
    await cluster.putObject('f', bytesOf(50_000), 'rep3');
    const before = new Map([...cluster.nodeById('n2')!.store].map(([k, e]) => [k, e.bytes.slice()]));
    const key = cluster.injectRot('n2');
    if (key) expect(cluster.nodeById('n2')!.store.get(key)!.bytes).not.toEqual(before.get(key));
  });
});

describe('rack-aware placement', () => {
  it('spreads each 4+2 segment 2-2-2 across racks', async () => {
    const { cluster } = setup();
    const { obj } = await cluster.putObject('ec', bytesOf(3 * MB), 'ec42');
    for (const sg of obj!.segments) {
      const perRack = new Map<string, number>();
      for (const p of sg.pieces) { const r = cluster.nodeById(p.node)!.rack; perRack.set(r, (perRack.get(r) ?? 0) + 1); }
      expect([...perRack.values()]).toEqual([2, 2, 2]);
    }
  });

  it.each(['A', 'B', 'C'])('survives losing all of rack %s at once, with no repair', async (rack) => {
    const { cluster } = setup();
    const data = bytesOf(3 * MB, 33);
    await cluster.putObject('ec', data, 'ec42');
    await cluster.putObject('rep', bytesOf(MB, 34), 'rep3');
    cluster.nodes.filter((n) => n.rack === rack).forEach((n) => cluster.crashNode(n.id));
    const ec = await cluster.readObject('ec');
    expect(ec.ok).toBe(true);
    expect(sameBytes(ec.bytes, data)).toBe(true);
    expect((await cluster.readObject('rep')).ok).toBe(true);
  });
});

describe('network partitions', () => {
  it('isolating rack C makes its nodes unreachable and re-elects metadata if needed', async () => {
    const { cluster, advance } = setup();
    cluster.toggleMeta('m1');
    await advance(ELECTION_TIMEOUT + 200);
    cluster.setIsolated(true);
    await advance(ELECTION_TIMEOUT + 2000);
    for (const n of cluster.nodes.filter((x) => x.rack === 'C')) expect(n.status).toBe('unreachable');
    // m1 crashed and m3 is cut off: only m2 remains, so quorum is lost
    expect(cluster.hasQuorum()).toBe(false);
    cluster.setIsolated(false);
    await advance(ELECTION_TIMEOUT + 200);
    expect(cluster.hasQuorum()).toBe(true);
  });

  it('data survives a partition and the cluster converges after healing', async () => {
    const { cluster, until, advance } = setup();
    const data = bytesOf(2 * MB, 21);
    await cluster.putObject('f', data, 'ec42');
    cluster.setIsolated(true);
    await until(() => cluster.nodes.filter((n) => n.rack === 'C').every((n) => n.status === 'dead'));
    await until(() => fullyProtected(cluster));
    expect(sameBytes((await cluster.readObject('f')).bytes, data)).toBe(true);
    cluster.setIsolated(false);
    await advance(300);
    // the returning rack holds only stale copies, which are reclaimed
    for (const n of cluster.nodes.filter((x) => x.rack === 'C')) expect(n.store.size).toBe(0);
    expect(sameBytes((await cluster.readObject('f')).bytes, data)).toBe(true);
  });
});

describe('rebalancing', () => {
  it('a new node receives a fair share while most data stays put', async () => {
    const { cluster, until } = setup();
    for (let i = 0; i < 4; i++) await cluster.putObject(`o${i}`, bytesOf(MB, i), 'ec42');
    const total = cluster.nodes.reduce((a, n) => a + n.store.size, 0);
    const nn = cluster.addNode();
    await until(() => fullyProtected(cluster));
    const moved = nn.store.size;
    expect(moved).toBeGreaterThan(0);
    expect(moved / total).toBeLessThan(0.2); // roughly 1/(N+1) of the pieces
    for (let i = 0; i < 4; i++) expect(sameBytes((await cluster.readObject(`o${i}`)).bytes, bytesOf(MB, i))).toBe(true);
    // rack-diversity is preserved for erasure-coded segments
    for (const o of cluster.objects.values()) for (const sg of o.segments) expect(new Set(sg.pieces.map((p) => p.node)).size).toBe(6);
  });
});

describe('observability', () => {
  it('headline reflects cluster health', async () => {
    const { cluster, advance } = setup();
    await cluster.putObject('a', bytesOf(1000), 'rep3');
    await cluster.putObject('b', bytesOf(1000), 'rep3');
    await advance(100);
    expect(cluster.headline()).toEqual({ tone: 'ok', text: 'All 2 objects fully protected' });
    cluster.crashNode('n1');
    await advance(100);
    expect(cluster.headline().tone).toBe('warn');
    cluster.toggleMeta('m1');
    cluster.toggleMeta('m2');
    await advance(100);
    expect(cluster.headline().tone).toBe('bad');
  });

  it('samples throughput and latency once per second under simulated traffic', async () => {
    const { cluster, advance } = setup({ traffic: true });
    await cluster.putObject('a', bytesOf(100_000), 'rep3');
    await advance(3100);
    expect(cluster.series.t.length).toBe(3);
    expect(cluster.series.rps.every((v) => v > 0)).toBe(true);
    expect(cluster.series.p99.every((v) => v > 0)).toBe(true);
  });

  it('crashes are marked on the charts', () => {
    const { cluster } = setup();
    cluster.crashNode('n1');
    expect(cluster.series.marks).toHaveLength(1);
  });
});
