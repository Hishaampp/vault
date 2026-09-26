/**
 * The cluster manager (control plane + gateway logic).
 *
 * It supervises real OS processes (storage nodes and metadata replicas),
 * talks to them over HTTP, detects failures with heartbeats, and runs the
 * write path, read path, repair queue, rebalancer, and background traffic.
 */
import { fork, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fmtBytes, fmtSecs } from '../src/engine/format';
import { ecDecode, ecEncode, ecRebuild, joinShards } from '../src/engine/gf256';
import { hash32 } from '../src/engine/hash';
import { POLICIES, minNeeded, pieceCount, writeQuorum } from '../src/engine/policies';
import { emptySeries, type ClusterSnapshot, type LiveSettings, type NodeInfo } from '../src/engine/snapshot';
import type { LogEntry, LogKind, NodeStatus, PieceMeta, PolicyKey, ReadResult, Segment, VaultObject, WriteResult } from '../src/engine/types';
import { parseKey, pieceKey } from '../src/engine/cluster';
import { pickRepairTarget, placeAcrossRacks, rackLoad } from '../src/engine/placement';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STORAGE_SCRIPT = join(ROOT, 'server', 'storageNode.ts');
const META_SCRIPT = join(ROOT, 'server', 'metaNode.ts');
export const RACKS = ['A', 'B', 'C'];
const SUSPECT_AFTER = 1500;
const HUES = ['#5B8DEF', '#C9A15B', '#D9779C', '#4FB3C8', '#9AAE5A', '#E08E6D', '#8FA0B8', '#B98BDB'];

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const enc = encodeURIComponent;
export { parseKey, pieceKey };

/** Run async work over items with at most `limit` in flight. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => res(port));
    });
  });
}

interface Endpoint { port: number; reachable: boolean }

interface NodeRec extends Endpoint {
  id: string;
  rack: string;
  dir: string;
  proc: ChildProcess | null;
  up: boolean;
  lastBeat: number;
  status: NodeStatus;
  keys: Set<string>;
  bytes: number;
  reported: Set<string>;
  scrub: { enabled: boolean; passes: number; found: number; progress: number };
  busy: boolean;
  pendingRebalance: boolean;
  /** answered at least one heartbeat */
  seen: boolean;
}

interface MetaRec extends Endpoint {
  id: string;
  rack: string;
  dir: string;
  proc: ChildProcess | null;
  up: boolean;
  lastBeat: number;
  alive: boolean;
  busy: boolean;
}

interface Job { kind: 'repair' | 'move'; key: string; obj: string; ver: number; s: number; idx: number; from?: string; to?: string; added: number; pri?: number }
interface Flight { job: Job; srcs: { idx: number; node: string }[]; target: string; inPlace: boolean; t0: number; dur: number }

export interface ManagerOptions {
  dataDir: string;
  nodes?: number;
  deadTimeout?: number;
  concurrency?: number;
  bandwidth?: number;
  traffic?: boolean;
  scrub?: boolean;
  seed?: boolean;
  /** silence child process output */
  quiet?: boolean;
  /** shared secret for manager-to-node calls (random per start if omitted) */
  nodeToken?: string;
}

export class ClusterManager {
  readonly startedAt = performance.now();
  nodes: NodeRec[] = [];
  metas: MetaRec[] = [];
  objects = new Map<string, VaultObject>();
  settings: LiveSettings;
  isolated = false;
  log: LogEntry[] = [];
  series = emptySeries();
  queue: Job[] = [];
  flights: Flight[] = [];
  recovery: { start: number | null; last: number | null } = { start: null, last: null };
  degraded = 0;
  atRisk = 0;
  unreadable = new Set<string>();
  repaired = 0;
  scrubFound = 0;
  ready = false;

  private jobKeys = new Set<string>();
  private verSeq = new Map<string, number>();
  private hues = new Map<string, string>();
  private hueIdx = 0;
  private metaRev = 0;
  private logSeq = 0;
  /** demo god-view of injected corruption: `${node}|${key}`; never used by repair logic */
  private ledger = new Set<string>();
  private stats = { reads: 0, writes: 0, fails: 0, lat: [] as number[] };
  private lastSample = performance.now();
  private lastWrite = performance.now();
  private writing = false;
  private trafficInflight = 0;
  private quorumWas = true;
  private timers: NodeJS.Timeout[] = [];
  private stopped = false;
  /** Secret every storage node and metadata replica requires; never leaves this machine. */
  private readonly nodeToken: string;
  private refsThisPass: Map<string, number> | null = null;

  constructor(private opts: ManagerOptions) {
    this.nodeToken = opts.nodeToken ?? randomBytes(32).toString('hex');
    this.settings = {
      policy: 'ec42',
      deadTimeout: opts.deadTimeout ?? 5000,
      concurrency: opts.concurrency ?? 4,
      scrub: opts.scrub ?? true,
      traffic: opts.traffic ?? true,
      bandwidth: opts.bandwidth ?? 1,
    };
  }

  now() { return performance.now(); }

  /* ---------------------------------------------------------------- lifecycle */

