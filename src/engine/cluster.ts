import { ecDecode, ecEncode, ecRebuild, joinShards } from './gf256';
import { hash32, randomBytes, sha256 } from './hash';
import { parseKey, pieceKey } from './keys';
import { pickRepairTarget, placeAcrossRacks, rackLoad } from './placement';
import { fmtBytes, fmtSecs } from './format';
import { POLICIES, minNeeded, pieceCount, writeQuorum } from './policies';
import type {
  Flight, Job, LogEntry, LogKind, MetaNode, NodeStatus, ObjectHealth, PieceMeta, PieceState,
  PolicyKey, ReadResult, Segment, Settings, StorageNode, VaultObject, WriteResult,
} from './types';

export const RACKS = ['A', 'B', 'C'] as const;
/** A node that misses heartbeats for this long is shown as suspect. */
export const SUSPECT_AFTER = 1500;
/** Minimum time without a metadata leader before an election completes. */
export const ELECTION_TIMEOUT = 700;
const HUES = ['#5B8DEF', '#C9A15B', '#D9779C', '#4FB3C8', '#9AAE5A', '#E08E6D', '#8FA0B8', '#B98BDB'];

export interface ClusterOptions {
  clock?: () => number;
  rng?: () => number;
  nodes?: number;
  traffic?: boolean;
  scrub?: boolean;
  deadTimeout?: number;
  concurrency?: number;
  /** multiplier on repair transfer time (lower = faster) */
  transferScale?: number;
}

export { parseKey, pieceKey } from './keys';

export class VaultCluster {
  readonly clock: () => number;
  readonly rng: () => number;
  readonly startedAt: number;
  readonly transferScale: number;

  nodes: StorageNode[] = [];
  meta: MetaNode[] = [];
  leader: string | null = 'm1';
  term = 1;
  objects = new Map<string, VaultObject>();
  hues = new Map<string, string>();
  queue: Job[] = [];
  inflight: Flight[] = [];
  log: LogEntry[] = [];
  settings: Settings;
  isolated = false;
  recovery: { start: number | null; last: number | null } = { start: null, last: null };
  scrub = { list: [] as [string, string][], cursor: 0, busy: false, passes: 0, found: 0 };
  stats = { reads: 0, writes: 0, fails: 0, lat: [] as number[], repaired: 0, moved: 0 };
  series = { t: [] as number[], rps: [] as number[], wps: [] as number[], fps: [] as number[], p99: [] as number[], q: [] as number[], marks: [] as number[] };
  degraded = 0;
  atRisk = 0;
  unreadable = new Set<string>();
  seeded = false;

  private leaderLostAt: number | null = null;
  private quorumWarned = false;
  private verSeq = new Map<string, number>();
  private hueIdx = 0;
  private jobKeys = new Set<string>();
  private logSeq = 0;
  private nodeSeq: number;
  private pending = new Set<Promise<unknown>>();
  private listeners = new Set<() => void>();
  private lastSample: number;
  private lastWrite: number;
  private writing = false;
  private lastRejectLog = -Infinity;

  constructor(opts: ClusterOptions = {}) {
    this.clock = opts.clock ?? (() => performance.now());
    this.rng = opts.rng ?? Math.random;
    this.transferScale = opts.transferScale ?? 1;
    this.startedAt = this.clock();
    this.lastSample = this.startedAt;
    this.lastWrite = this.startedAt;
    this.settings = {
      policy: 'ec42',
      deadTimeout: opts.deadTimeout ?? 5000,
      concurrency: opts.concurrency ?? 4,
      scrub: opts.scrub ?? true,
      traffic: opts.traffic ?? true,
    };
    const count = opts.nodes ?? 9;
    for (let i = 0; i < count; i++) this.nodes.push(this.makeNode(`n${i + 1}`, RACKS[i % RACKS.length]));
    this.nodeSeq = count;
    this.meta = RACKS.map((r, i) => ({ id: `m${i + 1}`, rack: r, up: true, reachable: true }));
  }

  /* ------------------------------------------------------------------ helpers */

  private makeNode(id: string, rack: string): StorageNode {
    return {
      id, rack, up: true, reachable: !(this.isolated && rack === 'C'),
      lastBeat: this.clock(), status: 'healthy', store: new Map(),
    };
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.pending.add(p);
    p.finally(() => this.pending.delete(p)).catch(() => undefined);
    return p;
  }

