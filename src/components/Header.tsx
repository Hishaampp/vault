import { headlineOf, type ClusterSnapshot } from '../engine/snapshot';
import type { VaultMode } from '../hooks/useVault';
import type { ThemeChoice } from '../hooks/useTheme';

interface Props {
  snap: ClusterSnapshot | null;
  mode: VaultMode;
  connected: boolean;
  theme: ThemeChoice;
  onCycleTheme: () => void;
  onReset?: () => void;
}

const THEME_LABEL: Record<ThemeChoice, string> = { system: 'Theme: auto', light: 'Theme: light', dark: 'Theme: dark' };

export function Header({ snap, mode, connected, theme, onCycleTheme, onReset }: Props) {
  const { tone, text } = snap
    ? headlineOf(snap)
    : { tone: 'ok' as const, text: mode === 'detecting' ? 'Looking for a live cluster…' : 'Connecting to the cluster…' };
  const badge = mode === 'live'
    ? { cls: connected ? 'live' : 'down', text: connected ? 'Live cluster' : 'Reconnecting…' }
    : mode === 'simulated' ? { cls: 'sim', text: 'Simulator' } : null;
  return (
    <header className="top">
      <div className="brand">
        <svg className="logo" viewBox="0 0 34 34" aria-hidden="true">
          <circle cx="17" cy="17" r="14" fill="none" stroke="currentColor" strokeWidth="2.6" />
          <circle cx="17" cy="17" r="4.5" fill="currentColor" />
          <path d="M17 3v7M17 24v7M3 17h7M24 17h7" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
        </svg>
        <div>
          <h1>Vault</h1>
          <p className="sub">Fault-tolerant object storage</p>
        </div>
      </div>
      <p className="headline" data-tone={tone} role="status" aria-live="polite">
        <span className="dot" aria-hidden="true" />
        <span className="txt">{text}</span>
      </p>
      <div className="top-actions">
        {badge && <span className={`mode ${badge.cls}`} title={mode === 'live' ? 'Connected to real Node.js processes' : 'Running entirely in this browser tab'}>{badge.text}</span>}
        <button type="button" className="btn ghost" onClick={onCycleTheme}>{THEME_LABEL[theme]}</button>
        {onReset && <button type="button" className="btn ghost" onClick={onReset}>Reset cluster</button>}
      </div>
    </header>
  );
}