  async start(): Promise<void> {
    const count = this.opts.nodes ?? 9;
    for (let i = 0; i < 3; i++) {
      const m: MetaRec = { id: `m${i + 1}`, rack: RACKS[i], dir: join(this.opts.dataDir, `m${i + 1}`), port: await freePort(), reachable: true, proc: null, up: false, lastBeat: 0, alive: false, busy: false };
      this.metas.push(m);
      this.spawnMeta(m);
    }
    for (let i = 0; i < count; i++) {
      const n = this.makeNode(`n${i + 1}`, RACKS[i % RACKS.length], await freePort());
      this.nodes.push(n);
      this.spawnNode(n);
    }
    this.timers.push(setInterval(() => this.nodes.forEach((n) => this.beat(n)), 250));
    this.timers.push(setInterval(() => this.metas.forEach((m) => this.beatMeta(m)), 300));
    await this.waitFor(() => this.metas.filter((m) => m.alive).length >= 2 && this.nodes.every((n) => n.seen), 30_000, 'cluster did not start');
    await this.recoverMetadata();
    this.timers.push(setInterval(() => this.tick(), 100));
    if (this.opts.seed && this.objects.size === 0) await this.seedDemo();
    this.ready = true;
    this.addLog('info', `Cluster up: ${this.nodes.length} storage processes in ${RACKS.length} racks, 3 metadata replicas, ${this.objects.size} objects`);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.timers.forEach(clearInterval);
    const procs = [...this.nodes, ...this.metas].map((x) => x.proc).filter((p): p is ChildProcess => !!p);
    await Promise.all(procs.map((p) => new Promise<void>((res) => {
      if (p.exitCode !== null || p.signalCode !== null) { res(); return; }
      p.once('exit', () => res());
      p.kill('SIGKILL');
    })));
  }

  private makeNode(id: string, rack: string, port: number): NodeRec {
    return {
      id, rack, port, dir: join(this.opts.dataDir, id), reachable: !(this.isolated && rack === 'C'),
      proc: null, up: false, lastBeat: 0, status: 'healthy', keys: new Set(), bytes: 0, reported: new Set(),
      scrub: { enabled: true, passes: 0, found: 0, progress: 0 }, busy: false, pendingRebalance: false, seen: false,
    };
  }

  private fork(script: string, args: string[]): ChildProcess {
    const out = this.opts.quiet ? 'ignore' : 'inherit';
    return fork(script, args, {
      cwd: ROOT, execArgv: ['--import', 'tsx'], stdio: ['ignore', out, out, 'ipc'],
      env: { ...process.env, VAULT_NODE_TOKEN: this.nodeToken },
    });
  }

  private spawnNode(n: NodeRec) {
    const proc = this.fork(STORAGE_SCRIPT, ['--id', n.id, '--rack', n.rack, '--port', String(n.port), '--dir', n.dir, '--scrub', String(this.settings.scrub)]);
    n.proc = proc;
    n.up = true;
    // Grace period only for first boot. A restarted node must answer a real
    // heartbeat (with its current inventory) before it is trusted again.
    if (!n.seen) n.lastBeat = Math.max(n.lastBeat, this.now() + 3000);
    proc.on('exit', () => { if (n.proc === proc) { n.proc = null; n.up = false; } });
  }

  private spawnMeta(m: MetaRec) {
    const proc = this.fork(META_SCRIPT, ['--id', m.id, '--port', String(m.port), '--dir', m.dir]);
    m.proc = proc;
    m.up = true;
    proc.on('exit', () => { if (m.proc === proc) { m.proc = null; m.up = false; } });
  }

  private async waitFor(cond: () => boolean, ms: number, msg: string) {
    const end = this.now() + ms;
    while (!cond()) {
      if (this.now() > end) throw new Error(msg);
      await sleep(50);
    }
  }

  /* ------------------------------------------------------------------ network */

  /** Every call to a node goes through here, so partitions can drop traffic. */
  private async call(t: Endpoint, path: string, init: RequestInit = {}, timeoutMs = 1500): Promise<Response> {
    if (!t.reachable) {
      await sleep(Math.min(timeoutMs, 250));
      throw new Error('unreachable: network partition');
    }
    const headers = new Headers(init.headers);
    headers.set('x-vault-token', this.nodeToken);
    return fetch(`http://127.0.0.1:${t.port}${path}`, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
  }

  private async putPiece(n: NodeRec, key: string, bytes: Uint8Array, sum: string, timeout = 5000): Promise<boolean> {
    try {
      const r = await this.call(n, `/pieces/${enc(key)}`, {
        method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'x-sha256': sum }, body: bytes as unknown as BodyInit,
      }, timeout);
      if (r.ok) { n.keys.add(key); this.ledger.delete(`${n.id}|${key}`); }
      return r.ok;
    } catch {
      return false;
    }
  }

  private async getPiece(n: NodeRec, key: string, timeout = 2000): Promise<Uint8Array | null> {
    try {
      const r = await this.call(n, `/pieces/${enc(key)}`, {}, timeout);
      return r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
    } catch {
      return null;
    }
  }

  private async delPiece(n: NodeRec, key: string): Promise<void> {
    try {
      await this.call(n, `/pieces/${enc(key)}`, { method: 'DELETE' }, 2000);
      n.keys.delete(key);
      this.ledger.delete(`${n.id}|${key}`);
    } catch {
      /* reclaimed later by garbage collection when the node returns */
    }
  }

  /* ---------------------------------------------------------------- heartbeats */

  private async beat(n: NodeRec) {
    if (n.busy || this.stopped) return;
    n.busy = true;
    try {
      const r = await this.call(n, '/health', {}, 500);
      const h = (await r.json()) as { keys: string[]; bytes: number; corrupt: string[]; scrub: NodeRec['scrub'] };
      n.lastBeat = Math.max(n.lastBeat, this.now());
      n.seen = true;
      n.keys = new Set(h.keys);
      n.bytes = h.bytes;
      n.scrub = h.scrub;
      for (const key of h.corrupt) {
        if (n.reported.has(key)) continue;
        const p = this.refPiece(n.id, key);
        if (p && !p.corrupt) {
          p.corrupt = true;
          this.scrubFound++;
          this.addLog('warn', `Scrubber on ${n.id} found a corrupt piece of ${parseKey(key).name} and queued a rewrite`);
        }
      }
      n.reported = new Set(h.corrupt);
      if (n.pendingRebalance && n.status === 'healthy') { n.pendingRebalance = false; this.planRebalance(n); }
    } catch {
      /* missed heartbeat */
    } finally {
      n.busy = false;
    }
  }

