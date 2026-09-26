import { useCallback, useEffect, useState } from 'react';
import type { VaultCluster } from './engine/cluster';
import type { UseClusterOptions } from './hooks/useCluster';
import { useTheme } from './hooks/useTheme';
import { useVault } from './hooks/useVault';
import { DurabilityPanel } from './components/DurabilityPanel';
import { EventLog } from './components/EventLog';
import { Header } from './components/Header';
import { MetricsPanels } from './components/MetricsPanels';
import { ObjectsPanel } from './components/ObjectsPanel';
import { OverheadPanel } from './components/OverheadPanel';
import { PoliciesPanel } from './components/PoliciesPanel';
import { Topology } from './components/Topology';
import { Page, PAGES, Sidebar } from './components/Sidebar';
import { StatCards } from './components/StatCards';
import { NodesPage } from './components/NodesPage';

interface AppProps {
  /** inject a pre-built simulator cluster (used by tests; forces simulator mode) */
  cluster?: VaultCluster;
  options?: UseClusterOptions;
}

export default function App({ cluster, options }: AppProps) {
  const [generation, setGeneration] = useState(0);
  return (
    <Dashboard
      key={generation}
      cluster={generation === 0 ? cluster : undefined}
      options={options}
      onReset={() => setGeneration((g) => g + 1)}
    />
  );
}

/** The current page lives in the URL hash (#/objects), so refresh and back/forward work. */
function readPage(): Page {
  const id = window.location.hash.replace(/^#\/?/, '');
  return (PAGES.find((p) => p.id === id)?.id) ?? 'overview';
}

function usePage(): [Page, (p: Page) => void] {
  const [page, setPage] = useState<Page>(readPage);
  useEffect(() => {
    const onHash = () => setPage(readPage());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const go = useCallback((p: Page) => {
    if (window.location.hash !== `#/${p}`) window.history.pushState(null, '', `#/${p}`);
    setPage(p);
    if (!navigator.userAgent.includes('jsdom')) window.scrollTo({ top: 0 });
  }, []);
  return [page, go];
}

function Dashboard({ cluster: injected, options, onReset }: AppProps & { onReset: () => void }) {
  const { mode, snap, at, actions, refresh, connected } = useVault(injected, options);
  const { theme, cycle } = useTheme();
  const [page, go] = usePage();
  const [selected, setSelected] = useState<string | null>(null);
  const select = (id: string | null) => { setSelected(id); refresh(); };
  const meta = PAGES.find((p) => p.id === page)!;

  let body;
  if (!snap) {
    body = (
      <div className="loading" role="status">
        <span className="spinner" aria-hidden="true" />
        {mode === 'live' ? 'Waiting for the first update from the cluster…' : 'Looking for a live cluster…'}
      </div>
    );
  } else if (page === 'overview') {
    body = (
      <>
        <StatCards snap={snap} />
        <div className="overview-grid">
          <Topology snap={snap} at={at} actions={actions} selected={selected} onSelect={select} onChange={refresh} />
          <DurabilityPanel snap={snap} />
        </div>
        <section className="charts" aria-label="Live metrics">
          <MetricsPanels snap={snap} />
        </section>
        <div className="grid-2">
          <EventLog snap={snap} limit={6} onViewAll={() => go('activity')} />
          <OverheadPanel snap={snap} />
        </div>
      </>
    );
  } else if (page === 'nodes') {
    body = <NodesPage snap={snap} actions={actions} onChange={refresh} />;
  } else if (page === 'objects') {
    body = (
      <>
        <ObjectsPanel snap={snap} actions={actions} onChange={refresh} />
        <OverheadPanel snap={snap} />
      </>
    );
  } else if (page === 'activity') {
    body = (
      <>
        <section className="charts" aria-label="Live metrics">
          <MetricsPanels snap={snap} />
        </section>
        <EventLog snap={snap} filterable />
      </>
    );
  } else {
    body = (
      <div className="settings-grid">
        <PoliciesPanel snap={snap} actions={actions} onChange={refresh} />
        <section className="panel" aria-labelledby="about-title">
          <h2 id="about-title">About this cluster</h2>
          <dl className="kv about">
            <dt>Mode</dt><dd>{snap.mode === 'live' ? 'Live Node.js cluster' : 'In-browser simulator'}</dd>
            <dt>Storage nodes</dt><dd>{snap.nodes.length} in {snap.racks.length} racks</dd>
            <dt>Metadata</dt><dd>{snap.meta.length} replicas</dd>
            <dt>Erasure coding</dt><dd>Reed-Solomon over GF(2⁸)</dd>
            <dt>Checksums</dt><dd>SHA-256 on every piece</dd>
            <dt>Placement</dt><dd>Rendezvous hashing, rack-aware</dd>
          </dl>
        </section>
      </div>
    );
  }

  return (
    <div className="shell">
      <Sidebar page={page} onNavigate={go} snap={snap} mode={mode} connected={connected} onReset={mode === 'simulated' ? onReset : undefined} />
      <div className="content">
        <Header title={meta.title} subtitle={meta.subtitle} snap={snap} mode={mode} connected={connected} theme={theme} onCycleTheme={cycle} />
        <main className="page" key={page}>
          {body}
          {snap && (
            <footer className="page-foot">
              {snap.mode === 'live'
                ? 'Live mode: every node is a separate Node.js process storing real files on disk.'
                : 'Simulator mode: pieces are real bytes held in this browser tab. Run npm run dev:live to connect to the real cluster.'}
            </footer>
          )}
        </main>
      </div>
    </div>
  );
}