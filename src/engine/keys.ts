/**
 * Piece keys identify one stored piece: `${object}@${version}#${segment}.${piece}`.
 * Parsing uses the last '@', so object names may themselves contain '@' or '#'.
 */
export const pieceKey = (name: string, version: number, s: number, i: number): string => `${name}@${version}#${s}.${i}`;

export function parseKey(k: string): { name: string; ver: number; s: number; i: number } {
  const a = k.lastIndexOf('@');
  const [ver, si = ''] = k.slice(a + 1).split('#');
  const [s, i] = si.split('.');
  return { name: k.slice(0, a), ver: Number(ver), s: Number(s), i: Number(i) };
}