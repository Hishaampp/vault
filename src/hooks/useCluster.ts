import { useCallback, useEffect, useRef, useState } from 'react';
import { VaultCluster } from '../engine/cluster';

export interface UseClusterOptions {
  /** load demo objects on mount */
  seed?: boolean;
  /** run the control-plane loop (tests drive ticks manually) */
  running?: boolean;
  /** UI refresh interval in ms */
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
    const loop = running ? window.setInterval(() => cluster.tick(), 100) : undefined;
    const paint = window.setInterval(refresh, refreshMs);
    return () => {
      window.clearInterval(loop);
      window.clearInterval(paint);
    };
  }, [cluster, seed, running, refreshMs, refresh]);

  return { cluster, version, refresh };
}
