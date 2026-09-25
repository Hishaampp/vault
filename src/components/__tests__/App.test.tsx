import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import App from '../../App';
import { bytesOf, setup } from '../../engine/__tests__/testkit';

const OPTS = { seed: false, running: false, refreshMs: 30 } as const;

async function renderWithCluster() {
  const kit = setup();
  await kit.cluster.putObject('videos/demo.mp4', bytesOf(700_000, 1), 'ec42');
  await kit.cluster.putObject('notes/readme.txt', bytesOf(20_000, 2), 'rep3');
  await kit.advance(100);
  const user = userEvent.setup();
  render(<App cluster={kit.cluster} options={OPTS} />);
  /** advance the fake cluster clock inside act() so React sees the result */
  const advance = async (ms: number) => { await act(async () => { await kit.advance(ms); }); };
  return { ...kit, user, advance };
}

afterEach(() => document.documentElement.removeAttribute('data-theme'));

describe('<App />', () => {
  it('renders every storage node, the metadata cluster, and a healthy headline', async () => {
    await renderWithCluster();
    for (let i = 1; i <= 9; i++) expect(screen.getByRole('button', { name: new RegExp(`^n${i}, rack`) })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Metadata node m1, leader/ })).toBeInTheDocument();
    expect(screen.getByText('All 2 objects fully protected')).toBeInTheDocument();
    expect(screen.getByTestId('durability-state')).toHaveTextContent('Fully protected');
  });

  it('crashing a selected node walks it to "Declared dead" and the cluster heals', async () => {
    const { user, advance, cluster } = await renderWithCluster();
    const holder = cluster.objects.get('videos/demo.mp4')!.segments[0].pieces[0].node!;
    await user.click(screen.getByRole('button', { name: new RegExp(`^${holder}, rack`) }));
    await user.click(screen.getByRole('button', { name: 'Crash node' }));
    expect(screen.getByRole('button', { name: 'Restart node' })).toBeEnabled();

    await advance(300);
    await waitFor(() => expect(screen.getByText(/Self-healing/)).toBeInTheDocument());

    await advance(5000);
    const tile = screen.getByRole('button', { name: new RegExp(`^${holder}, rack`) });
    await waitFor(() => expect(within(tile).getByText('Declared dead')).toBeInTheDocument());

    for (let i = 0; i < 60 && cluster.degraded + cluster.queue.length + cluster.inflight.length > 0; i++) await advance(200);
    await advance(200);
    await waitFor(() => expect(screen.getByText('All 2 objects fully protected')).toBeInTheDocument());
    expect(screen.getByTestId('durability-state')).toHaveTextContent('Fully protected');
    expect(screen.getByText(/Last recovery took/)).toBeInTheDocument();
  });

  it('losing two metadata nodes pauses writes and says so', async () => {
    const { user, advance } = await renderWithCluster();
    await user.click(screen.getByRole('button', { name: /Metadata node m1/ }));
    await user.click(screen.getByRole('button', { name: /Metadata node m2/ }));
    await advance(1000);
    await waitFor(() => expect(screen.getByText(/Metadata quorum lost. Reads continue, writes are paused/)).toBeInTheDocument());
  });

  it('partition button toggles between cutting off and healing rack C', async () => {
    const { user } = await renderWithCluster();
    await user.click(screen.getByRole('button', { name: 'Partition rack C' }));
    expect(screen.getByRole('button', { name: 'Heal network' })).toBeInTheDocument();
    expect(screen.getByText('Cut off by partition')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Heal network' }));
    expect(screen.queryByText('Cut off by partition')).not.toBeInTheDocument();
  });

  it('adding a node shows a new tile', async () => {
    const { user } = await renderWithCluster();
    await user.click(screen.getByRole('button', { name: 'Add a node' }));
    expect(screen.getByRole('button', { name: /^n10, rack/ })).toBeInTheDocument();
  });

  it('"Read and verify" proves the object is bit-for-bit intact', async () => {
    const { user } = await renderWithCluster();
    await user.click(screen.getByRole('button', { name: /notes\/readme\.txt/ }));
    await user.click(screen.getByRole('button', { name: 'Read and verify' }));
    await waitFor(() => expect(screen.getByText(/SHA-256 matches the original exactly/)).toBeInTheDocument());
  });

  it('shows a chunk map with one row per segment and a column per piece', async () => {
    const { user } = await renderWithCluster();
    await user.click(screen.getByRole('button', { name: /videos\/demo\.mp4/ }));
    const table = screen.getByRole('table', { name: /Piece placement for videos\/demo\.mp4/ });
    expect(within(table).getAllByRole('columnheader')).toHaveLength(7); // label + 4 data + 2 parity
    expect(within(table).getAllByRole('rowheader')).toHaveLength(2); // 700 KB / 512 KB segments
    expect(within(table).getByText('Parity 2')).toBeInTheDocument();
  });

  it('uploads a file with the selected durability policy', async () => {
    const { user, cluster } = await renderWithCluster();
    await user.click(screen.getByRole('radio', { name: 'Replicate ×2' }));
    expect(screen.getByTestId('policy-help')).toHaveTextContent('Two full copies');
    const file = new File([new Uint8Array(5000).fill(7)], 'hello.bin', { type: 'application/octet-stream' });
    await user.upload(screen.getByLabelText('Upload a file'), file);
    await waitFor(() => expect(screen.getByText(/Stored hello\.bin as Replicate ×2/)).toBeInTheDocument());
    expect(cluster.objects.get('uploads/hello.bin')?.policy).toBe('rep2');
  });

  it('rejects uploads larger than 8 MB with a clear message', async () => {
    const { user, cluster } = await renderWithCluster();
    const big = new File([new Uint8Array(8 * 1048576 + 1)], 'huge.iso');
    await user.upload(screen.getByLabelText('Upload a file'), big);
    expect(await screen.findByText(/huge\.iso is 8\.00 MB\. Upload a file of 8 MB or less/)).toBeInTheDocument();
    expect(cluster.objects.has('uploads/huge.iso')).toBe(false);
  });

  it('policy sliders and toggles update the engine settings', async () => {
    const { user, cluster } = await renderWithCluster();
    await user.click(screen.getByRole('checkbox', { name: /integrity scrubber/i }));
    expect(cluster.settings.scrub).toBe(true); // setup() starts with it off; clicking turns it on
    await user.click(screen.getByRole('checkbox', { name: /client traffic/i }));
    expect(cluster.settings.traffic).toBe(true);
  });

  it('theme button cycles auto → light → dark', async () => {
    const { user } = await renderWithCluster();
    const btn = screen.getByRole('button', { name: 'Theme: auto' });
    await user.click(btn);
    expect(document.documentElement.dataset.theme).toBe('light');
    await user.click(screen.getByRole('button', { name: 'Theme: light' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    await user.click(screen.getByRole('button', { name: 'Theme: dark' }));
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('bit rot shows a warning until the system catches it', async () => {
    const { user, advance, cluster } = await renderWithCluster();
    const holder = cluster.nodes.find((n) => n.store.size > 0)!.id;
    await user.click(screen.getByRole('button', { name: new RegExp(`^${holder}, rack`) }));
    await user.click(screen.getByRole('button', { name: 'Inject bit rot' }));
    expect(await screen.findByText(/1 corrupted piece the system has not noticed yet/)).toBeInTheDocument();
    cluster.settings.scrub = true;
    for (let i = 0; i < 80 && cluster.silentRotCount() > 0; i++) await advance(100);
    await advance(100);
    await waitFor(() => expect(screen.queryByText(/has not noticed yet/)).not.toBeInTheDocument());
  });
});
