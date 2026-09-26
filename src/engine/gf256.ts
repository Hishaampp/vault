/**
 * Arithmetic in GF(2^8) and a systematic Reed-Solomon code built from a
 * Cauchy matrix. Any k of the k+m shards are enough to rebuild the rest.
 */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

export const gmul = (a: number, b: number): number => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

export const ginv = (a: number): number => {
  if (a === 0) throw new RangeError('0 has no inverse in GF(256)');
  return EXP[255 - LOG[a]];
};

const cache = new Map<string, number[][]>();

/** (k+m) x k encoding matrix: identity on top, Cauchy rows below. */
export function encMatrix(k: number, m: number): number[][] {
  const key = `${k}+${m}`;
  const hit = cache.get(key);
  if (hit) return hit;
  if (k + m > 256) throw new RangeError('k + m must be at most 256');
  const M: number[][] = [];
  for (let i = 0; i < k; i++) {
    const r = new Array<number>(k).fill(0);
    r[i] = 1;
    M.push(r);
  }
  for (let i = 0; i < m; i++) {
    const r: number[] = [];
    for (let j = 0; j < k; j++) r.push(ginv((k + i) ^ j));
    M.push(r);
  }
  cache.set(key, M);
  return M;
}

/** Gauss-Jordan inversion over GF(256). Throws on a singular matrix. */
export function invertMat(A: number[][]): number[][] {
  const n = A.length;
  const M = A.map((r, i) => r.concat(Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))));
  for (let c = 0; c < n; c++) {
    let p = c;
    while (p < n && M[p][c] === 0) p++;
    if (p === n) throw new Error('singular matrix');
    [M[c], M[p]] = [M[p], M[c]];
    const iv = ginv(M[c][c]);
    for (let j = 0; j < 2 * n; j++) M[c][j] = gmul(M[c][j], iv);
    for (let r = 0; r < n; r++) {
      if (r !== c && M[r][c] !== 0) {
        const f = M[r][c];
        for (let j = 0; j < 2 * n; j++) M[r][j] ^= gmul(f, M[c][j]);
      }
    }
  }
  return M.map((r) => r.slice(n));
}

/** out = sum(coefs[i] * srcs[i]) over GF(256), byte by byte. */
export function mulRow(coefs: number[], srcs: Uint8Array[], len: number): Uint8Array {
  const out = new Uint8Array(len);
  const table = new Uint8Array(256);
  for (let i = 0; i < coefs.length; i++) {
    const c = coefs[i];
    if (!c) continue;
    const s = srcs[i];
    if (c === 1) {
      for (let b = 0; b < len; b++) out[b] ^= s[b];
      continue;
    }
    for (let x = 1; x < 256; x++) table[x] = gmul(c, x);
    for (let b = 0; b < len; b++) out[b] ^= table[s[b]];
  }
  return out;
}

/** Split a segment into k padded data shards and compute m parity shards. */
export function ecEncode(k: number, m: number, seg: Uint8Array): { shardLen: number; shards: Uint8Array[] } {
  const L = Math.max(1, Math.ceil(seg.length / k));
  const data: Uint8Array[] = [];
  for (let j = 0; j < k; j++) {
    const d = new Uint8Array(L);
    d.set(seg.subarray(j * L, Math.min(seg.length, (j + 1) * L)));
    data.push(d);
  }
  const M = encMatrix(k, m);
  const parity: Uint8Array[] = [];
  for (let i = 0; i < m; i++) parity.push(mulRow(M[k + i], data, L));
  return { shardLen: L, shards: data.concat(parity) };
}

/** Inverse decode matrices keyed by which shards survived. At most C(k+m, k) entries (15 for 4+2). */
const invCache = new Map<string, number[][]>();

function decodeMatrix(k: number, m: number, idxs: number[]): number[][] {
  const key = `${k}+${m}:${idxs.join(',')}`;
  let inv = invCache.get(key);
  if (!inv) {
    const M = encMatrix(k, m);
    inv = invertMat(idxs.map((i) => M[i]));
    if (invCache.size > 512) invCache.clear();
    invCache.set(key, inv);
  }
  return inv;
}

/**
 * Recover all k data shards from any k available shards with a single matrix
 * inversion (cached per survivor set). Shards that survived are reused as-is.
 */
export function ecDecode(
  k: number,
  m: number,
  avail: { idx: number; bytes: Uint8Array }[],
  shardLen: number,
): Uint8Array[] {
  if (avail.length < k) throw new Error(`need ${k} shards, have ${avail.length}`);
  const use = [...avail].sort((a, b) => a.idx - b.idx).slice(0, k);
  const data: (Uint8Array | undefined)[] = Array.from({ length: k }, () => undefined);
  for (const a of use) if (a.idx < k) data[a.idx] = a.bytes;
  if (data.every((d) => d !== undefined)) return data as Uint8Array[];
  const inv = decodeMatrix(k, m, use.map((a) => a.idx));
  const srcs = use.map((a) => a.bytes);
  for (let j = 0; j < k; j++) if (!data[j]) data[j] = mulRow(inv[j], srcs, shardLen);
  return data as Uint8Array[];
}

/** Rebuild shard `idx` from any k available shards. */
export function ecRebuild(
  k: number,
  m: number,
  avail: { idx: number; bytes: Uint8Array }[],
  idx: number,
  shardLen: number,
): Uint8Array {
  if (avail.length < k) throw new Error(`need ${k} shards, have ${avail.length}`);
  const direct = avail.find((a) => a.idx === idx);
  if (direct) return direct.bytes.slice();
  const data = ecDecode(k, m, avail, shardLen);
  return idx < k ? data[idx].slice() : mulRow(encMatrix(k, m)[idx], data, shardLen);
}

/** Join decoded data shards back into the original segment bytes. */
export function joinShards(data: Uint8Array[], shardLen: number, len: number): Uint8Array {
  const out = new Uint8Array(data.length * shardLen);
  data.forEach((d, j) => out.set(d, j * shardLen));
  return out.subarray(0, len);
}