import { pieceKey } from '../engine/cluster';
import { fmtBytes } from '../engine/format';
import { POLICIES, pieceCount } from '../engine/policies';
import { pieceStateIn, type ClusterSnapshot, type NodeLookup } from '../engine/snapshot';
import type { VaultObject } from '../engine/types';

export interface VerifyMessage {
  name: string;
  ok: boolean;
  text: string;
}

interface Props {
  snap: ClusterSnapshot;
  nodes: NodeLookup;
  obj: VaultObject;
  verify: VerifyMessage | null;
  verifying: boolean;
  onVerify: () => void;
  onDelete: () => void;
}

const STATE_TEXT = { ok: 'Healthy', unavailable: 'Node not responding', missing: 'Lost with its node', corrupt: 'Corrupt', repairing: 'Being repaired' } as const;

export function ChunkMap({ snap, nodes, obj, verify, verifying, onVerify, onDelete }: Props) {
  const pol = POLICIES[obj.policy];
  const cols = pieceCount(pol);
  const repairing = new Set(snap.flights.filter((f) => f.obj === obj.name && f.ver === obj.version).map((f) => `${f.s}.${f.idx}`));
  const silent = new Set(snap.nodes.flatMap((n) => n.pieces.filter((p) => p.rot).map((p) => `${n.id}|${p.key}`)));
  const heads = Array.from({ length: cols }, (_, i) =>
    pol.type === 'rep' ? `Copy ${i + 1}` : i < pol.k! ? `Data ${i + 1}` : `Parity ${i - pol.k! + 1}`);

  return (
    <div className="map">
      <div className="map-head">
        <div className="map-title">
          <h3 className="mono">{obj.name}</h3>
          <p className="facts">
            {fmtBytes(obj.size)}, {pol.label}, version {obj.version}, {obj.segments.length} segment{obj.segments.length === 1 ? '' : 's'} of {cols} pieces
            <br />SHA-256 <span className="mono">{obj.sha.slice(0, 16)}…</span>
          </p>
        </div>
        <div className="map-actions">
          {snap.mode === 'live' && (
            <a className="btn" href={`/api/objects/${encodeURIComponent(obj.name)}`} download={obj.name.split('/').pop()}>Download</a>
          )}
          <button type="button" className="btn primary" onClick={onVerify} disabled={verifying}>{verifying ? 'Reading…' : 'Read and verify'}</button>
          <button type="button" className="btn danger" onClick={onDelete}>Delete</button>
        </div>
      </div>
      <div className="cmap-wrap">
        <div className="cmap" style={{ ['--cols' as string]: cols }} role="table" aria-label={`Piece placement for ${obj.name}`}>
          <div role="row" className="cmap-row">
            <div role="columnheader" className="hd"><span className="sr-only">Segment</span></div>
            {heads.map((h) => <div role="columnheader" className="hd" key={h}>{h}</div>)}
          </div>
          {obj.segments.map((sg, s) => (
            <div role="row" className="cmap-row" key={s}>
              <div role="rowheader" className="rl">Seg {s + 1}</div>
              {sg.pieces.map((p, i) => {
                const base = pieceStateIn(nodes, p);
                const st = repairing.has(`${s}.${i}`) ? 'repairing' : base;
                const rot = !p.corrupt && silent.has(`${p.node}|${pieceKey(obj.name, obj.version, s, i)}`);
                const label = base === 'missing' ? (p.node ? `${p.node}✕` : 'none') : p.node;
                return (
                  <div role="cell" className="cell" data-state={st} key={i} title={STATE_TEXT[st]}>
                    {label}
                    {rot && <span className="rotdot" title="Silently corrupted, not yet detected" />}
                    <span className="sr-only">, {STATE_TEXT[st]}</span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      {verify && verify.name === obj.name && (
        <div className={`verify ${verify.ok ? 'ok' : 'bad'}`} role="status">{verify.text}</div>
      )}
    </div>
  );
}
