/**
 * The dashboard renders a ClusterSnapshot and calls ClusterActions.
 * Both the in-browser simulator and the real Node.js backend produce the
 * same snapshot shape, so one UI drives either of them.
 */
import { POLICIES, minNeeded } from './policies';
import type {
  LogEntry, LogKind, NodeStatus, ObjectHealth, PieceMeta, PieceState, PolicyKey,
  ReadResult, Settings, VaultObject, WriteResult,
} from './types';

export interface NodePieceInfo {
  key: string;
  name: string;
  /** the system knows this piece is corrupt */
  corrupt: boolean;
  /** demo god-view: corrupted by fault injection and not yet detected */
  rot: boolean;
}

export interface NodeInfo {
  id: string;
  rack: string;
  /** process is running */
  up: boolean;
  /** not cut off by a network partition */
  reachable: boolean;
  status: NodeStatus;
  pieceCount: number;
  bytes: number;
  pieces: NodePieceInfo[];
}

export interface MetaInfo {
  id: string;
  rack: string;
  up: boolean;
  reachable: boolean;
  leader: boolean;
}

export interface FlightInfo {
  kind: 'repair' | 'move';
  obj: string;
  ver: number;
  s: number;
  idx: number;
  srcs: string[];
  target: string;
  /** ms since the transfer started, at snapshot time */
  elapsed: number;
  /** expected total ms */
  dur: number;
}

export interface Series {
  t: number[];
  rps: number[];
  wps: number[];
  fps: number[];
  p99: number[];
  q: number[];
  marks: number[];
}

export interface LiveSettings extends Settings {
  /** repair bandwidth limit per transfer in MB/s (live backend only) */
  bandwidth?: number;
}

export interface ClusterSnapshot {
  mode: 'simulated' | 'live';
  now: number;
  startedAt: number;
  ready: boolean;
  racks: string[];
  nodes: NodeInfo[];
  meta: MetaInfo[];
  metaLabel: string;
  term: number | null;
  quorum: boolean;
  objects: VaultObject[];
  flights: FlightInfo[];
  queueLength: number;
  log: LogEntry[];
  series: Series;
  settings: LiveSettings;
  isolated: boolean;
  recovery: { start: number | null; last: number | null };
  degraded: number;
  atRisk: number;
  unreadable: string[];
  scrub: { enabled: boolean; passes: number; found: number; progress: number };
  repaired: number;
  silentRot: number;
  hues: Record<string, string>;
  /** live backend only: state-changing requests need an API token */
  authRequired?: boolean;
}

export interface ClusterActions {
  crashNode(id: string): unknown;
  restartNode(id: string): unknown;
  injectRot(id: string): unknown;
  crashRandomNode(): unknown;
  setIsolated(on: boolean): unknown;
  addNode(): unknown;
  toggleMeta(id: string): unknown;
  updateSettings(patch: Partial<LiveSettings>): unknown;
  putObject(name: string, bytes: Uint8Array, policy: PolicyKey): Promise<WriteResult>;
  readObject(name: string): Promise<ReadResult>;
  deleteObject(name: string): unknown;
  note(kind: LogKind, msg: string): unknown;
}

/* ------------------------------------------------------------ pure helpers */

export type NodeLookup = Map<string, { status: NodeStatus; up: boolean; reachable: boolean }>;

export const nodeLookup = (nodes: NodeInfo[]): NodeLookup => new Map(nodes.map((n) => [n.id, n]));

export function pieceStateIn(nodes: NodeLookup, p: PieceMeta): PieceState {
  const n = p.node ? nodes.get(p.node) : undefined;
  if (!n || n.status === 'dead') return 'missing';
  if (p.corrupt) return 'corrupt';
  if (!(n.up && n.reachable)) return 'unavailable';
  return 'ok';
}

export function objectHealthIn(nodes: NodeLookup, o: VaultObject): ObjectHealth {
  const pol = POLICIES[o.policy];
  const rank = { ok: 0, deg: 1, risk: 2, lost: 3 } as const;
  let ok = 0, warn = 0, bad = 0;
  let worst: ObjectHealth['worst'] = 'ok';
  for (const sg of o.segments) {
    let good = 0;
    for (const p of sg.pieces) {
      const st = pieceStateIn(nodes, p);
      if (st === 'ok') { ok++; good++; } else if (st === 'unavailable') warn++; else bad++;
    }
    const need = minNeeded(pol);
    const h: ObjectHealth['worst'] = good < need ? 'lost' : good === sg.pieces.length ? 'ok' : good === need ? 'risk' : 'deg';
    if (rank[h] > rank[worst]) worst = h;
  }
  return { ok, warn, bad, worst };
}

export function headlineOf(s: ClusterSnapshot): { tone: 'ok' | 'warn' | 'bad'; text: string } {
  if (!s.ready) return { tone: 'ok', text: s.mode === 'live' ? 'Connecting to the cluster…' : 'Starting cluster…' };
  const total = s.objects.length;
  if (!s.quorum) return { tone: 'bad', text: 'Metadata quorum lost. Reads continue, writes are paused' };
  const u = s.unreadable.length;
  if (u) return { tone: 'bad', text: `${u} ${u === 1 ? 'object is' : 'objects are'} unreadable until nodes return` };
  if (s.degraded) return { tone: 'warn', text: `Self-healing: ${s.degraded} ${s.degraded === 1 ? 'piece' : 'pieces'} below target, every object still readable` };
  return { tone: 'ok', text: total === 1 ? 'The only object is fully protected' : `All ${total} objects fully protected` };
}

export interface OverheadRow { policy: PolicyKey; objects: number; logical: number; raw: number }

export function overheadOf(objects: VaultObject[]): { rows: OverheadRow[]; logical: number; raw: number } {
  const map = new Map<PolicyKey, OverheadRow>();
  let logical = 0, raw = 0;
  for (const o of objects) {
    const r = map.get(o.policy) ?? { policy: o.policy, objects: 0, logical: 0, raw: 0 };
    let bytes = 0;
    for (const sg of o.segments) for (const p of sg.pieces) bytes += p.len;
    r.objects++; r.logical += o.size; r.raw += bytes;
    map.set(o.policy, r);
    logical += o.size; raw += bytes;
  }
  return { rows: [...map.values()], logical, raw };
}

export const emptySeries = (): Series => ({ t: [], rps: [], wps: [], fps: [], p99: [], q: [], marks: [] });
