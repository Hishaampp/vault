import { describe, expect, it } from 'vitest';
import { snapshotOf } from '../localAdapter';
import { headlineOf, nodeLookup, objectHealthIn, overheadOf, pieceStateIn } from '../snapshot';
import { bytesOf, setup } from './testkit';

describe('snapshot helpers shared by the simulator and the live backend', () => {
  it('snapshotOf exposes nodes, objects, and metadata in the shared shape', async () => {
    const { cluster, advance } = setup();
    await cluster.putObject('a', bytesOf(600_000), 'ec42');
    await advance(100);
    const snap = snapshotOf(cluster);
    expect(snap.mode).toBe('simulated');
    expect(snap.nodes).toHaveLength(9);
    expect(snap.nodes.reduce((a, n) => a + n.pieceCount, 0)).toBe(12);
    expect(snap.meta.find((m) => m.leader)?.id).toBe('m1');
    expect(JSON.parse(JSON.stringify(snap)).objects[0].name).toBe('a'); // serializable, like the WebSocket feed
  });

  it('pieceStateIn and objectHealthIn follow node status', async () => {
    const { cluster, advance } = setup();
    const { obj } = await cluster.putObject('a', bytesOf(100_000), 'rep3');
    cluster.crashNode(obj!.segments[0].pieces[0].node!);
    await advance(100);
    const snap = snapshotOf(cluster);
    const nodes = nodeLookup(snap.nodes);
    expect(pieceStateIn(nodes, snap.objects[0].segments[0].pieces[0])).toBe('unavailable');
    expect(objectHealthIn(nodes, snap.objects[0]).worst).toBe('deg');
  });

  it('headlineOf covers every cluster condition', () => {
    const base = snapshotOf(setup().cluster);
    expect(headlineOf({ ...base, ready: false }).text).toMatch(/Starting/);
    expect(headlineOf({ ...base, ready: true, objects: [] }).text).toBe('All 0 objects fully protected');
    expect(headlineOf({ ...base, ready: true, quorum: false }).tone).toBe('bad');
    expect(headlineOf({ ...base, ready: true, unreadable: ['x'] }).text).toMatch(/1 object is unreadable/);
    expect(headlineOf({ ...base, ready: true, degraded: 3 }).tone).toBe('warn');
  });

  it('overheadOf reports raw bytes per policy', async () => {
    const { cluster } = setup();
    await cluster.putObject('r', bytesOf(1000), 'rep2');
    const o = overheadOf([...cluster.objects.values()]);
    expect(o.rows[0]).toMatchObject({ policy: 'rep2', objects: 1, logical: 1000, raw: 2000 });
  });
});
