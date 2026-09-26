import { useCallback, useEffect, useRef, useState } from 'react';
import { VaultCluster } from '../engine/cluster';

export interface UseClusterOptions {
  /** load demo objects on mount */
  seed?: boolean;
  /** run the control-plane loop (tests drive ticks manually) */
  running?: boolean;
  /** minimum ms between repaints */
  refreshMs?: number;
}

/**
 * Owns one VaultCluster for the lifetime of the component tree, drives its
 * control loop, and re-renders the UI a few times per second.
 */
export function useCluster(injected?: VaultCluster, opts: UseClusterOptions = {}) {
  const { seed = true, running = true, refreshMs = 250 } = opts;
  const ref = useRef<VaultCluster | null>(null);
  if (!ref.current) ref.current = injected ?? new VaultCluster();
  const cluster = ref.current;
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    if (seed && !cluster.seeded) cluster.seedDemo().then(refresh);
    // Repaint when the cluster changes, at most once per `refreshMs`.
    let last = 0;
    let pending: number | undefined;
    const schedule = () => {
      if (pending !== undefined) return;
      const wait = Math.max(0, last + refreshMs - performance.now());
      if (wait === 0) { last = performance.now(); refresh(); return; }
      pending = window.setTimeout(() => { pending = undefined; last = performance.now(); refresh(); }, wait);
    };
    const off = cluster.subscribe(schedule);
    const loop = running ? window.setInterval(() => cluster.tick(), 100) : undefined;
    return () => {
      off();
      window.clearInterval(loop);
      window.clearTimeout(pending);
    };
  }, [cluster, seed, running, refreshMs, refresh]);

  return { cluster, version, refresh };
}