  /** Subscribe to state changes (called after every control-loop step). Returns an unsubscribe function. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  /** Resolves once every background async task (hashing, repairs) has finished. */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  nodeById(id: string | null | undefined): StorageNode | undefined {
    return id ? this.nodes.find((n) => n.id === id) : undefined;
  }

  usable(n: StorageNode | undefined): n is StorageNode {
    return !!n && n.up && n.reachable && n.status !== 'dead';
  }

  hasQuorum(): boolean {
    return this.leader !== null;
  }

  refPiece(nodeId: string, key: string): PieceMeta | null {
    const r = parseKey(key);
    const o = this.objects.get(r.name);
    if (!o || o.version !== r.ver) return null;
    const p = o.segments[r.s]?.pieces[r.i];
    return p && p.node === nodeId ? p : null;
  }

  pieceState(p: PieceMeta): PieceState {
    const n = this.nodeById(p.node);
    if (!n || n.status === 'dead') return 'missing';
    if (p.corrupt) return 'corrupt';
    if (!(n.up && n.reachable)) return 'unavailable';
    return 'ok';
  }

  private forEachPiece(fn: (o: VaultObject, sg: Segment, s: number, p: PieceMeta, i: number) => void): void {
    for (const o of this.objects.values()) o.segments.forEach((sg, s) => sg.pieces.forEach((p, i) => fn(o, sg, s, p, i)));
  }

  addLog(kind: LogKind, msg: string): void {
    const t = this.clock();
    this.log.unshift({ id: ++this.logSeq, t, kind, msg });
    if (this.log.length > 120) this.log.pop();
    if (kind === 'fault') this.series.marks.push(t);
  }

  hueFor(name: string): string {
    return this.hues.get(name) ?? '#8FA0B8';
  }

  /* ---------------------------------------------------------------- write path */

  /** Rendezvous hashing with even rack spreading (see placement.ts). */
  placeSegment(key: string, count: number): StorageNode[] {
    return placeAcrossRacks(this.nodes.filter((n) => n.status === 'healthy'), key, count);
  }

  /** How many live pieces of a segment each rack holds. */
  private rackLoad(sg: Segment, exclude = -1): Map<string, number> {
    return rackLoad(sg.pieces, (id) => {
      const n = this.nodeById(id);
      return n && n.status !== 'dead' ? n.rack : undefined;
    }, exclude);
  }

  /** Pieces referenced per node, computed once per scheduling pass. */
  private refCounts(): Map<string, number> {
    const refs = new Map<string, number>();
    this.forEachPiece((_o, _sg, _s, p) => { if (p.node) refs.set(p.node, (refs.get(p.node) ?? 0) + 1); });
    return refs;
  }
  private refsThisPass: Map<string, number> | null = null;

  private dropVersion(o: VaultObject): void {
    o.segments.forEach((sg, s) => sg.pieces.forEach((p, i) => {
      const n = this.nodeById(p.node);
      if (this.usable(n)) n.store.delete(pieceKey(o.name, o.version, s, i));
    }));
  }

  putObject(name: string, bytes: Uint8Array, policyKey: PolicyKey, opts: { quiet?: boolean } = {}): Promise<WriteResult> {
    return this.track(this.doPut(name, bytes, policyKey, opts));
  }