  private async beatMeta(m: MetaRec) {
    if (m.busy || this.stopped) return;
    m.busy = true;
    try {
      await this.call(m, '/health', {}, 500);
      m.lastBeat = this.now();
    } catch {
      /* missed */
    } finally {
      m.busy = false;
    }
    const alive = this.now() - m.lastBeat < SUSPECT_AFTER;
    if (alive && !m.alive && this.ready) {
      m.alive = true;
      const pushed = await this.syncMeta(m);
      this.addLog('heal', `Metadata replica ${m.id} is back and caught up on ${pushed} entries`);
    } else if (!alive && m.alive && this.ready) {
      m.alive = false;
      this.addLog('warn', `Metadata replica ${m.id} stopped responding`);
    } else {
      m.alive = alive;
    }
  }

  hasQuorum(): boolean {
    return this.metas.filter((m) => m.alive && m.reachable).length >= 2;
  }

  private heartbeatStatus(t: number) {
    for (const n of this.nodes) {
      const age = t - n.lastBeat;
      let st: NodeStatus;
      if (age < SUSPECT_AFTER) st = 'healthy';
      else if (age < this.settings.deadTimeout) st = n.reachable ? 'suspect' : 'unreachable';
      else st = 'dead';
      if (st === n.status) continue;
      const prev = n.status;
      n.status = st;
      if (st === 'dead') this.addLog('fault', `${n.id} declared dead after ${this.settings.deadTimeout / 1000}s of silence, ${this.countRefs(n.id)} pieces to rebuild`);
      else if (st === 'suspect') this.addLog('warn', `${n.id} missed its heartbeats`);
      else if (st === 'unreachable') this.addLog('warn', `${n.id} is unreachable from the manager`);
      else this.gcNode(n, prev === 'dead');
    }
    const q = this.hasQuorum();
    if (q !== this.quorumWas && this.ready) {
      this.addLog(q ? 'heal' : 'bad', q
        ? 'Metadata quorum restored. Writes and repairs resume'
        : 'Metadata quorum lost (fewer than 2 of 3 replicas reachable). Writes and repairs pause to keep metadata consistent');
      this.quorumWas = q;
    }
  }

  private async gcNode(n: NodeRec, wasDead: boolean) {
    const stale = [...n.keys].filter((k) => !this.refPiece(n.id, k));
    await Promise.all(stale.map((k) => this.delPiece(n, k)));
    this.addLog('heal', `${n.id} ${wasDead ? 'rejoined the cluster' : 'is responding again'}${stale.length ? `, reclaimed ${stale.length} stale pieces` : ''}`);
    if (wasDead) this.rebalanceIfUnderloaded(n);
  }

  /** A node that returns nearly empty gets a fair share of data moved back onto it. */
  private rebalanceIfUnderloaded(n: NodeRec) {
    const live = this.nodes.filter((x) => x.status === 'healthy' && this.usable(x));
    const refs = this.refCounts();
    const avg = live.reduce((a, x) => a + (refs.get(x.id) ?? 0), 0) / Math.max(1, live.length);
    if ((refs.get(n.id) ?? 0) < avg * 0.5) n.pendingRebalance = true;
  }

  /* ----------------------------------------------------------------- metadata */

  private async commitMeta(name: string, value: VaultObject | null): Promise<boolean> {
    const rev = ++this.metaRev;
    const body = JSON.stringify({ rev, value });
    const acks = await Promise.all(this.metas.map(async (m) => {
      try {
        const r = await this.call(m, `/kv/${enc(name)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body }, 1000);
        return r.ok;
      } catch {
        return false;
      }
    }));
    return acks.filter(Boolean).length >= 2;
  }

  /** Push current state to a replica that was down, so it holds every committed entry again. */
  private async syncMeta(m: MetaRec): Promise<number> {
    let n = 0;
    for (const o of this.objects.values()) {
      try {
        const r = await this.call(m, `/kv/${enc(o.name)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rev: ++this.metaRev, value: o }) }, 1000);
        if (r.ok) n++;
      } catch {
        break;
      }
    }
    return n;
  }

  /** Rebuild state from a majority of replicas: the newest revision of each key wins. */
  private async recoverMetadata() {
    const replies = await Promise.all(this.metas.map(async (m) => {
      try {
        const r = await this.call(m, '/kv', {}, 3000);
        return ((await r.json()) as { entries: [string, { rev: number; value: VaultObject | null }][] }).entries;
      } catch {
        return null;
      }
    }));
    const ok = replies.filter((r): r is NonNullable<typeof r> => r !== null);
    if (ok.length < 2) throw new Error('cannot recover metadata: fewer than 2 replicas answered');
    const best = new Map<string, { rev: number; value: VaultObject | null }>();
    for (const list of ok) for (const [k, e] of list) {
      if (!best.has(k) || best.get(k)!.rev < e.rev) best.set(k, e);
      this.metaRev = Math.max(this.metaRev, e.rev);
    }
    for (const [k, e] of [...best].sort(([a], [b]) => a.localeCompare(b))) {
      if (!e.value) continue;
      this.objects.set(k, e.value);
      this.verSeq.set(k, e.value.version);
      if (!this.hues.has(k)) this.hues.set(k, HUES[this.hueIdx++ % HUES.length]);
    }
    for (const m of this.metas) m.alive = this.now() - m.lastBeat < SUSPECT_AFTER;
    if (this.objects.size) this.addLog('info', `Recovered ${this.objects.size} objects from the metadata replicas`);
    // anything stored on disk that metadata no longer references is garbage
    await Promise.all(this.nodes.map(async (n) => {
      const stale = [...n.keys].filter((k) => !this.refPiece(n.id, k));
      await Promise.all(stale.map((k) => this.delPiece(n, k)));
    }));
    for (const n of this.nodes) this.rebalanceIfUnderloaded(n);
  }

  /* ------------------------------------------------------------------ helpers */

