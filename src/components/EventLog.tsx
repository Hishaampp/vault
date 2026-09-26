import { useState } from 'react';
import { fmtClock } from '../engine/format';
import type { ClusterSnapshot } from '../engine/snapshot';
import type { LogKind } from '../engine/types';

const FILTERS: { id: string; label: string; kinds?: LogKind[] }[] = [
  { id: 'all', label: 'All' },
  { id: 'faults', label: 'Faults', kinds: ['fault', 'bad', 'warn'] },
  { id: 'healing', label: 'Repairs', kinds: ['heal', 'repair'] },
  { id: 'info', label: 'Info', kinds: ['info'] },
];

interface Props {
  snap: ClusterSnapshot;
  /** show only the newest N events */
  limit?: number;
  onViewAll?: () => void;
  filterable?: boolean;
}

export function EventLog({ snap, limit, onViewAll, filterable }: Props) {
  const [filter, setFilter] = useState('all');
  const kinds = FILTERS.find((f) => f.id === filter)?.kinds;
  const entries = snap.log.filter((e) => !kinds || kinds.includes(e.kind)).slice(0, limit ?? snap.log.length);
  return (
    <section className={`panel log-panel${filterable ? ' tall' : ''}`} aria-labelledby="log-title">
      <div className="panel-head tight">
        <h2 id="log-title">{limit ? 'Recent events' : 'Events'}</h2>
        {onViewAll && <button type="button" className="link-btn" onClick={onViewAll}>View all</button>}
        {filterable && (
          <div className="chips" role="group" aria-label="Filter events">
            {FILTERS.map((f) => (
              <button key={f.id} type="button" className="chip" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}</button>
            ))}
          </div>
        )}
      </div>
      {entries.length === 0 ? (
        <p className="empty">No events yet.</p>
      ) : (
        <ol className="log" role="log" aria-live="off">
          {entries.map((e) => (
            <li key={e.id} data-kind={e.kind}>
              <time className="mono">{fmtClock(e.t - snap.startedAt)}</time>
              <i aria-hidden="true" />
              <span>{e.msg}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}