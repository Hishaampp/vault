import { RACKS, parseKey, type VaultCluster } from './cluster';
import type { ClusterActions, ClusterSnapshot, NodeInfo } from './snapshot';

/** Build a dashboard snapshot from the in-browser simulator. */
export function snapshotOf(c: VaultCluster): ClusterSnapshot {
  const now = c.clock();
  const nodes: NodeInfo[] = c.nodes.map((n) => {
    let bytes = 0;
    const pieces = [...n.store].map(([key, e]) => {
      bytes += e.bytes.length;
      const p = c.refPiece(n.id, key);
      return { key, name: parseKey(key).name, corrupt: !!p?.corrupt, rot: e.rot && !p?.corrupt };
    });
    return { id: n.id, rack: n.rack, up: n.up, reachable: n.reachable, status: n.status, pieceCount: n.store.size, bytes, pieces };
  });
  return {
    mode: 'simulated',
    now,
    startedAt: c.startedAt,
    ready: c.seeded || c.objects.size > 0,
    racks: [...RACKS],
    nodes,
    meta: c.meta.map((m) => ({ ...m, leader: c.leader === m.id })),
    metaLabel: 'Metadata cluster (Raft)',
    term: c.term,
    quorum: c.hasQuorum(),
    objects: [...c.objects.values()],
    flights: c.inflight.map((f) => ({
      kind: f.job.kind, obj: f.job.obj, ver: f.job.ver, s: f.job.s, idx: f.job.idx,
      srcs: f.srcs.map((x) => x.node), target: f.target, elapsed: now - f.t0, dur: f.dur,
    })),
    queueLength: c.queue.length,
    log: c.log,
    series: c.series,
    settings: c.settings,
    isolated: c.isolated,
    recovery: c.recovery,
    degraded: c.degraded,
    atRisk: c.atRisk,
    unreadable: [...c.unreadable],
    scrub: { enabled: c.settings.scrub, passes: c.scrub.passes, found: c.scrub.found, progress: c.scrubProgress() },
    repaired: c.stats.repaired,
    silentRot: c.silentRotCount(),
    hues: Object.fromEntries(c.hues),
  };
}

/** Dashboard actions backed by the in-browser simulator. */
export function localActions(c: VaultCluster): ClusterActions {
  return {
    crashNode: (id) => c.crashNode(id),
    restartNode: (id) => c.restartNode(id),
    injectRot: (id) => c.injectRot(id),
    crashRandomNode: () => c.crashRandomNode(),
    setIsolated: (on) => c.setIsolated(on),
    addNode: () => c.addNode(),
    toggleMeta: (id) => c.toggleMeta(id),
    updateSettings: (patch) => { Object.assign(c.settings, patch); },
    putObject: (name, bytes, policy) => c.putObject(name, bytes, policy),
    readObject: (name) => c.readObject(name),
    deleteObject: (name) => c.deleteObject(name),
    note: (kind, msg) => c.addLog(kind, msg),
  };
}