  addLog(kind: LogKind, msg: string) {
    const t = this.now();
    this.log.unshift({ id: ++this.logSeq, t, kind, msg });
    if (this.log.length > 150) this.log.pop();
    if (kind === 'fault') this.series.marks.push(t);
  }

  nodeById(id: string | null | undefined) { return id ? this.nodes.find((n) => n.id === id) : undefined; }

  private usable(n: NodeRec | undefined): n is NodeRec {
    return !!n && n.up && n.reachable && n.status !== 'dead';
  }

  refPiece(nodeId: string, key: string): PieceMeta | null {
    let r;
    try { r = parseKey(key); } catch { return null; }
    const o = this.objects.get(r.name);
    if (!o || o.version !== r.ver) return null;
    const p = o.segments[r.s]?.pieces[r.i];
    return p && p.node === nodeId ? p : null;
  }

  pieceState(p: PieceMeta) {
    const n = this.nodeById(p.node);
    if (!n || n.status === 'dead') return 'missing' as const;
    if (p.corrupt) return 'corrupt' as const;
    if (!(n.up && n.reachable)) return 'unavailable' as const;
    return 'ok' as const;
  }

  countRefs(id: string): number {
    return this.refCounts().get(id) ?? 0;
  }

  /** Pieces referenced per node in one pass over metadata. */
  refCounts(): Map<string, number> {
    const refs = new Map<string, number>();
    for (const o of this.objects.values()) for (const sg of o.segments) for (const p of sg.pieces) if (p.node) refs.set(p.node, (refs.get(p.node) ?? 0) + 1);
    return refs;
  }

  private rackLoad(sg: Segment, exclude = -1): Map<string, number> {
    return rackLoad(sg.pieces, (id) => {
      const n = this.nodeById(id);
      return n && n.status !== 'dead' ? n.rack : undefined;
    }, exclude);
  }

  /** Rendezvous hashing with even rack spreading (shared with the simulator). */
  placeSegment(key: string, count: number): NodeRec[] {
    return placeAcrossRacks(this.nodes.filter((x) => x.status === 'healthy'), key, count);
  }

  /* --------------------------------------------------------------- write path */

  async putObject(name: string, bytes: Uint8Array, policyKey: PolicyKey, opts: { quiet?: boolean } = {}): Promise<WriteResult> {
    const pol = POLICIES[policyKey];
    if (!pol) return { ok: false, reason: `Unknown policy ${policyKey}` };
    if (!this.hasQuorum()) {
      this.stats.fails++;
      if (!opts.quiet) this.addLog('bad', `Write of ${name} rejected: metadata has no quorum, so writes pause to stay consistent`);
      return { ok: false, reason: 'Metadata has no quorum. Writes pause until 2 of 3 metadata replicas are reachable.' };
    }
    const prev = this.objects.get(name);
    const ver = Math.max(this.verSeq.get(name) ?? 0, prev?.version ?? 0) + 1;
    this.verSeq.set(name, ver);
    const q = writeQuorum(pol);
    const count = pieceCount(pol);
    const nSeg = Math.max(1, Math.ceil(bytes.length / pol.seg));
    const written: [NodeRec, string][] = [];
    const segments: Segment[] = [];
    let shortest = Infinity;

    // Up to 4 segments are encoded and written in parallel; within a segment all pieces go out at once.
    const results = await mapLimit(Array.from({ length: nSeg }, (_, s) => s), 4, async (s) => {
      const seg = bytes.subarray(s * pol.seg, Math.min(bytes.length, (s + 1) * pol.seg));
      let shards: Uint8Array[];
      let shardLen = seg.length;
      if (pol.type === 'rep') shards = Array.from({ length: pol.n! }, () => seg);
      else ({ shards, shardLen } = ecEncode(pol.k!, pol.m!, seg));
      // replicas are identical, so hash once
      const sums = pol.type === 'rep' ? new Array<string>(shards.length).fill(sha256(seg)) : shards.map(sha256);
      const targets = this.placeSegment(`${name}@${ver}#${s}`, count);
      const oks = await Promise.all(shards.map(async (pb, i) => {
        const n = targets[i];
        if (!this.usable(n)) return false;
        const key = pieceKey(name, ver, s, i);
        const ok = await this.putPiece(n, key, pb, sums[i]);
        if (ok) written.push([n, key]);
        return ok;
      }));
      const pieces = shards.map((pb, i) => ({ idx: i, node: oks[i] ? targets[i].id : null, sum: sums[i], len: pb.length, corrupt: false }));
      return { segment: { len: seg.length, shardLen, pieces } as Segment, placed: oks.filter(Boolean).length };
    });
    for (const r of results) {
      segments.push(r.segment);
      shortest = Math.min(shortest, r.placed);
    }

    const rollback = () => Promise.all(written.map(([n, k]) => this.delPiece(n, k)));
    if (shortest < q) {
      await rollback();
      this.stats.fails++;
      const msg = `only ${shortest} of ${count} pieces could be written, and the write quorum is ${q}`;
      if (!opts.quiet) this.addLog('bad', `Write of ${name} rejected: ${msg}`);
      return { ok: false, reason: `Not enough healthy nodes: ${msg}.` };
    }
    const cur = this.objects.get(name);
    if (cur && cur.version > ver) {
      await rollback();
      return { ok: false, reason: 'A newer version was committed first (last writer wins).' };
    }
    const obj: VaultObject = { name, size: bytes.length, sha: sha256(bytes), policy: policyKey, version: ver, segments, created: Date.now() };
    this.objects.set(name, obj);
    if (!(await this.commitMeta(name, obj))) {
      if (cur) this.objects.set(name, cur); else this.objects.delete(name);
      await rollback();
      this.stats.fails++;
      if (!opts.quiet) this.addLog('bad', `Write of ${name} rejected: fewer than 2 metadata replicas acknowledged`);
      return { ok: false, reason: 'Metadata commit did not reach a quorum.' };
    }
    if (!this.hues.has(name)) this.hues.set(name, HUES[this.hueIdx++ % HUES.length]);
    if (cur) this.dropVersion(cur);
    if (!opts.quiet) {
      const spread = new Set(segments.flatMap((sg) => sg.pieces.map((p) => p.node)).filter(Boolean)).size;
      this.addLog('info', `Stored ${name} (${fmtBytes(bytes.length)}, ${pol.label}) as v${ver} across ${spread} nodes`);
    }
    return { ok: true, obj };
  }

