import { useRef } from 'react';
import type { ClusterActions, ClusterSnapshot } from '../engine/snapshot';
import { ChaosBar } from './ChaosBar';
import { FlowOverlay } from './FlowOverlay';
import { MetaCluster } from './MetaCluster';
import { NodeTile } from './NodeTile';

interface Props {
  snap: ClusterSnapshot;
  at: number;
  actions: ClusterActions;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onChange: () => void;
}

export function Topology({ snap, at, actions, selected, onSelect, onChange }: Props) {
  const ref = useRef<HTMLElement>(null);
  const receiving = new Set(snap.flights.map((f) => f.target));
  return (
    <section className="floor" ref={ref} aria-labelledby="floor-title">
      <div className="floor-head">
        <h2 id="floor-title">Storage nodes</h2>
        <MetaCluster snap={snap} actions={actions} onChange={onChange} />
      </div>
      <div className="racks">
        {snap.racks.map((r) => {
          const cut = snap.isolated && r === 'C';
          return (
            <div className="rack" key={r} data-cut={cut || undefined}>
              <h3><span>Rack {r}</span>{cut && <span className="cut">Cut off by partition</span>}</h3>
              <div className="rack-nodes">
                {snap.nodes.filter((n) => n.rack === r).map((n) => (
                  <NodeTile
                    key={n.id}
                    node={n}
                    hues={snap.hues}
                    selected={selected === n.id}
                    receiving={receiving.has(n.id)}
                    onSelect={(id) => onSelect(selected === id ? null : id)}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <div className="legend">
        <span>Each square is one stored piece, colored by object</span>
        <span><i style={{ background: 'var(--ok)' }} />Online</span>
        <span><i style={{ background: 'var(--warn)' }} />Missed heartbeats</span>
        <span><i style={{ background: 'var(--off)' }} />Unreachable</span>
        <span><i style={{ background: 'var(--bad)' }} />Declared dead</span>
        <span><i style={{ background: 'var(--repair)' }} />Repair traffic</span>
      </div>
      <FlowOverlay flights={snap.flights} at={at} containerRef={ref} />
      <ChaosBar snap={snap} actions={actions} selected={selected} onChange={onChange} />
    </section>
  );
}