  private async doPut(name: string, bytes: Uint8Array, policyKey: PolicyKey, opts: { quiet?: boolean }): Promise<WriteResult> {
    const pol = POLICIES[policyKey];
    if (!this.leader) {
      this.stats.fails++;
      if (!opts.quiet) this.addLog('bad', `Write of ${name} rejected: metadata has no quorum, so writes pause to stay consistent`);
      return { ok: false, reason: 'Metadata has no quorum. Writes pause until 2 of 3 metadata nodes are reachable.' };
    }
    const prev = this.objects.get(name);
    const ver = Math.max(this.verSeq.get(name) ?? 0, prev?.version ?? 0) + 1;
    this.verSeq.set(name, ver);
    const objSha = await sha256(bytes);
    const nSeg = Math.max(1, Math.ceil(bytes.length / pol.seg));
    const q = writeQuorum(pol);
    const count = pieceCount(pol);
    const written: [StorageNode, string][] = [];
    const segments: Segment[] = [];
    let shortest = Infinity;

    for (let s = 0; s < nSeg; s++) {
      const seg = bytes.subarray(s * pol.seg, Math.min(bytes.length, (s + 1) * pol.seg));
      let shards: Uint8Array[];
      let shardLen = seg.length;
      let sums: string[];
      if (pol.type === 'rep') {
        shards = Array.from({ length: pol.n! }, () => seg.slice());
        const h = await sha256(shards[0]);
        sums = shards.map(() => h);
      } else {
        const e = ecEncode(pol.k!, pol.m!, seg);
        shards = e.shards;
        shardLen = e.shardLen;
        sums = [];
        for (const sh of shards) sums.push(await sha256(sh));
      }
      const targets = this.placeSegment(`${name}@${ver}#${s}`, count);
      const pieces: PieceMeta[] = [];
      let placed = 0;
      shards.forEach((pb, i) => {
        const n = targets[i];
        let node: string | null = null;
        if (this.usable(n)) {
          const key = pieceKey(name, ver, s, i);
          n.store.set(key, { bytes: pb, rot: false });
          written.push([n, key]);
          node = n.id;
          placed++;
        }
        pieces.push({ idx: i, node, sum: sums[i], len: pb.length, corrupt: false });
      });
      shortest = Math.min(shortest, placed);
      segments.push({ len: seg.length, shardLen, pieces });
      if (placed < q) break;
    }

    const rollback = () => written.forEach(([n, k]) => n.store.delete(k));
    if (shortest < q) {
      rollback();
      this.stats.fails++;
      const msg = `only ${shortest} of ${count} pieces could be written, and the write quorum is ${q}`;
      if (!opts.quiet) this.addLog('bad', `Write of ${name} rejected: ${msg}`);
      return { ok: false, reason: `Not enough healthy nodes: ${msg}.` };
    }
    if (!this.leader) {
      rollback();
      this.stats.fails++;
      return { ok: false, reason: 'Metadata quorum was lost during the write.' };
    }
    const cur = this.objects.get(name);
    if (cur && cur.version > ver) {
      rollback();
      return { ok: false, reason: 'A newer version was committed first (last writer wins).' };
    }
    const obj: VaultObject = { name, size: bytes.length, sha: objSha, policy: policyKey, version: ver, segments, created: this.clock() };
    if (!this.hues.has(name)) this.hues.set(name, HUES[this.hueIdx++ % HUES.length]);
    this.objects.set(name, obj);
    if (cur) this.dropVersion(cur);
    if (!opts.quiet) {
      const spread = new Set(segments.flatMap((sg) => sg.pieces.map((p) => p.node)).filter(Boolean)).size;
      this.addLog('info', `Stored ${name} (${fmtBytes(bytes.length)}, ${pol.label}) as v${ver} across ${spread} nodes`);
    }
    return { ok: true, obj };
  }

  deleteObject(name: string): boolean {
    const o = this.objects.get(name);
    if (!o) return false;
    this.dropVersion(o);
    this.objects.delete(name);
    this.addLog('info', `Deleted ${name}`);
    return true;
  }

  /* ----------------------------------------------------------------- read path */

  readObject(name: string): Promise<ReadResult> {
    return this.track(this.doRead(name));
  }

  private async doRead(name: string): Promise<ReadResult> {
    const o = this.objects.get(name);
    if (!o) return { ok: false, reason: 'Object does not exist.' };
    const pol = POLICIES[o.policy];
    const parts: Uint8Array[] = [];
    let skipped = 0;
    let decoded = 0;
    for (let s = 0; s < o.segments.length; s++) {
      const sg = o.segments[s];
      const need = minNeeded(pol);
      const good: { idx: number; bytes: Uint8Array }[] = [];
      const order = sg.pieces.map((p, i) => ({ p, i })).filter(({ p }) => this.usable(this.nodeById(p.node)) && !p.corrupt);
      for (const { p, i } of order) {
        if (good.length >= need) break;
        const e = this.nodeById(p.node)!.store.get(pieceKey(o.name, o.version, s, i));
        if (!e) continue;
        if ((await sha256(e.bytes)) !== p.sum) {
          p.corrupt = true;
          skipped++;
          this.addLog('warn', `Read caught a corrupt piece of ${o.name} on ${p.node}, used another piece and queued a rewrite`);
          continue;
        }
        good.push({ idx: i, bytes: e.bytes });
      }
      if (good.length < need) {
        return { ok: false, reason: `Segment ${s + 1} has only ${good.length} valid pieces reachable and needs ${need}.` };
      }
      let segBytes: Uint8Array;
      if (pol.type === 'rep') {
        segBytes = good[0].bytes;
      } else {
        const data = ecDecode(pol.k!, pol.m!, good, sg.shardLen);
        if (good.some((g) => g.idx >= pol.k!)) decoded++;
        segBytes = joinShards(data, sg.shardLen, sg.len);
      }
      parts.push(segBytes.subarray(0, sg.len));
    }
    const all = new Uint8Array(o.size);
    let off = 0;
    for (const p of parts) { all.set(p, off); off += p.length; }
    const h = await sha256(all);
    return { ok: h === o.sha, size: o.size, sha: h, expected: o.sha, skipped, decoded, bytes: all };
  }

