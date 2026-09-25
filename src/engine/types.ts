export type NodeStatus = 'healthy' | 'suspect' | 'unreachable' | 'dead';
export type PieceState = 'ok' | 'unavailable' | 'missing' | 'corrupt';
export type LogKind = 'fault' | 'warn' | 'bad' | 'heal' | 'repair' | 'info';
export type PolicyKey = 'rep3' | 'rep2' | 'ec42';

export interface Policy {
  key: PolicyKey;
  label: string;
  type: 'rep' | 'ec';
  /** replica count (replication) */
  n?: number;
  /** data shards (erasure coding) */
  k?: number;
  /** parity shards (erasure coding) */
  m?: number;
  /** segment size in bytes */
  seg: number;
  help: string;
}

export interface StoredPiece {
  bytes: Uint8Array;
  /** god-view flag: bytes were corrupted on disk; the system is NOT told */
  rot: boolean;
}

export interface StorageNode {
  id: string;
  rack: string;
  up: boolean;
  reachable: boolean;
  lastBeat: number;
  status: NodeStatus;
  store: Map<string, StoredPiece>;
}

export interface MetaNode {
  id: string;
  rack: string;
  up: boolean;
  reachable: boolean;
}

export interface PieceMeta {
  idx: number;
  node: string | null;
  sum: string;
  len: number;
  corrupt: boolean;
}

export interface Segment {
  len: number;
  shardLen: number;
  pieces: PieceMeta[];
}

export interface VaultObject {
  name: string;
  size: number;
  sha: string;
  policy: PolicyKey;
  version: number;
  segments: Segment[];
  created: number;
}

export interface Job {
  kind: 'repair' | 'move';
  key: string;
  obj: string;
  ver: number;
  s: number;
  idx: number;
  from?: string;
  to?: string;
  added: number;
  pri?: number;
}

export interface Flight {
  job: Job;
  srcs: { idx: number; node: string }[];
  target: string;
  inPlace: boolean;
  t0: number;
  dur: number;
  busy: boolean;
}

export interface LogEntry {
  id: number;
  t: number;
  kind: LogKind;
  msg: string;
}

export interface WriteResult {
  ok: boolean;
  reason?: string;
  obj?: VaultObject;
}

export interface ReadResult {
  ok: boolean;
  reason?: string;
  size?: number;
  sha?: string;
  expected?: string;
  skipped?: number;
  decoded?: number;
  bytes?: Uint8Array;
}

export type Health = 'ok' | 'deg' | 'risk' | 'lost';

export interface ObjectHealth {
  ok: number;
  warn: number;
  bad: number;
  worst: Health;
}

export interface Settings {
  policy: PolicyKey;
  deadTimeout: number;
  concurrency: number;
  scrub: boolean;
  traffic: boolean;
}
