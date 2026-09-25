import { fmtSecs, plural } from '../engine/format';
import type { ClusterSnapshot } from '../engine/snapshot';

export function DurabilityPanel({ snap }: { snap: ClusterSnapshot }) {
  let state: string;
  let tone: 'ok' | 'warn' | 'bad';
  let sub: string;
  if (snap.unreadable.length) {
    state = 'Data unavailable'; tone = 'bad';
    sub = 'Too many pieces are on dead nodes. Restart nodes to recover.';
  } else if (snap.recovery.start !== null) {
    state = `Rebuilding ${fmtSecs(snap.now - snap.recovery.start)}`; tone = 'warn';
    sub = snap.quorum ? 'Repairing the most at-risk pieces first' : 'Repairs paused until metadata quorum returns';
  } else {
    state = 'Fully protected'; tone = 'ok';
    sub = snap.recovery.last ? `Last recovery took ${fmtSecs(snap.recovery.last)}` : 'No failures yet. Try crashing a node.';
  }
  const pct = Math.round(snap.scrub.progress * 100);
  const on = snap.scrub.enabled;
  return (
    <section className="panel" aria-labelledby="dur-title">
      <h2 id="dur-title">Durability</h2>
      <p className={`dur-state ${tone}`} data-testid="durability-state">{state}</p>
      <p className="dur-sub">{sub}</p>
      <dl className="kv">
        <dt>Pieces below target</dt><dd>{snap.degraded}</dd>
        <dt>Segments with no spare left</dt><dd className={snap.atRisk ? 'warn' : undefined}>{snap.atRisk}</dd>
        <dt>Repairs in flight</dt><dd>{snap.flights.length} / {snap.settings.concurrency}</dd>
        <dt>Waiting in queue</dt><dd>{snap.queueLength}</dd>
        <dt>Pieces repaired so far</dt><dd>{snap.repaired}</dd>
      </dl>
      <div className="scrub">
        <div className="row"><span>Integrity scrubber{on ? `, pass ${snap.scrub.passes + 1}` : ' (off)'}</span><b>{on ? `${pct}%` : ''}</b></div>
        <div className="bar" role="progressbar" aria-label="Scrubber progress" aria-valuenow={on ? pct : 0} aria-valuemin={0} aria-valuemax={100}>
          <i style={{ width: `${on ? pct : 0}%` }} />
        </div>
        <div className="row"><span>Corruptions caught by scrubber</span><b>{snap.scrub.found}</b></div>
      </div>
      {snap.silentRot > 0 && (
        <p className="god">
          {plural(snap.silentRot, 'corrupted piece')} the system has not noticed yet. The scrubber or the next read will catch {snap.silentRot > 1 ? 'them' : 'it'}.
        </p>
      )}
    </section>
  );
}