  /* ---------------------------------------------------------- failure detection */

  private gcNode(n: StorageNode): number {
    let c = 0;
    for (const key of [...n.store.keys()]) {
      if (!this.refPiece(n.id, key)) { n.store.delete(key); c++; }
    }
    return c;
  }

  countRefs(id: string): number {
    let c = 0;
    this.forEachPiece((_o, _sg, _s, p) => { if (p.node === id) c++; });
    return c;
  }

  private heartbeats(t: number): void {
    for (const n of this.nodes) {
      if (n.up && n.reachable) n.lastBeat = t;
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
      else if (st === 'unreachable') this.addLog('warn', `${n.id} is unreachable from the gateway`);
      else {
        const r = this.gcNode(n);
        this.addLog('heal', `${n.id} ${prev === 'dead' ? 'rejoined the cluster' : 'is responding again'}${r ? `, reclaimed ${r} stale pieces` : ''}`);
      }
    }
  }

  private raft(t: number): void {
    const avail = this.meta.filter((m) => m.up && m.reachable);
    if (this.leader && avail.some((m) => m.id === this.leader)) { this.leaderLostAt = null; return; }
    if (this.leader) {
      this.addLog('fault', `Metadata leader ${this.leader} lost, starting election`);
      this.leader = null;
      this.leaderLostAt = t;
    }
    if (this.leaderLostAt === null) this.leaderLostAt = t;
    if (avail.length >= 2 && t - this.leaderLostAt >= ELECTION_TIMEOUT) {
      const pick = avail[Math.floor(this.rng() * avail.length)];
      this.term++;
      this.leader = pick.id;
      this.leaderLostAt = null;
      this.quorumWarned = false;
      this.addLog('heal', `${pick.id} elected metadata leader for term ${this.term}`);
    } else if (avail.length < 2 && !this.quorumWarned) {
      this.quorumWarned = true;
      this.addLog('bad', `Metadata quorum lost (${avail.length} of 3 reachable). Writes and repairs pause to keep metadata consistent`);
    }
  }

  /* ------------------------------------------------------ repair and rebalance */

