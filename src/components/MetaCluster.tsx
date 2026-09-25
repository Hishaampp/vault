import type { ClusterActions, ClusterSnapshot } from '../engine/snapshot';

interface Props {
  snap: ClusterSnapshot;
  actions: ClusterActions;
  onChange: () => void;
}

export function MetaCluster({ snap, actions, onChange }: Props) {
  return (
    <div className="meta-wrap">
      <span className="meta-label">{snap.metaLabel}</span>
      <div className="meta">
        {snap.meta.map((m) => {
          const state = !m.up ? 'down' : !m.reachable ? 'cut' : 'up';
          const stateText = state === 'up' ? 'online' : state === 'down' ? 'crashed' : 'cut off';
          return (
            <button
              key={m.id}
              type="button"
              className="mpill mono"
              data-state={state}
              aria-label={`Metadata node ${m.id}${m.leader ? ', leader' : ''}, ${stateText}. ${m.up ? 'Crash' : 'Restart'} it`}
              onClick={async () => { await actions.toggleMeta(m.id); onChange(); }}
            >
              <i aria-hidden="true" />
              {m.id}
              {m.leader && <span className="lead">leader</span>}
            </button>
          );
        })}
        {snap.term !== null && <span className="term mono">term {snap.term}</span>}
      </div>
    </div>
  );
}