  private dropVersion(o: VaultObject) {
    o.segments.forEach((sg, s) => sg.pieces.forEach((p, i) => {
      const n = this.nodeById(p.node);
      if (this.usable(n)) void this.delPiece(n, pieceKey(o.name, o.version, s, i));
    }));
  }

  async deleteObject(name: string): Promise<boolean> {
    const o = this.objects.get(name);
    if (!o) return false;
    if (!this.hasQuorum()) return false;
    this.objects.delete(name);
    if (!(await this.commitMeta(name, null))) { this.objects.set(name, o); return false; }
    this.dropVersion(o);
    this.addLog('info', `Deleted ${name}`);
    return true;
  }

  /* ---------------------------------------------------------------- read path */

  async readObject(name: string): Promise<ReadResult> {
    const o = this.objects.get(name);
    if (!o) return { ok: false, reason: 'Object does not exist.' };
    const pol = POLICIES[o.policy];
    const parts: Uint8Array[] = [];
    let skipped = 0, decoded = 0;
    for (let s = 0; s < o.segments.length; s++) {
      const sg = o.segments[s];
      const need = minNeeded(pol);
      const good = await this.fetchValid(o, s, need, () => { skipped++; });
      if (good.length < need) return { ok: false, reason: `Segment ${s + 1} has only ${good.length} valid pieces reachable and needs ${need}.` };
      let segBytes: Uint8Array;
      if (pol.type === 'rep') segBytes = good[0].bytes;
      else {
        const data = ecDecode(pol.k!, pol.m!, good, sg.shardLen);
        if (good.some((g) => g.idx >= pol.k!)) decoded++;
        segBytes = joinShards(data, sg.shardLen, sg.len);
      }
      parts.push(segBytes.subarray(0, sg.len));
    }
    const all = new Uint8Array(o.size);
    let off = 0;
    for (const p of parts) { all.set(p, off); off += p.length; }
    const h = sha256(all);
    return { ok: h === o.sha, size: o.size, sha: h, expected: o.sha, skipped, decoded, bytes: all };
  }

  /** Fetch `need` checksum-valid pieces of one segment, preferring data pieces, in parallel. */
  private async fetchValid(o: VaultObject, s: number, need: number, onCorrupt: () => void, timeout = 2000) {
    const sg = o.segments[s];
    const cands = sg.pieces.map((p, i) => ({ p, i })).filter(({ p }) => this.usable(this.nodeById(p.node)) && !p.corrupt);
    const good: { idx: number; bytes: Uint8Array }[] = [];
    while (good.length < need && cands.length) {
      const batch = cands.splice(0, need - good.length);
      const got = await Promise.all(batch.map(async ({ p, i }) => {
        const n = this.nodeById(p.node)!;
        const bytes = await this.getPiece(n, pieceKey(o.name, o.version, s, i), timeout);
        if (!bytes) return null;
        if (sha256(bytes) !== p.sum) {
          p.corrupt = true;
          onCorrupt();
          this.addLog('warn', `Read caught a corrupt piece of ${o.name} on ${n.id}, used another piece and queued a rewrite`);
          return null;
        }
        return { idx: i, bytes };
      }));
      for (const g of got) if (g) good.push(g);
    }
    return good.sort((a, b) => a.idx - b.idx);
  }

  /* ------------------------------------------------------- repair & rebalance */

  private durabilityScan(t: number) {
    let degraded = 0, atRisk = 0;
    const unreadable = new Set<string>();
    for (const o of this.objects.values()) {
      const pol = POLICIES[o.policy];
      o.segments.forEach((sg, s) => {
        let ok = 0;
        sg.pieces.forEach((p, i) => {
          const st = this.pieceState(p);
          if (st === 'ok') ok++; else degraded++;
          if (st === 'missing' || st === 'corrupt') {
            const key = `r:${pieceKey(o.name, o.version, s, i)}`;
            if (!this.jobKeys.has(key)) {
              this.jobKeys.add(key);
              this.queue.push({ kind: 'repair', key, obj: o.name, ver: o.version, s, idx: i, added: t });
            }
          }
        });
        if (ok < minNeeded(pol)) unreadable.add(o.name);
        else if (ok === minNeeded(pol) && ok < sg.pieces.length) atRisk++;
      });
    }
    this.degraded = degraded;
    this.atRisk = atRisk;
    this.unreadable = unreadable;
    if (degraded > 0 && this.recovery.start === null) this.recovery.start = t;
    if (degraded === 0 && this.recovery.start !== null) {
      this.recovery.last = t - this.recovery.start;
      this.recovery.start = null;
      if (this.recovery.last > 1200) this.addLog('heal', `Every object is back to full protection, recovered in ${fmtSecs(this.recovery.last)}`);
    }
  }

  jobPriority(j: Job): number {
    if (j.kind === 'move') return 1000;
    const o = this.objects.get(j.obj);
    if (!o || o.version !== j.ver) return -99;
    return o.segments[j.s].pieces.filter((p) => this.pieceState(p) === 'ok').length - minNeeded(POLICIES[o.policy]);
  }

