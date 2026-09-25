import { useState } from 'react';
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

function Dashboard({ cluster: injected, options, onReset }: AppProps & { onReset: () => void }) {
  const { mode, snap, at, actions, refresh, connected } = useVault(injected, options);
  const { theme, cycle } = useTheme();
  const [selected, setSelected] = useState<string | null>(null);
  const select = (id: string | null) => { setSelected(id); refresh(); };

  return (
    <div className="wrap">
      <Header snap={snap} mode={mode} connected={connected} theme={theme} onCycleTheme={cycle} onReset={mode === 'simulated' ? onReset : undefined} />
      {!snap ? (
        <p className="empty loading">{mode === 'live' ? 'Waiting for the first update from the cluster…' : 'Looking for a live cluster…'}</p>
      ) : (
        <>
          <main className="main">
            <Topology snap={snap} at={at} actions={actions} selected={selected} onSelect={select} onChange={refresh} />
            <aside className="side">
              <DurabilityPanel snap={snap} />
              <EventLog snap={snap} />
            </aside>
          </main>
          <section className="metrics" aria-label="Live metrics">
            <MetricsPanels snap={snap} />
            <OverheadPanel snap={snap} />
          </section>
          <section className="lower">
            <ObjectsPanel snap={snap} actions={actions} onChange={refresh} />
            <PoliciesPanel snap={snap} actions={actions} onChange={refresh} />
          </section>
          <footer>
            {snap.mode === 'live'
              ? 'Live mode: every node is a separate Node.js process storing real files on disk. Checksums are SHA-256 and erasure coding is Reed-Solomon over GF(2⁸).'
              : 'Simulator mode: pieces are real bytes held in this browser tab. Start the backend with npm run cluster to switch to live mode.'}
          </footer>
        </>
      )}
    </div>
  );
}
