import { fmtBytes } from '../engine/format';
import type { ClusterActions, ClusterSnapshot, NodeInfo } from '../engine/snapshot';
import { Icon } from './Icon';
import { STATUS_LABEL } from './NodeTile';

const TONE = { healthy: 'ok', suspect: 'warn', unreachable: 'off', dead: 'bad' } as const;

interface Props {
  snap: ClusterSnapshot;
  actions: ClusterActions;
  onChange: () => void;
}

export function StatusBadge({ node }: { node: NodeInfo }) {
  return <span className="badge" data-tone={TONE[node.status]}><i aria-hidden="true" />{STATUS_LABEL[node.status]}</span>;
}

/** Table view of every storage process, metadata replica, and rack. */
export function NodesPage({ snap, actions, onChange }: Props) {
  const act = (fn: () => unknown) => async () => { await fn(); onChange(); };
  const quorum = snap.quorum;
  return (
    <>
      <section className="panel flush">
        <div className="panel-head">
          <div>
            <h2>Storage nodes</h2>
            <p className="panel-sub">
              {snap.mode === 'live'
                ? 'Each node is a separate Node.js process with its own directory on disk.'
                : 'Nodes are simulated in this browser tab.'}
            </p>
          </div>
          <div className="toolbar">
            <button type="button" className="btn danger" onClick={act(() => actions.crashRandomNode())}><Icon name="power" size={15} />Crash random</button>
            <button type="button" className={`btn ${snap.isolated ? 'primary' : 'danger'}`} onClick={act(() => actions.setIsolated(!snap.isolated))}>
              <Icon name="split" size={15} />{snap.isolated ? 'Heal network' : 'Partition rack C'}
            </button>
            <button type="button" className="btn primary" onClick={act(() => actions.addNode())}><Icon name="plus" size={15} />Add node</button>
          </div>
        </div>
        <div className="table-wrap" role="region" tabIndex={0} aria-label="Storage nodes table, scrollable">
          <table className="table">
            <caption className="sr-only">Storage nodes with their rack, status, process state, stored pieces, and actions</caption>
            <thead>
              <tr>
                <th scope="col">Node</th>
                <th scope="col" className="hide-sm">Rack</th>
                <th scope="col">Status</th>
                <th scope="col" className="hide-sm">Process</th>
                <th scope="col" className="num">Pieces</th>
                <th scope="col" className="num">Stored</th>
                <th scope="col" className="act"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {snap.nodes.map((n) => {
                const usable = n.up && n.reachable && n.status !== 'dead';
                return (
                  <tr key={n.id} data-status={n.status}>
                    <td><span className="mono strong">{n.id}</span></td>
                    <td className="hide-sm">Rack {n.rack}</td>
                    <td><StatusBadge node={n} /></td>
                    <td className="muted-cell hide-sm">{n.up ? 'Running' : 'Stopped'}{!n.reachable ? ', cut off' : ''}</td>
                    <td className="num">{n.pieceCount}</td>
                    <td className="num">{fmtBytes(n.bytes)}</td>
                    <td className="act">
                      <div className="row-actions">
                        {n.up
                          ? <button type="button" className="btn sm danger" aria-label={`Crash ${n.id}`} onClick={act(() => actions.crashNode(n.id))}>Crash</button>
                          : <button type="button" className="btn sm" aria-label={`Restart ${n.id}`} onClick={act(() => actions.restartNode(n.id))}>Restart</button>}
                        <button type="button" className="btn sm" aria-label={`Corrupt a piece on ${n.id}`} disabled={!usable || !n.pieceCount} onClick={act(() => actions.injectRot(n.id))}>Corrupt</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid-2">
        <section className="panel">
          <div className="panel-head tight">
            <div>
              <h2>Metadata replicas</h2>
              <p className="panel-sub">{snap.metaLabel}</p>
            </div>
            <span className="badge" data-tone={quorum ? 'ok' : 'bad'}><i aria-hidden="true" />{quorum ? 'Quorum' : 'No quorum'}</span>
          </div>
          <ul className="list">
            {snap.meta.map((m) => {
              const state = !m.up ? { t: 'bad', l: 'Crashed' } : !m.reachable ? { t: 'off', l: 'Cut off' } : { t: 'ok', l: 'Online' };
              return (
                <li key={m.id}>
                  <span className="mono strong">{m.id}</span>
                  <span className="muted-cell">Rack {m.rack}{m.leader ? ', leader' : ''}</span>
                  <span className="badge" data-tone={state.t}><i aria-hidden="true" />{state.l}</span>
                  <button type="button" className={`btn sm ${m.up ? 'danger' : ''}`} aria-label={`${m.up ? 'Crash' : 'Restart'} metadata ${m.id}`} onClick={act(() => actions.toggleMeta(m.id))}>
                    {m.up ? 'Crash' : 'Restart'}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="panel">
          <div className="panel-head tight">
            <div>
              <h2>Racks</h2>
              <p className="panel-sub">Pieces are spread evenly, so losing a whole rack loses no data.</p>
            </div>
          </div>
          <ul className="list">
            {snap.racks.map((r) => {
              const ns = snap.nodes.filter((n) => n.rack === r);
              const up = ns.filter((n) => n.status === 'healthy').length;
              const cut = snap.isolated && r === 'C';
              return (
                <li key={r}>
                  <span className="strong">Rack {r}</span>
                  <span className="muted-cell">{up} of {ns.length} nodes online, {ns.reduce((a, n) => a + n.pieceCount, 0)} pieces</span>
                  <span className="badge" data-tone={cut ? 'off' : up === ns.length ? 'ok' : 'warn'}><i aria-hidden="true" />{cut ? 'Partitioned' : up === ns.length ? 'Healthy' : 'Degraded'}</span>
                </li>
              );
            })}
          </ul>
        </section>
      </div>
    </>
  );
}