  private pickTarget(o: VaultObject, sg: Segment, s: number): NodeRec | null {
    const used = new Set(sg.pieces.map((q) => q.node).filter((x): x is string => !!x));
    const load = this.rackLoad(sg);
    for (const f of this.flights) {
      if (f.job.obj === o.name && f.job.ver === o.version && f.job.s === s) {
        used.add(f.target);
        const r = this.nodeById(f.target)?.rack;
        if (r) load.set(r, (load.get(r) ?? 0) + 1);
      }
    }
    this.refsThisPass ??= this.refCounts();
    const healthy = this.nodes.filter((n) => n.status === 'healthy' && this.usable(n));
    return pickRepairTarget(healthy, used, load, this.refsThisPass, `${o.name}@${o.version}#${s}`);
  }

  private transferMs(len: number) {
    return (len / ((this.settings.bandwidth ?? 1) * 1048576)) * 1000;
  }

  private tryStart(j: Job, t: number): 'started' | 'wait' | 'drop' {
    const o = this.objects.get(j.obj);
    if (!o || o.version !== j.ver) return 'drop';
    const sg = o.segments[j.s];
    const p = sg.pieces[j.idx];
    const pol = POLICIES[o.policy];
    if (j.kind === 'repair') {
      const st = this.pieceState(p);
      if (st !== 'missing' && st !== 'corrupt') return 'drop';
      const srcs = sg.pieces.map((q, i) => ({ q, i })).filter(({ q, i }) => i !== j.idx && this.pieceState(q) === 'ok');
      const need = minNeeded(pol);
      if (srcs.length < need) return 'wait';
      const home = this.nodeById(p.node);
      let target: NodeRec | null;
      let inPlace = false;
      if (st === 'corrupt' && home && home.status === 'healthy' && this.usable(home)) { target = home; inPlace = true; }
      else target = this.pickTarget(o, sg, j.s);
      if (!target) return 'wait';
      const chosen = pol.type === 'rep' ? srcs.slice(0, 1) : srcs.slice(0, need);
      const fl: Flight = { job: j, srcs: chosen.map((c) => ({ idx: c.i, node: c.q.node! })), target: target.id, inPlace, t0: t, dur: this.transferMs(p.len) + 40 };
      this.flights.push(fl);
      void this.runFlight(fl);
      return 'started';
    }
    if (this.pieceState(p) !== 'ok' || p.node !== j.from) return 'drop';
    const to = this.nodeById(j.to);
    if (!to || to.status !== 'healthy' || !this.usable(to) || sg.pieces.some((q) => q.node === j.to)) return 'drop';
    const fl: Flight = { job: j, srcs: [{ idx: j.idx, node: j.from! }], target: j.to!, inPlace: false, t0: t, dur: this.transferMs(p.len) + 40 };
    this.flights.push(fl);
    void this.runFlight(fl);
    return 'started';
  }

  private dispatch(t: number) {
    this.refsThisPass = null;
    if (!this.hasQuorum() || !this.queue.length) return;
    for (const j of this.queue) j.pri = this.jobPriority(j);
    this.queue.sort((a, b) => a.pri! - b.pri! || a.added - b.added);
    const keep: Job[] = [];
    for (const j of this.queue) {
      if (this.flights.length >= this.settings.concurrency) { keep.push(j); continue; }
      const r = this.tryStart(j, t);
      if (r === 'wait') keep.push(j); else if (r === 'drop') this.jobKeys.delete(j.key);
    }
    this.queue = keep;
  }

  private async runFlight(fl: Flight) {
    const j = fl.job;
    try {
      const o = this.objects.get(j.obj);
      if (!o || o.version !== j.ver) return;
      const sg = o.segments[j.s];
      const p = sg.pieces[j.idx];
      const pol = POLICIES[o.policy];
      const tgt = this.nodeById(fl.target);
      const shards = await Promise.all(fl.srcs.map(async (src) => {
        const n = this.nodeById(src.node);
        const q = sg.pieces[src.idx];
        if (!this.usable(n) || q.node !== src.node) return null;
        const bytes = await this.getPiece(n, pieceKey(o.name, o.version, j.s, src.idx));
        if (!bytes) return null;
        if (sha256(bytes) !== q.sum) {
          q.corrupt = true;
          this.addLog('warn', `Repair source on ${n.id} failed its checksum, marked corrupt and retrying from another piece`);
          return null;
        }
        return { idx: src.idx, bytes };
      }));
      if (shards.some((x) => x === null)) return;
      const valid = shards as { idx: number; bytes: Uint8Array }[];
      const bytes = j.kind === 'move' || pol.type === 'rep' ? valid[0].bytes : ecRebuild(pol.k!, pol.m!, valid, j.idx, sg.shardLen);
      if (sha256(bytes) !== p.sum) { this.addLog('bad', `Rebuilt piece of ${o.name} failed verification and was discarded`); return; }
      const wait = fl.t0 + this.transferMs(p.len) - this.now(); // repair bandwidth throttle
      if (wait > 0) await sleep(wait);
      if (this.objects.get(j.obj) !== o || !this.usable(tgt)) return;
      const key = pieceKey(o.name, o.version, j.s, j.idx);
      if (!(await this.putPiece(tgt, key, bytes, p.sum))) return;
      const old = p.node;
      const wasCorrupt = p.corrupt;
      p.node = tgt.id;
      p.corrupt = false;
      if (!(await this.commitMeta(o.name, o))) {
        p.node = old;
        p.corrupt = wasCorrupt;
        if (old !== tgt.id) await this.delPiece(tgt, key);
        return;
      }
      if (old && old !== tgt.id) {
        const on = this.nodeById(old);
        if (this.usable(on)) await this.delPiece(on, key);
      }
      if (j.kind === 'repair') this.repaired++;
      if (fl.inPlace) this.addLog('repair', `Rewrote a corrupt piece of ${o.name} on ${tgt.id} from verified ${pol.type === 'ec' ? 'parity' : 'replica'}`);
    } catch (err) {
      this.addLog('bad', `Repair error: ${(err as Error).message}`);
    } finally {
      this.flights = this.flights.filter((x) => x !== fl);
      this.jobKeys.delete(j.key);
    }
  }

