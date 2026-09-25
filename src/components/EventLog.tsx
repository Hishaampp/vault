import { fmtClock } from '../engine/format';
import type { ClusterSnapshot } from '../engine/snapshot';

export function EventLog({ snap }: { snap: ClusterSnapshot }) {
  return (
    <section className="panel log-panel" aria-labelledby="log-title">
      <h2 id="log-title">Events</h2>
      <ol className="log" role="log" aria-live="off">
        {snap.log.map((e) => (
          <li key={e.id} data-kind={e.kind}>
            <time className="mono">{fmtClock(e.t - snap.startedAt)}</time>
            <i aria-hidden="true" />
            <span>{e.msg}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
