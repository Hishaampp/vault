/**
 * Placement policy shared by the in-browser simulator and the Node.js backend.
 * Pure functions: no I/O, no cluster state, easy to test.
 */
import { hash32 } from './hash';

export interface Placeable {
  id: string;
  rack: string;
}

/**
 * Rendezvous (highest-random-weight) hashing with even rack spreading: nodes are
 * ranked per key, then dealt round-robin across racks. A 4+2 segment therefore
 * lands 2-2-2 over three racks and survives losing any whole rack, and adding a
 * node only moves the keys that now rank it highest.
 */
export function placeAcrossRacks<T extends Placeable>(candidates: T[], key: string, count: number): T[] {
  const score = (n: T) => hash32(`${key}|${n.id}`);
  const byRack = new Map<string, T[]>();
  for (const n of [...candidates].sort((a, b) => score(b) - score(a))) {
    const list = byRack.get(n.rack) ?? [];
    list.push(n);
    byRack.set(n.rack, list);
  }
  const racks = [...byRack.values()].sort((a, b) => score(b[0]) - score(a[0]));
  const out: T[] = [];
  while (out.length < count) {
    let progressed = false;
    for (const list of racks) {
      if (out.length >= count) break;
      const n = list.shift();
      if (n) { out.push(n); progressed = true; }
    }
    if (!progressed) break;
  }
  return out;
}

/** How many live pieces of one segment each rack holds, optionally ignoring one piece. */
export function rackLoad(
  pieces: { node: string | null }[],
  rackOf: (nodeId: string) => string | undefined,
  exclude = -1,
): Map<string, number> {
  const load = new Map<string, number>();
  pieces.forEach((q, i) => {
    const r = i !== exclude && q.node ? rackOf(q.node) : undefined;
    if (r) load.set(r, (load.get(r) ?? 0) + 1);
  });
  return load;
}

/**
 * Choose where to rebuild a missing piece: a node holding no other piece of the
 * segment, on the least-loaded rack for that segment, then the least-full node.
 * `refs` must be precomputed once per scheduling pass (not per comparison).
 */
export function pickRepairTarget<T extends Placeable>(
  candidates: T[],
  used: Set<string>,
  load: Map<string, number>,
  refs: Map<string, number>,
  key: string,
): T | null {
  const cands = candidates.filter((n) => !used.has(n.id));
  if (!cands.length) return null;
  cands.sort((a, b) =>
    (load.get(a.rack) ?? 0) - (load.get(b.rack) ?? 0)
    || (refs.get(a.id) ?? 0) - (refs.get(b.id) ?? 0)
    || hash32(key + b.id) - hash32(key + a.id));
  return cands[0];
}