  private planRebalance(nn: NodeRec) {
    const live = this.nodes.filter((n) => n.status === 'healthy' && this.usable(n));
    const refs = this.refCounts();
    const load = new Map(live.map((n) => [n.id, refs.get(n.id) ?? 0]));
    const total = [...load.values()].reduce((a, b) => a + b, 0);
    const target = Math.floor(total / live.length);
    const cands: { o: VaultObject; s: number; p: PieceMeta; i: number }[] = [];
    for (const o of this.objects.values()) o.segments.forEach((sg, s) => sg.pieces.forEach((p, i) => {
      if (this.pieceState(p) !== 'ok' || !load.has(p.node!) || p.node === nn.id) return;
      if (sg.pieces.some((q) => q.node === nn.id)) return;
      if ((this.rackLoad(sg, i).get(nn.rack) ?? 0) + 1 > Math.ceil(sg.pieces.length / RACKS.length)) return;
      cands.push({ o, s, p, i });
    }));
    cands.sort((a, b) => load.get(b.p.node!)! - load.get(a.p.node!)! || hash32(pieceKey(a.o.name, a.o.version, a.s, a.i)) - hash32(pieceKey(b.o.name, b.o.version, b.s, b.i)));
    const segUsed = new Set<string>();
    let planned = 0;
    for (const c of cands) {
      if (planned >= target) break;
      if (load.get(c.p.node!)! <= target) continue;
      const sk = `${c.o.name}#${c.s}`;
      if (segUsed.has(sk)) continue;
      segUsed.add(sk);
      load.set(c.p.node!, load.get(c.p.node!)! - 1);
      planned++;
      const key = `m:${pieceKey(c.o.name, c.o.version, c.s, c.i)}`;
      if (!this.jobKeys.has(key)) {
        this.jobKeys.add(key);
        this.queue.push({ kind: 'move', key, obj: c.o.name, ver: c.o.version, s: c.s, idx: c.i, from: c.p.node!, to: nn.id, added: this.now() });
      }
    }
    this.addLog('info', planned
      ? `Rebalancer moving ${planned} of ${total} pieces (${Math.round((planned / total) * 100)}%) onto ${nn.id}. Everything else stays put`
      : `${nn.id} is ready for new data`);
  }

  /* ------------------------------------------------------ background traffic */

  private traffic(t: number) {
    if (!this.settings.traffic || !this.ready) return;
    const objs = [...this.objects.values()].filter((o) => !o.name.startsWith('logs/'));
    for (let r = 0; r < 2 && objs.length && this.trafficInflight < 6; r++) {
      const o = objs[Math.floor(Math.random() * objs.length)];
      const s = Math.floor(Math.random() * o.segments.length);
      this.trafficInflight++;
      const t0 = this.now();
      this.fetchValid(o, s, minNeeded(POLICIES[o.policy]), () => undefined, 800)
        .then((good) => {
          if (good.length >= minNeeded(POLICIES[o.policy])) { this.stats.reads++; this.stats.lat.push(this.now() - t0); }
          else this.stats.fails++;
        })
        .finally(() => { this.trafficInflight--; });
    }
    if (t - this.lastWrite > 1000 && !this.writing) {
      this.lastWrite = t;
      this.writing = true;
      const name = `logs/app-${1 + Math.floor(Math.random() * 3)}.log`;
      this.putObject(name, randomBytes(8192 + Math.floor(Math.random() * 16384)), 'rep3', { quiet: true })
        .then((r) => { if (r.ok) this.stats.writes++; })
        .finally(() => { this.writing = false; });
    }
  }

  private sample(t: number) {
    if (t - this.lastSample < 1000) return;
    const dt = (t - this.lastSample) / 1000;
    this.lastSample = t;
    const L = this.stats.lat.sort((a, b) => a - b);
    const ser = this.series;
    ser.t.push(t);
    ser.rps.push(this.stats.reads / dt);
    ser.wps.push(this.stats.writes / dt);
    ser.fps.push(this.stats.fails / dt);
    ser.p99.push(L.length ? L[Math.min(L.length - 1, Math.floor(L.length * 0.99))] : 0);
    ser.q.push(this.queue.length + this.flights.length);
    for (const k of ['t', 'rps', 'wps', 'fps', 'p99', 'q'] as const) if (ser[k].length > 90) ser[k].shift();
    ser.marks = ser.marks.filter((m) => t - m < 92_000);
    this.stats = { reads: 0, writes: 0, fails: 0, lat: [] };
  }

  private tick() {
    if (this.stopped) return;
    const t = this.now();
    this.heartbeatStatus(t);
    this.durabilityScan(t);
    this.dispatch(t);
    this.traffic(t);
    this.sample(t);
  }

  /* ------------------------------------------------------------ chaos actions */

  crashNode(id: string) {
    const n = this.nodeById(id);
    if (!n?.proc) return false;
    n.proc.kill('SIGKILL');
    n.up = false;
    this.addLog('fault', `${n.id} crashed (process ${n.proc.pid} killed with SIGKILL)`);
    return true;
  }

  restartNode(id: string) {
    const n = this.nodeById(id);
    if (!n || n.proc) return false;
    this.spawnNode(n);
    this.addLog('info', `${n.id} process restarted`);
    return true;
  }

  crashRandomNode() {
    const c = this.nodes.filter((n) => n.proc);
    if (!c.length) return null;
    const n = c[Math.floor(Math.random() * c.length)];
    this.crashNode(n.id);
    return n.id;
  }

