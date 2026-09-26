import type { ClusterSnapshot } from '../engine/snapshot';
import type { VaultMode } from '../hooks/useVault';
import { Icon, IconName, Logo } from './Icon';


export type Page = 'overview' | 'nodes' | 'objects' | 'activity' | 'settings';

export const PAGES: { id: Page; label: string; icon: IconName; title: string; subtitle: string }[] = [
  { id: 'overview', label: 'Overview', icon: 'overview', title: 'Overview', subtitle: 'Live health of every node, object, and repair' },
  { id: 'nodes', label: 'Nodes', icon: 'nodes', title: 'Nodes', subtitle: 'Storage processes, metadata replicas, and fault injection' },
  { id: 'objects', label: 'Objects', icon: 'objects', title: 'Objects', subtitle: 'Upload, inspect, and verify stored files' },
  { id: 'activity', label: 'Activity', icon: 'activity', title: 'Activity', subtitle: 'Throughput, latency, and every cluster event' },
  { id: 'settings', label: 'Settings', icon: 'settings', title: 'Settings', subtitle: 'Durability policies and repair behavior' },
];

interface Props {
  page: Page;
  onNavigate: (p: Page) => void;
  snap: ClusterSnapshot | null;
  mode: VaultMode;
  connected: boolean;
  onReset?: () => void;
}

export function Sidebar({ page, onNavigate, snap, mode, connected, onReset }: Props) {
  const unhealthy = snap ? snap.nodes.filter((n) => n.status !== 'healthy').length : 0;
  const live = mode === 'live';
  const clusterTone = live ? (connected ? 'ok' : 'warn') : 'muted';
  return (
    <nav className="sidebar" aria-label="Main navigation">
      <div className="sb-brand">
        <Logo className="sb-logo" />
        <div>
          <strong>Vault</strong>
          <span>Object storage</span>
        </div>
      </div>
      <p className="sb-section">Workspace</p>
      <ul className="sb-nav">
        {PAGES.map((p) => (
          <li key={p.id}>
            <a
              href={`#/${p.id}`}
              className="sb-link"
              aria-current={page === p.id ? 'page' : undefined}
              onClick={(e) => { e.preventDefault(); onNavigate(p.id); }}
            >
              <Icon name={p.icon} />
              <span className="sb-label">{p.label}</span>
              {p.id === 'nodes' && unhealthy > 0 && <span className="sb-badge" aria-label={`${unhealthy} unhealthy`}>{unhealthy}</span>}
            </a>
          </li>
        ))}
      </ul>
      <div className="sb-foot">
        <div className="sb-cluster" data-tone={clusterTone}>
          <span className="sb-cluster-title"><i aria-hidden="true" />{live ? (connected ? 'Live cluster' : 'Reconnecting…') : mode === 'simulated' ? 'Simulator' : 'Connecting…'}</span>
          <span className="sb-cluster-sub">
            {snap ? `${snap.nodes.length} storage nodes, ${snap.meta.length} metadata replicas` : 'Looking for a cluster'}
          </span>
        </div>
        {onReset && (
          <button type="button" className="btn ghost sb-reset" onClick={onReset}>
            <Icon name="reset" size={16} />Reset cluster
          </button>
        )}
      </div>
    </nav>
  );
}