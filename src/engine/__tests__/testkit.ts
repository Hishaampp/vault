import { VaultCluster, type ClusterOptions } from '../cluster';
import { mulberry32 } from '../hash';

/** Deterministic bytes so failures are reproducible. */
export function bytesOf(n: number, seed = 1): Uint8Array {
  const r = mulberry32(seed);
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = Math.floor(r() * 256);
  return b;
}

/**
 * A cluster on a fake clock with background traffic and scrubbing off,
 * so each test controls exactly what happens.
 */
export function setup(opts: ClusterOptions = {}) {
  let t = 0;
  const cluster = new VaultCluster({
    clock: () => t,
    rng: mulberry32(42),
    traffic: false,
    scrub: false,
    transferScale: 0.2,
    ...opts,
  });
  /** Advance fake time in 100ms control-loop steps, letting async work finish. */
  const advance = async (ms: number, step = 100) => {
    for (let x = 0; x < ms; x += step) {
      t += step;
      cluster.tick();
      await cluster.idle();
    }
  };
  /** Keep ticking until `done()` holds, failing after `limitMs`. */
  const until = async (done: () => boolean, limitMs = 60_000) => {
    for (let x = 0; x < limitMs; x += 100) {
      if (done()) return x;
      await advance(100);
    }
    throw new Error('condition not reached in time');
  };
  return { cluster, advance, until, now: () => t };
}

export const fullyProtected = (c: VaultCluster) => c.degraded === 0 && c.queue.length === 0 && c.inflight.length === 0;

/** Fast byte comparison (deep-equal on megabyte arrays is very slow). */
export function sameBytes(a: Uint8Array | undefined, b: Uint8Array): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
