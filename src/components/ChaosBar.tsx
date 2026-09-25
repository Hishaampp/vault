import type { ClusterActions, ClusterSnapshot } from '../engine/snapshot';

interface Props {
  snap: ClusterSnapshot;
  actions: ClusterActions;
  selected: string | null;
  onChange: () => void;
}

export function ChaosBar({ snap, actions, selected, onChange }: Props) {
  const n = snap.nodes.find((x) => x.id === selected);
  const act = (fn: () => unknown) => async () => { await fn(); onChange(); };
  const usable = !!n && n.up && n.reachable && n.status !== 'dead';
  return (
    <div className="chaos" role="toolbar" aria-label="Fault injection">
      <div className="grp">
        {n ? (
          <>
            <span className="who">Selected <b className="mono">{n.id}</b> in rack {n.rack}</span>
            <button type="button" className="btn danger" disabled={!n.up} onClick={act(() => actions.crashNode(n.id))}>Crash node</button>
            <button type="button" className="btn" disabled={n.up} onClick={act(() => actions.restartNode(n.id))}>Restart node</button>
            <button type="button" className="btn danger" disabled={!usable || !n.pieceCount} onClick={act(() => actions.injectRot(n.id))}>Inject bit rot</button>
          </>
        ) : (
          <span className="who">Select a node to crash it or corrupt its data. Click a metadata node to crash it.</span>
        )}
      </div>
      <div className="grp">
        <button type="button" className="btn danger" onClick={act(() => actions.crashRandomNode())}>Crash a random node</button>
        <button type="button" className={`btn ${snap.isolated ? 'primary' : 'danger'}`} onClick={act(() => actions.setIsolated(!snap.isolated))}>
          {snap.isolated ? 'Heal network' : 'Partition rack C'}
        </button>
        <button type="button" className="btn" onClick={act(() => actions.addNode())}>Add a node</button>
      </div>
    </div>
  );
}
