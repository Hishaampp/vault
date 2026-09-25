import { useEffect, useMemo, useRef, useState } from 'react';
import type { VaultCluster } from '../engine/cluster';
import { localActions, snapshotOf } from '../engine/localAdapter';
import type { ClusterActions, ClusterSnapshot } from '../engine/snapshot';
import { RemoteCluster } from '../live/remote';
import { useCluster, type UseClusterOptions } from './useCluster';

export type VaultMode = 'detecting' | 'simulated' | 'live';

export interface VaultState {
  mode: VaultMode;
  snap: ClusterSnapshot | null;
  /** performance.now() when `snap` was produced, for smooth animation */
  at: number;
  actions: ClusterActions;
  refresh: () => void;
  connected: boolean;
}

/**
 * Chooses a data source: the live Node.js cluster when its API answers,
 * otherwise the in-browser simulator. `?sim` forces the simulator.
 */
export function useVault(injected?: VaultCluster, opts: UseClusterOptions = {}): VaultState {
  const forceSim = !!injected || (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('sim'));
  const [mode, setMode] = useState<VaultMode>(forceSim ? 'simulated' : 'detecting');

  useEffect(() => {
    if (mode !== 'detecting') return;
    let alive = true;
    RemoteCluster.detect().then((live) => { if (alive) setMode(live ? 'live' : 'simulated'); });
    return () => { alive = false; };
  }, [mode]);

  const local = useLocal(mode === 'simulated', injected, opts);
  const remote = useRemote(mode === 'live');

  if (mode === 'live') return { mode, ...remote };
  if (mode === 'simulated' && local) return { mode, ...local };
  return { mode, snap: null, at: 0, actions: NOOP, refresh: () => undefined, connected: false };
}

function useLocal(enabled: boolean, injected: VaultCluster | undefined, opts: UseClusterOptions) {
  const { cluster, refresh } = useCluster(injected, { ...opts, seed: enabled && (opts.seed ?? true), running: enabled && (opts.running ?? true), refreshMs: enabled ? opts.refreshMs : 60_000 });
  const actions = useMemo(() => localActions(cluster), [cluster]);
  if (!enabled) return null;
  return { snap: snapshotOf(cluster), at: performance.now(), actions, refresh, connected: true };
}

function useRemote(enabled: boolean) {
  const ref = useRef<RemoteCluster | null>(null);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const rc = new RemoteCluster();
    ref.current = rc;
    const off = rc.subscribe(() => setTick((t) => t + 1));
    rc.connect();
    return () => { off(); rc.close(); };
  }, [enabled]);
  const rc = ref.current;
  const actions = useMemo(() => (rc ? rc.actions() : NOOP), [rc]);
  return { snap: rc?.snapshot ?? null, at: rc?.receivedAt ?? 0, actions, refresh: () => undefined, connected: !!rc?.connected };
}

const NOOP: ClusterActions = {
  crashNode: () => undefined, restartNode: () => undefined, injectRot: () => undefined, crashRandomNode: () => undefined,
  setIsolated: () => undefined, addNode: () => undefined, toggleMeta: () => undefined, updateSettings: () => undefined,
  putObject: async () => ({ ok: false, reason: 'Not connected' }), readObject: async () => ({ ok: false, reason: 'Not connected' }),
  deleteObject: () => undefined, note: () => undefined,
};
