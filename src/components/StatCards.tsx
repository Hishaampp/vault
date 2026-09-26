import { fmtBytes, fmtSecs } from '../engine/format';
import { overheadOf, type ClusterSnapshot } from '../engine/snapshot';
import { Icon, IconName } from './Icon';


interface Stat {
  label: string;
  icon: IconName;
  value: string;
  sub: string;
  tone?: 'ok' | 'warn' | 'bad';
}

/** Key numbers across the top of the overview. */
export function StatCards({ snap }: { snap: ClusterSnapshot }) {
  const online = snap.nodes.filter((n) => n.status === 'healthy' && n.up).length;
  const metaUp = snap.meta.filter((m) => m.up && m.reachable).length;
  const o = overheadOf(snap.objects);
  const extra = o.logical ? Math.round((o.raw / o.logical - 1) * 100) : 0;

  let health: Stat;
  if (!snap.quorum) health = { label: 'Cluster health', icon: 'shield', value: 'Writes paused', sub: 'Fewer than 2 metadata replicas reachable', tone: 'bad' };
  else if (snap.unreadable.length) health = { label: 'Cluster health', icon: 'shield', value: 'Data unavailable', sub: `${snap.unreadable.length} object(s) waiting for nodes`, tone: 'bad' };
  else if (snap.degraded) health = { label: 'Cluster health', icon: 'shield', value: 'Repairing', sub: `${snap.degraded} pieces below target`, tone: 'warn' };
  else health = { label: 'Cluster health', icon: 'shield', value: 'Healthy', sub: 'Full redundancy', tone: 'ok' };

  const rebuilding = snap.recovery.start !== null;
  const stats: Stat[] = [
    health,
    {
      label: 'Nodes online', icon: 'nodes', value: `${online} / ${snap.nodes.length}`,
      sub: `${metaUp} of ${snap.meta.length} metadata replicas up`, tone: online === snap.nodes.length ? undefined : 'warn',
    },
    { label: 'Objects', icon: 'objects', value: String(snap.objects.length), sub: `${fmtBytes(o.logical)} of data` },
    { label: 'Stored on disk', icon: 'database', value: fmtBytes(o.raw), sub: `${extra}% redundancy overhead` },
    {
      label: rebuilding ? 'Rebuilding for' : 'Recovery time', icon: 'clock',
      value: rebuilding ? fmtSecs(snap.now - snap.recovery.start!) : snap.recovery.last ? fmtSecs(snap.recovery.last) : 'None yet',
      sub: rebuilding ? 'Repair in progress' : snap.recovery.last ? 'Time back to full protection' : 'No failures so far',
      tone: rebuilding ? 'warn' : undefined,
    },
  ];

  return (
    <section className="stats" aria-label="Key metrics">
      {stats.map((s) => (
        <div className="stat" key={s.label} data-tone={s.tone}>
          <div className="stat-label"><Icon name={s.icon} size={16} />{s.label}</div>
          <div className="stat-value">{s.value}</div>
          <div className="stat-sub">{s.sub}</div>
        </div>
      ))}
    </section>
  );
}