  async injectRot(id: string): Promise<string | null> {
    const n = this.nodeById(id);
    if (!this.usable(n)) return null;
    const keys = [...n.keys].filter((k) => this.refPiece(n.id, k) && !this.ledger.has(`${n.id}|${k}`));
    if (!keys.length) return null;
    const key = keys[Math.floor(Math.random() * keys.length)];
    try {
      const r = await this.call(n, '/chaos/corrupt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }) });
      if (!r.ok) return null;
      this.ledger.add(`${n.id}|${key}`);
      this.addLog('fault', `Flipped 3 bits in a piece of ${parseKey(key).name} on ${n.id}'s disk. The system was not told`);
      return key;
    } catch {
      return null;
    }
  }

  setIsolated(on: boolean) {
    if (on === this.isolated) return;
    this.isolated = on;
    for (const x of [...this.nodes, ...this.metas]) if (x.rack === 'C') x.reachable = !on;
    this.addLog(on ? 'fault' : 'heal', on ? 'Network partition: rack C is cut off from the rest of the cluster' : 'Network healed: rack C reconnected');
  }

  async addNode(): Promise<string> {
    const counts = RACKS.map((r) => this.nodes.filter((n) => n.rack === r).length);
    const rack = RACKS[counts.indexOf(Math.min(...counts))];
    const n = this.makeNode(`n${this.nodes.length + 1}`, rack, await freePort());
    n.pendingRebalance = true;
    this.nodes.push(n);
    this.spawnNode(n);
    this.addLog('info', `${n.id} joined rack ${rack} as a new process`);
    return n.id;
  }

  toggleMeta(id: string) {
    const m = this.metas.find((x) => x.id === id);
    if (!m) return;
    if (m.proc) {
      m.proc.kill('SIGKILL');
      m.up = false;
      this.addLog('fault', `Metadata replica ${m.id} crashed (process killed)`);
    } else {
      this.spawnMeta(m);
      this.addLog('info', `Metadata replica ${m.id} process restarted`);
    }
  }

  async updateSettings(patch: Partial<LiveSettings>) {
    const s = this.settings;
    if (patch.policy && POLICIES[patch.policy]) s.policy = patch.policy;
    if (typeof patch.deadTimeout === 'number') s.deadTimeout = Math.min(60_000, Math.max(1000, patch.deadTimeout));
    if (typeof patch.concurrency === 'number') s.concurrency = Math.min(32, Math.max(1, Math.round(patch.concurrency)));
    if (typeof patch.bandwidth === 'number') s.bandwidth = Math.min(1000, Math.max(0.05, patch.bandwidth));
    if (typeof patch.traffic === 'boolean') s.traffic = patch.traffic;
    if (typeof patch.scrub === 'boolean') {
      s.scrub = patch.scrub;
      await Promise.all(this.nodes.filter((n) => this.usable(n)).map((n) =>
        this.call(n, '/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scrub: patch.scrub }) }).catch(() => null)));
    }
    return s;
  }

  /* ------------------------------------------------------------------ views */

  async seedDemo() {
    const seeds: [string, number, PolicyKey][] = [
      ['lectures/distributed-systems-01.mp4', 3_000_000, 'ec42'],
      ['backups/postgres-2026-09-25.tar', 2_100_000, 'ec42'],
      ['datasets/sensor-readings.csv', 1_200_000, 'rep3'],
      ['images/campus-map.png', 700_000, 'rep2'],
      ['configs/cluster.yaml', 18_000, 'rep3'],
    ];
    for (const [name, size, pol] of seeds) await this.putObject(name, randomBytes(size), pol, { quiet: true });
  }

  snapshot(): ClusterSnapshot {
    const now = this.now();
    const nodes: NodeInfo[] = this.nodes.map((n) => ({
      id: n.id, rack: n.rack, up: n.up, reachable: n.reachable, status: n.status, pieceCount: n.keys.size, bytes: n.bytes,
      pieces: [...n.keys].map((key) => {
        const p = this.refPiece(n.id, key);
        let name = key;
        try { name = parseKey(key).name; } catch { /* foreign key */ }
        return { key, name, corrupt: !!p?.corrupt, rot: this.ledger.has(`${n.id}|${key}`) && !p?.corrupt };
      }),
    }));
    const healthy = this.nodes.filter((n) => n.status === 'healthy' && n.up);
    let silentRot = 0;
    for (const k of this.ledger) {
      const [nid, key] = [k.slice(0, k.indexOf('|')), k.slice(k.indexOf('|') + 1)];
      const p = this.refPiece(nid, key);
      if (p && !p.corrupt) silentRot++;
    }
    return {
      mode: 'live',
      now,
      startedAt: this.startedAt,
      ready: this.ready,
      racks: RACKS,
      nodes,
      meta: this.metas.map((m) => ({ id: m.id, rack: m.rack, up: m.up, reachable: m.reachable, leader: false })),
      metaLabel: 'Metadata replicas (2 of 3 must acknowledge)',
      term: null,
      quorum: this.hasQuorum(),
      objects: [...this.objects.values()],
      flights: this.flights.map((f) => ({
        kind: f.job.kind, obj: f.job.obj, ver: f.job.ver, s: f.job.s, idx: f.job.idx,
        srcs: f.srcs.map((x) => x.node), target: f.target, elapsed: now - f.t0, dur: f.dur,
      })),
      queueLength: this.queue.length,
      log: this.log,
      series: this.series,
      settings: { ...this.settings },
      isolated: this.isolated,
      recovery: this.recovery,
      degraded: this.degraded,
      atRisk: this.atRisk,
      unreadable: [...this.unreadable],
      scrub: {
        enabled: this.settings.scrub,
        passes: healthy.length ? Math.min(...healthy.map((n) => n.scrub.passes)) : 0,
        found: this.scrubFound,
        progress: healthy.length ? healthy.reduce((a, n) => a + n.scrub.progress, 0) / healthy.length : 0,
      },
      repaired: this.repaired,
      silentRot,
      hues: Object.fromEntries(this.hues),
    };
  }
}