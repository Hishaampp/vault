import type { Policy, PolicyKey } from './types';

export const POLICIES: Record<PolicyKey, Policy> = {
  rep3: {
    key: 'rep3', label: 'Replicate ×3', type: 'rep', n: 3, seg: 256 * 1024,
    help: 'Three full copies in different racks. Survives 2 failures, costs 200% extra space.',
  },
  rep2: {
    key: 'rep2', label: 'Replicate ×2', type: 'rep', n: 2, seg: 256 * 1024,
    help: 'Two full copies. Survives 1 failure, costs 100% extra space.',
  },
  ec42: {
    key: 'ec42', label: 'Erasure 4+2', type: 'ec', k: 4, m: 2, seg: 512 * 1024,
    help: '4 data + 2 parity pieces. Survives any 2 failures, costs only 50% extra space.',
  },
};

export const POLICY_KEYS = Object.keys(POLICIES) as PolicyKey[];
export const pieceCount = (p: Policy): number => (p.type === 'rep' ? p.n! : p.k! + p.m!);
/** Minimum valid pieces needed to read a segment. */
export const minNeeded = (p: Policy): number => (p.type === 'rep' ? 1 : p.k!);
/** Pieces that must be durably written before a PUT is acknowledged. */
export const writeQuorum = (p: Policy): number => (p.type === 'rep' ? Math.floor(p.n! / 2) + 1 : p.k! + 1);
/** Failures a segment can absorb without losing data. */
export const faultTolerance = (p: Policy): number => pieceCount(p) - minNeeded(p);