  private durabilityScan(t: number): void {
    let degraded = 0;
    let atRisk = 0;
    const unreadable = new Set<string>();
    for (const o of this.objects.values()) {
      const pol = POLICIES[o.policy];
      o.segments.forEach((sg, s) => {
        let ok = 0;
        sg.pieces.forEach((p, i) => {
          const st = this.pieceState(p);
          if (st === 'ok') ok++;
          else degraded++;
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

  /** Lower is more urgent: spare pieces left before the segment becomes unreadable. */
  jobPriority(j: Job): number {
    if (j.kind === 'move') return 1000;
    const o = this.objects.get(j.obj);
    if (!o || o.version !== j.ver) return -99;
    const ok = o.segments[j.s].pieces.filter((p) => this.pieceState(p) === 'ok').length;
    return ok - minNeeded(POLICIES[o.policy]);
  }

  private pickTarget(o: VaultObject, sg: Segment, s: number): StorageNode | null {
    const used = new Set(sg.pieces.map((q) => q.node).filter((x): x is string => !!x));
    const load = this.rackLoad(sg);
    for (const f of this.inflight) {
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

  private flightDur(len: number, ec: boolean): number {
    return (320 + (len / 262144) * 520) * (ec ? 1.3 : 1) * (0.85 + this.rng() * 0.3) * this.transferScale;
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
      let target: StorageNode | null = null;
      let inPlace = false;
      if (st === 'corrupt' && home && home.status === 'healthy' && this.usable(home)) { target = home; inPlace = true; }
      else target = this.pickTarget(o, sg, j.s);
      if (!target) return 'wait';
      const chosen = pol.type === 'rep'
        ? srcs.slice(0, 1)
        : srcs.sort((a, b) => this.nodeById(a.q.node)!.store.size - this.nodeById(b.q.node)!.store.size).slice(0, need);
      this.inflight.push({
        job: j, srcs: chosen.map((c) => ({ idx: c.i, node: c.q.node! })), target: target.id, inPlace,
        t0: t, dur: this.flightDur(p.len, pol.type === 'ec'), busy: false,
      });
      return 'started';
    }
    if (this.pieceState(p) !== 'ok' || p.node !== j.from) return 'drop';
    const to = this.nodeById(j.to);
    if (!to || to.status !== 'healthy' || !this.usable(to) || sg.pieces.some((q) => q.node === j.to)) return 'drop';
    this.inflight.push({ job: j, srcs: [{ idx: j.idx, node: j.from! }], target: j.to!, inPlace: false, t0: t, dur: this.flightDur(p.len, false) * 0.8, busy: false });
    return 'started';
  }

  private dispatch(t: number): void {
    this.refsThisPass = null;
    if (!this.leader || !this.queue.length) return;
    for (const j of this.queue) j.pri = this.jobPriority(j);
    this.queue.sort((a, b) => a.pri! - b.pri! || a.added - b.added);
    const keep: Job[] = [];
    for (const j of this.queue) {
      if (this.inflight.length >= this.settings.concurrency) { keep.push(j); continue; }
      const r = this.tryStart(j, t);
      if (r === 'wait') keep.push(j);
      else if (r === 'drop') this.jobKeys.delete(j.key);
    }
    this.queue = keep;
  }

  private async finishFlight(fl: Flight): Promise<void> {
    const j = fl.job;
    try {
      const o = this.objects.get(j.obj);
      if (!o || o.version !== j.ver) return;
      const sg = o.segments[j.s];
      const p = sg.pieces[j.idx];
      const pol = POLICIES[o.policy];
      const tgt = this.nodeById(fl.target);
      if (!this.usable(tgt)) return;
      const shards: { idx: number; bytes: Uint8Array }[] = [];
      for (const src of fl.srcs) {
        const n = this.nodeById(src.node);
        const q = sg.pieces[src.idx];
        if (!this.usable(n) || q.node !== src.node) return;
        const e = n.store.get(pieceKey(o.name, o.version, j.s, src.idx));
        if (!e || (await sha256(e.bytes)) !== q.sum) {
          q.corrupt = true;
          this.addLog('warn', `Repair source on ${n.id} failed its checksum, marked corrupt and retrying from another piece`);
          return;
        }
        shards.push({ idx: src.idx, bytes: e.bytes });
      }
      const bytes = j.kind === 'move' || pol.type === 'rep'
        ? shards[0].bytes.slice()
        : ecRebuild(pol.k!, pol.m!, shards, j.idx, sg.shardLen);
      if ((await sha256(bytes)) !== p.sum) {
        this.addLog('bad', `Rebuilt piece of ${o.name} failed verification and was discarded`);
        return;
      }
      if (this.objects.get(j.obj) !== o || !this.usable(tgt)) return;
      const key = pieceKey(o.name, o.version, j.s, j.idx);
      const old = p.node;
      tgt.store.set(key, { bytes, rot: false });
      if (old && old !== tgt.id) {
        const on = this.nodeById(old);
        if (this.usable(on)) on.store.delete(key);
      }
      p.node = tgt.id;
      p.corrupt = false;
      if (j.kind === 'move') this.stats.moved++;
      else this.stats.repaired++;
      if (fl.inPlace) this.addLog('repair', `Rewrote a corrupt piece of ${o.name} on ${tgt.id} from verified ${pol.type === 'ec' ? 'parity' : 'replica'}`);
    } finally {
      this.inflight = this.inflight.filter((x) => x !== fl);
      this.jobKeys.delete(j.key);
    }
  }

  private progressInflight(t: number): void {
    for (const fl of this.inflight) {
      if (!fl.busy && t >= fl.t0 + fl.dur) {
        fl.busy = true;
        this.track(this.finishFlight(fl));
      }
    }
  }

  private planRebalance(nn: StorageNode): number {
    const live = this.nodes.filter((n) => n.status === 'healthy' && this.usable(n));
    const total = live.reduce((a, n) => a + n.store.size, 0);
    const target = Math.floor(total / live.length);
    const load = new Map(live.map((n) => [n.id, n.store.size]));
    const cands: { o: VaultObject; s: number; p: PieceMeta; i: number }[] = [];
    const perRack = (sg: Segment) => Math.ceil(sg.pieces.length / RACKS.length);
    this.forEachPiece((o, sg, s, p, i) => {
      if (this.pieceState(p) !== 'ok' || !load.has(p.node!)) return;
      if (sg.pieces.some((q) => q.node === nn.id)) return;
      // only move if the new node's rack stays within its fair share for this segment
      if ((this.rackLoad(sg, i).get(nn.rack) ?? 0) + 1 > perRack(sg)) return;
      cands.push({ o, s, p, i });
    });
    cands.sort((a, b) => load.get(b.p.node!)! - load.get(a.p.node!)!
      || hash32(pieceKey(a.o.name, a.o.version, a.s, a.i)) - hash32(pieceKey(b.o.name, b.o.version, b.s, b.i)));
    const segUsed = new Set<string>();
    const t = this.clock();
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
        this.queue.push({ kind: 'move', key, obj: c.o.name, ver: c.o.version, s: c.s, idx: c.i, from: c.p.node!, to: nn.id, added: t });
      }
    }
    this.addLog('info', planned
      ? `Rebalancer moving ${planned} of ${total} pieces (${Math.round((planned / total) * 100)}%) onto ${nn.id}. Everything else stays put`
      : `${nn.id} is ready for new data`);
    return planned;
  }

  /* ------------------------------------------------------- integrity scrubber */

  /** Verify up to `batch` pieces against their metadata checksums. */
  async scrubStep(batch = 3): Promise<void> {
    if (!this.settings.scrub || this.scrub.busy) return;
    this.scrub.busy = true;
    try {
      if (this.scrub.cursor >= this.scrub.list.length) {
        if (this.scrub.list.length) this.scrub.passes++;
        this.scrub.list = [];
        for (const n of this.nodes) for (const k of n.store.keys()) this.scrub.list.push([n.id, k]);
        this.scrub.cursor = 0;
        if (!this.scrub.list.length) return;
      }
      for (let c = 0; c < batch && this.scrub.cursor < this.scrub.list.length; c++) {
        const [nid, key] = this.scrub.list[this.scrub.cursor++];
        const n = this.nodeById(nid);
        if (!this.usable(n)) continue;
        const e = n.store.get(key);
        if (!e) continue;
        const p = this.refPiece(nid, key);
        if (!p || p.corrupt) continue;
        if ((await sha256(e.bytes)) !== p.sum) {
          p.corrupt = true;
          this.scrub.found++;
          this.addLog('warn', `Scrubber found a corrupt piece of ${parseKey(key).name} on ${nid} and queued a rewrite`);
        }
      }
    } finally {
      this.scrub.busy = false;
    }
  }

  scrubProgress(): number {
    return this.scrub.list.length ? this.scrub.cursor / this.scrub.list.length : 0;
  }

  /* ------------------------------------------------- simulated client traffic */

  private simRead(o: VaultObject, s: number): void {
    const pol = POLICIES[o.policy];
    const sg = o.segments[s];
    let lat = 5 + this.rng() * 4 + this.inflight.length * 0.7;
    let ok = 0;
    let degraded = false;
    const need = minNeeded(pol);
    for (let i = 0; i < sg.pieces.length && ok < need; i++) {
      const p = sg.pieces[i];
      const st = this.pieceState(p);
      if (st === 'ok') {
        const e = this.nodeById(p.node)!.store.get(pieceKey(o.name, o.version, s, i));
        if (e?.rot) {
          p.corrupt = true;
          degraded = true;
          lat += 6;
          this.addLog('warn', `Read path caught bit rot in ${o.name} on ${p.node}, served a verified piece instead`);
          continue;
        }
        ok++;
      } else {
        degraded = true;
        lat += st === 'unavailable' ? 35 + this.rng() * 15 : 2;
      }
    }
    if (ok < need) { this.stats.fails++; return; }
    if (degraded) lat += pol.type === 'ec' ? 9 : 3;
    this.stats.reads++;
    this.stats.lat.push(lat);
  }

  private traffic(t: number): void {
    if (!this.settings.traffic) return;
    const objs = [...this.objects.values()];
    if (!objs.length) return;
    const n = 3 + Math.floor(this.rng() * 3);
    for (let r = 0; r < n; r++) {
      const o = objs[Math.floor(this.rng() * objs.length)];
      this.simRead(o, Math.floor(this.rng() * o.segments.length));
    }
    if (t - this.lastWrite > 650 && !this.writing) {
      this.lastWrite = t;
      this.writing = true;
      const name = `logs/app-${1 + Math.floor(this.rng() * 3)}.log`;
      this.putObject(name, randomBytes(12288 + Math.floor(this.rng() * 20000)), 'rep3', { quiet: true })
        .then((r) => {
          if (r.ok) this.stats.writes++;
          else if (this.clock() - this.lastRejectLog > 6000) {
            this.lastRejectLog = this.clock();
            this.addLog('bad', `Background writes rejected: ${r.reason}`);
          }
        })
        .finally(() => { this.writing = false; });
    }
  }

  private sample(t: number): void {
    if (t - this.lastSample < 1000) return;
    const dt = (t - this.lastSample) / 1000;
    this.lastSample = t;
    const L = this.stats.lat.sort((a, b) => a - b);
    const p99 = L.length ? L[Math.min(L.length - 1, Math.floor(L.length * 0.99))] : 0;
    const ser = this.series;
    ser.t.push(t);
    ser.rps.push(this.stats.reads / dt);
    ser.wps.push(this.stats.writes / dt);
    ser.fps.push(this.stats.fails / dt);
    ser.p99.push(p99);
    ser.q.push(this.queue.length + this.inflight.length);
    for (const k of ['t', 'rps', 'wps', 'fps', 'p99', 'q'] as const) if (ser[k].length > 90) ser[k].shift();
    ser.marks = ser.marks.filter((m) => t - m < 92000);
    this.stats.reads = 0;
    this.stats.writes = 0;
    this.stats.fails = 0;
    this.stats.lat = [];
  }

  /** Advance the control plane by one step. Call every ~100ms. */
  tick(): void {
    const t = this.clock();
    this.heartbeats(t);
    this.raft(t);
    this.durabilityScan(t);
    this.dispatch(t);
    this.progressInflight(t);
    this.traffic(t);
    this.track(this.scrubStep());
    this.sample(t);
    this.notify();
  }

  /* -------------------------------------------------------------- chaos actions */

  crashNode(id: string): void {
    const n = this.nodeById(id);
    if (!n || !n.up) return;
    n.up = false;
    this.addLog('fault', `${n.id} crashed`);
  }

  restartNode(id: string): void {
    const n = this.nodeById(id);
    if (!n || n.up) return;
    n.up = true;
    n.lastBeat = this.clock();
    this.addLog('info', `${n.id} process restarted`);
  }

  crashRandomNode(): string | null {
    const c = this.nodes.filter((x) => x.up);
    if (!c.length) return null;
    const n = c[Math.floor(this.rng() * c.length)];
    this.crashNode(n.id);
    return n.id;
  }

  /** Flip bits in one piece on disk without telling the system. Returns the piece key. */
  injectRot(id: string): string | null {
    const n = this.nodeById(id);
    if (!n) return null;
    const keys = [...n.store.entries()].filter(([k, e]) => !e.rot && this.refPiece(n.id, k)).map(([k]) => k);
    if (!keys.length) { this.addLog('info', `${n.id} has no pieces to corrupt`); return null; }
    const key = keys[Math.floor(this.rng() * keys.length)];
    const b = n.store.get(key)!.bytes.slice();
    for (let i = 0; i < 3; i++) {
      const at = Math.floor(this.rng() * b.length);
      b[at] ^= 1 << (1 + Math.floor(this.rng() * 7));
    }
    const orig = n.store.get(key)!.bytes;
    if (b.every((v, i) => v === orig[i])) b[0] ^= 0x01; // guarantee the bytes really changed
    n.store.set(key, { bytes: b, rot: true });
    this.addLog('fault', `Flipped 3 bits in a piece of ${parseKey(key).name} on ${n.id}. The system was not told`);
    return key;
  }

  setIsolated(iso: boolean): void {
    if (iso === this.isolated) return;
    this.isolated = iso;
    this.nodes.filter((n) => n.rack === 'C').forEach((n) => { n.reachable = !iso; });
    this.meta.filter((m) => m.rack === 'C').forEach((m) => { m.reachable = !iso; });
    this.addLog(iso ? 'fault' : 'heal', iso ? 'Network partition: rack C is cut off from the rest of the cluster' : 'Network healed: rack C reconnected');
  }

  addNode(): StorageNode {
    const counts = RACKS.map((r) => this.nodes.filter((n) => n.rack === r).length);
    const rack = RACKS[counts.indexOf(Math.min(...counts))];
    const n = this.makeNode(`n${++this.nodeSeq}`, rack);
    this.nodes.push(n);
    this.addLog('info', `${n.id} joined rack ${rack}`);
    this.planRebalance(n);
    return n;
  }

  toggleMeta(id: string): void {
    const m = this.meta.find((x) => x.id === id);
    if (!m) return;
    m.up = !m.up;
    this.addLog(m.up ? 'info' : 'fault', m.up ? `Metadata node ${m.id} restarted` : `Metadata node ${m.id} crashed`);
  }

  /* ------------------------------------------------------------- derived views */

  objectHealth(o: VaultObject): ObjectHealth {
    const pol = POLICIES[o.policy];
    let ok = 0, warn = 0, bad = 0;
    let worst: ObjectHealth['worst'] = 'ok';
    const rank = { ok: 0, deg: 1, risk: 2, lost: 3 } as const;
    for (const sg of o.segments) {
      let good = 0;
      for (const p of sg.pieces) {
        const st = this.pieceState(p);
        if (st === 'ok') { ok++; good++; } else if (st === 'unavailable') warn++; else bad++;
      }
      const h: ObjectHealth['worst'] = good < minNeeded(pol) ? 'lost' : good === sg.pieces.length ? 'ok' : good === minNeeded(pol) ? 'risk' : 'deg';
      if (rank[h] > rank[worst]) worst = h;
    }
    return { ok, warn, bad, worst };
  }

  silentRotCount(): number {
    let c = 0;
    for (const n of this.nodes) for (const [k, e] of n.store) if (e.rot) {
      const p = this.refPiece(n.id, k);
      if (p && !p.corrupt) c++;
    }
    return c;
  }

  overhead(): { rows: { policy: PolicyKey; objects: number; logical: number; raw: number }[]; logical: number; raw: number } {
    const map = new Map<PolicyKey, { policy: PolicyKey; objects: number; logical: number; raw: number }>();
    let logical = 0, raw = 0;
    for (const o of this.objects.values()) {
      const r = map.get(o.policy) ?? { policy: o.policy, objects: 0, logical: 0, raw: 0 };
      let bytes = 0;
      for (const sg of o.segments) for (const p of sg.pieces) bytes += p.len;
      r.objects++; r.logical += o.size; r.raw += bytes;
      map.set(o.policy, r);
      logical += o.size; raw += bytes;
    }
    return { rows: [...map.values()], logical, raw };
  }

  headline(): { tone: 'ok' | 'warn' | 'bad'; text: string } {
    const total = this.objects.size;
    if (!this.leader) return { tone: 'bad', text: 'Metadata quorum lost. Reads continue, writes are paused' };
    if (this.unreadable.size) return { tone: 'bad', text: `${this.unreadable.size} ${this.unreadable.size === 1 ? 'object is' : 'objects are'} unreadable until nodes return` };
    if (this.degraded) return { tone: 'warn', text: `Self-healing: ${this.degraded} ${this.degraded === 1 ? 'piece' : 'pieces'} below target, every object still readable` };
    return { tone: 'ok', text: total === 1 ? 'The only object is fully protected' : `All ${total} objects fully protected` };
  }

  /* ------------------------------------------------------------------- demo data */

  async seedDemo(): Promise<void> {
    if (this.seeded) return;
    this.seeded = true;
    const seeds: [string, number, PolicyKey][] = [
      ['lectures/distributed-systems-01.mp4', 3_000_000, 'ec42'],
      ['backups/postgres-2026-09-25.tar', 2_100_000, 'ec42'],
      ['datasets/sensor-readings.csv', 1_200_000, 'rep3'],
      ['images/campus-map.png', 700_000, 'rep2'],
      ['configs/cluster.yaml', 18_000, 'rep3'],
    ];
    for (const [name, size, pol] of seeds) await this.putObject(name, randomBytes(size), pol, { quiet: true });
    this.addLog('info', `Cluster up: ${this.nodes.length} storage nodes in ${RACKS.length} racks, metadata leader ${this.leader}, ${this.objects.size} objects loaded`);
  }
}