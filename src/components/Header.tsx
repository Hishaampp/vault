import { headlineOf, type ClusterSnapshot } from '../engine/snapshot';
import type { ThemeChoice } from '../hooks/useTheme';
import type { VaultMode } from '../hooks/useVault';
import { Icon, Logo } from './Icon';

interface Props {
  title: string;
  subtitle: string;
  snap: ClusterSnapshot | null;
  mode: VaultMode;
  connected: boolean;
  theme: ThemeChoice;
  onCycleTheme: () => void;
}

const THEME = {
  system: { label: 'Theme: auto', short: 'Auto', icon: 'monitor' },
  light: { label: 'Theme: light', short: 'Light', icon: 'sun' },
  dark: { label: 'Theme: dark', short: 'Dark', icon: 'moon' },
} as const;

/** Sticky page header: title, live cluster status, and theme switch. */
export function Header({ title, subtitle, snap, mode, connected, theme, onCycleTheme }: Props) {
  const { tone, text } = snap
    ? headlineOf(snap)
    : { tone: 'ok' as const, text: mode === 'detecting' ? 'Looking for a live cluster…' : 'Connecting to the cluster…' };
  const t = THEME[theme];
  const badge = mode === 'live' ? (connected ? 'Live' : 'Reconnecting') : mode === 'simulated' ? 'Simulator' : null;
  return (
    <header className="topbar">
      <div className="tb-title">
        <Logo className="tb-logo" />
        <div className="tb-text">
          <h1 id="page-title" tabIndex={-1}>{title}</h1>
          <p className="tb-sub">{subtitle}</p>
        </div>
      </div>
      <div className="tb-right">
        <p className="status-pill" data-tone={tone} role="status" aria-live="polite">
          <span className="dot" aria-hidden="true" />
          <span className="txt">{text}</span>
        </p>
        {badge && <span className="mode-chip" data-mode={mode} data-connected={connected || undefined}>{badge}</span>}
        <button type="button" className="btn ghost theme-btn" aria-label={t.label} title={t.label} onClick={onCycleTheme}>
          <Icon name={t.icon} size={16} />
          <span className="theme-short">{t.short}</span>
        </button>
      </div>
    </header>
  );
}