// @vitest-environment node
/**
 * End-to-end tests against a real cluster: every storage node and metadata
 * replica is a separate OS process storing real files in a temp directory.
 * Scenarios run in order against one cluster to keep the suite fast.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGateway } from '../gateway';
import { ClusterManager, pieceKey } from '../manager';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 20_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not reached in time');
    await sleep(50);
  }
}
const fullyProtected = (m: ClusterManager) => m.degraded === 0 && m.queue.length === 0 && m.flights.length === 0 && m.recovery.start === null;
const same = (a: Uint8Array | undefined, b: Uint8Array) => !!a && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

let dataDir: string;
let mgr: ClusterManager;
let server: Server;
let base: string;
const video = new Uint8Array(randomBytes(1_600_000));
const notes = new Uint8Array(randomBytes(300_000));

const options = () => ({ dataDir, nodes: 9, deadTimeout: 2000, bandwidth: 50, traffic: false, seed: false, quiet: true });

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'vault-cluster-'));
  mgr = new ClusterManager(options());
  await mgr.start();
  server = createGateway(mgr).server;
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}, 60_000);

afterAll(async () => {
  server?.close();
  await mgr?.stop();
  await rm(dataDir, { recursive: true, force: true });
});

describe('live multi-process cluster', () => {
  it('runs every node as its own OS process', () => {
    const pids = new Set([...mgr.nodes, ...mgr.metas].map((x) => x.proc?.pid));
    expect(pids.size).toBe(12);
    expect(pids.has(process.pid)).toBe(false);
  });

  it('accepts uploads over HTTP and returns identical bytes', async () => {
    const put = await fetch(`${base}/api/objects/${encodeURIComponent('media/video.mp4')}?policy=ec42`, { method: 'PUT', body: video });
    expect(put.status).toBe(201);
    expect((await put.json()).sha256).toBe(sha(video));
    expect((await mgr.putObject('docs/notes.txt', notes, 'rep3')).ok).toBe(true);
    const get = await fetch(`${base}/api/objects/${encodeURIComponent('media/video.mp4')}`);
    expect(get.headers.get('x-vault-sha256')).toBe(sha(video));
    expect(same(new Uint8Array(await get.arrayBuffer()), video)).toBe(true);
  });

  it('stores every piece as a real file whose checksum matches metadata', async () => {
    const o = mgr.objects.get('media/video.mp4')!;
    const p = o.segments[0].pieces[5];
    const file = join(dataDir, p.node!, encodeURIComponent(pieceKey(o.name, o.version, 0, 5)));
    expect(sha(new Uint8Array(await readFile(file)))).toBe(p.sum);
  });

  it('rejects unknown policies and missing objects with clear errors', async () => {
    const bad = await fetch(`${base}/api/objects/x?policy=raid0`, { method: 'PUT', body: 'x' });
    expect(bad.status).toBe(400);
    expect((await fetch(`${base}/api/objects/nope`)).status).toBe(404);
  });

  it('survives two SIGKILLed processes, then rebuilds their data elsewhere', async () => {
    const o = mgr.objects.get('media/video.mp4')!;
    const victims = [o.segments[0].pieces[0].node!, o.segments[0].pieces[1].node!];
    const procs = victims.map((id) => mgr.nodeById(id)!.proc!);
    victims.forEach((id) => mgr.crashNode(id));
    await until(() => procs.every((p) => p.signalCode === 'SIGKILL'));

    const r = await mgr.readObject('media/video.mp4');
    expect(r.ok).toBe(true);
    expect(r.decoded).toBeGreaterThan(0);
    expect(same(r.bytes, video)).toBe(true);

    await until(() => victims.every((id) => mgr.nodeById(id)!.status === 'dead'));
    await until(() => fullyProtected(mgr));
    for (const id of victims) expect(mgr.countRefs(id)).toBe(0);
    expect(mgr.repaired).toBeGreaterThan(0);
    expect(same((await mgr.readObject('docs/notes.txt')).bytes, notes)).toBe(true);

    victims.forEach((id) => mgr.restartNode(id));
    await until(() => victims.every((id) => mgr.nodeById(id)!.status === 'healthy'));
    await until(() => victims.every((id) => [...mgr.nodeById(id)!.keys].every((k) => mgr.refPiece(id, k))));
  }, 40_000);

  it('detects bit rot on a real disk and rewrites the piece in place', async () => {
    await until(() => fullyProtected(mgr));
    const holder = mgr.nodes.find((n) => n.status === 'healthy' && [...n.keys].some((k) => mgr.refPiece(n.id, k) && k.startsWith('media/video.mp4@')))!;
    const before = mgr.scrubFound;
    const key = await mgr.injectRot(holder.id);
    expect(key).toBeTruthy();
    const p = mgr.refPiece(holder.id, key!)!;
    const file = join(dataDir, holder.id, encodeURIComponent(key!));
    expect(sha(new Uint8Array(await readFile(file)))).not.toBe(p.sum);
    await until(() => mgr.scrubFound > before && !p.corrupt && fullyProtected(mgr));
    expect(p.node).toBe(holder.id);
    expect(sha(new Uint8Array(await readFile(file)))).toBe(p.sum);
    expect(same((await mgr.readObject('media/video.mp4')).bytes, video)).toBe(true);
  }, 30_000);

  it('pauses writes without metadata quorum while reads keep working', async () => {
    mgr.toggleMeta('m1');
    mgr.toggleMeta('m2');
    await until(() => !mgr.hasQuorum());
    const w = await mgr.putObject('blocked.txt', new Uint8Array([1, 2, 3]), 'rep3');
    expect(w.ok).toBe(false);
    expect(w.reason).toMatch(/quorum/i);
    expect(same((await mgr.readObject('docs/notes.txt')).bytes, notes)).toBe(true);
    mgr.toggleMeta('m1');
    mgr.toggleMeta('m2');
    await until(() => mgr.hasQuorum());
    expect((await mgr.putObject('unblocked.txt', new Uint8Array([4, 5, 6]), 'rep3')).ok).toBe(true);
  }, 30_000);

  it('keeps data readable while a whole rack is partitioned away', async () => {
    mgr.setIsolated(true);
    await sleep(300);
    const r = await mgr.readObject('media/video.mp4');
    expect(r.ok).toBe(true);
    expect(same(r.bytes, video)).toBe(true);
    mgr.setIsolated(false);
    await until(() => mgr.nodes.every((n) => n.status === 'healthy'));
    await until(() => fullyProtected(mgr));
  }, 30_000);

  it('recovers all metadata from the replicas after the whole cluster restarts', async () => {
    const names = [...mgr.objects.keys()].sort();
    server.close();
    await mgr.stop();
    mgr = new ClusterManager(options());
    await mgr.start();
    expect([...mgr.objects.keys()].sort()).toEqual(names);
    expect(same((await mgr.readObject('media/video.mp4')).bytes, video)).toBe(true);
    expect(same((await mgr.readObject('docs/notes.txt')).bytes, notes)).toBe(true);
  }, 60_000);
});
