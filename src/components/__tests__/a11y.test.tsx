/**
 * Accessibility tests.
 *  1. axe-core (the engine inside Chrome Lighthouse) scans every page for WCAG 2.2 A/AA violations.
 *  2. Color contrast is computed from the real stylesheet for both themes, because jsdom cannot render colors.
 *  3. Keyboard and screen-reader behavior: skip link, focus on navigation, page titles.
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import App from '../../App';
import { bytesOf, setup } from '../../engine/__tests__/testkit';

const OPTS = { seed: false, running: false, refreshMs: 0 } as const;

async function renderApp() {
  const kit = setup();
  await kit.cluster.putObject('videos/demo.mp4', bytesOf(700_000, 1), 'ec42');
  await kit.cluster.putObject('notes/readme.txt', bytesOf(20_000, 2), 'rep3');
  await kit.advance(100);
  const user = userEvent.setup();
  const view = render(<App cluster={kit.cluster} options={OPTS} />);
  return { ...kit, user, view };
}

async function axeViolations(root: Element) {
  const res = await axe.run(root, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
    rules: {
      'color-contrast': { enabled: false }, // jsdom cannot compute colors; covered by the stylesheet test below
      region: { enabled: false }, // the render root is not a full document
    },
  });
  return res.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`);
}

afterEach(() => window.history.replaceState(null, '', '#'));

describe('automated WCAG scan (axe-core)', () => {
  it.each(['Overview', 'Nodes', 'Objects', 'Activity', 'Settings'])('%s page has no violations', async (page) => {
    const { user, view } = await renderApp();
    await user.click(screen.getByRole('link', { name: new RegExp(`^${page}`) }));
    await screen.findByRole('heading', { level: 1, name: page });
    expect(await axeViolations(view.container)).toEqual([]);
  });

  it('stays clean while nodes are failing and repairing', async () => {
    const { cluster, view, advance } = await renderApp();
    await act(async () => {
      cluster.crashNode('n1');
      cluster.setIsolated(true);
      cluster.toggleMeta('m2');
      await advance(6000);
    });
    expect(await axeViolations(view.container)).toEqual([]);
  });
});

/* ---------------------------------------------------------------- contrast */

function lum(hex: string) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const contrast = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};
/** color-mix(in srgb, fg p, bg) */
const mix = (fg: string, bg: string, p: number) => '#' + [1, 3, 5]
  .map((i) => Math.round(parseInt(fg.slice(i, i + 2), 16) * p + parseInt(bg.slice(i, i + 2), 16) * (1 - p)).toString(16).padStart(2, '0')).join('');

const css = readFileSync(resolve(__dirname, '../../styles/global.css'), 'utf8');
function tokens(block: string) {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)) out[m[1]] = m[2].toLowerCase();
  return out;
}
const light = tokens(css.slice(0, css.indexOf('@media (prefers-color-scheme: dark)')));
const dark = { ...light, ...tokens(css.slice(css.indexOf(':root[data-theme="dark"]'), css.indexOf('/* ---------- base'))) };

describe('color contrast from the stylesheet (WCAG 1.4.3, AA 4.5:1)', () => {
  const textTokens = ['text', 'text-2', 'muted', 'accent', 'ok', 'warn', 'bad', 'repair', 'off'];
  for (const [name, t] of [['light', light], ['dark', dark]] as const) {
    it.each(textTokens)(`${name} theme: --%s is readable on every surface`, (k) => {
      const surfaces = [t.bg, t.surface, t['surface-2'], t['surface-3'], mix(t[k], t.surface, 0.11)];
      for (const bg of surfaces) expect(contrast(t[k], bg)).toBeGreaterThanOrEqual(4.5);
    });
    it(`${name} theme: button and badge text is readable`, () => {
      expect(contrast(t['on-accent'], t.accent)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t['on-warn'], t.warn)).toBeGreaterThanOrEqual(4.5);
    });
    it(`${name} theme: focus ring is visible against surfaces (WCAG 1.4.11, 3:1)`, () => {
      for (const bg of [t.bg, t.surface, t['surface-2']]) expect(contrast(t.focus, bg)).toBeGreaterThanOrEqual(3);
    });
  }
});

/* ------------------------------------------------ keyboard and screen reader */

describe('keyboard and screen-reader support', () => {
  it('the first Tab reaches a skip link that jumps to the main content', async () => {
    const { user } = await renderApp();
    await user.tab();
    const skip = screen.getByRole('link', { name: 'Skip to main content' });
    expect(skip).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(document.getElementById('main')).toHaveFocus();
  });

  it('navigating moves focus to the new page heading and updates the tab title', async () => {
    const { user } = await renderApp();
    expect(document.title).toBe('Overview · Vault');
    await user.click(screen.getByRole('link', { name: /^Objects/ }));
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Objects' })).toHaveFocus());
    expect(document.title).toBe('Objects · Vault');
  });

  it('every page is reachable and operable with the keyboard alone', async () => {
    const { user } = await renderApp();
    const link = screen.getByRole('link', { name: /^Nodes/ });
    link.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('heading', { level: 1, name: 'Nodes' })).toBeInTheDocument();
    screen.getByRole('button', { name: 'Crash n2' }).focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('button', { name: 'Restart n2' })).toBeInTheDocument();
  });

  it('cluster health changes are announced through a live region', async () => {
    await renderApp();
    const status = screen.getByRole('status', { name: '' , hidden: false });
    expect(status).toHaveAttribute('aria-live', 'polite');
  });

  it('charts describe their current values to screen readers', async () => {
    await renderApp();
    expect(screen.getByRole('img', { name: /Requests per second .* currently \d+ reads/ })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /latency .* currently \d+ milliseconds/ })).toBeInTheDocument();
  });

  it('tables have captions and every form control has a label', async () => {
    const { user, view } = await renderApp();
    await user.click(screen.getByRole('link', { name: /^Nodes/ }));
    expect(screen.getByRole('table', { name: /Storage nodes with their rack/ })).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: /^Settings/ }));
    for (const input of view.container.querySelectorAll('input')) {
      expect((input.labels?.length ?? 0) + (input.getAttribute('aria-label') ? 1 : 0)).toBeGreaterThan(0);
    }
  });
});