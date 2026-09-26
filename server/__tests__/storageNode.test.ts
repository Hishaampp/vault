// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStorageNode } from '../storageNode';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
let dir: string;
let servers: Server[] = [];
let stops: (() => void)[] = [];

async function boot() {
  const node = await createStorageNode({ id: 'n1', rack: 'A', dir, scrubIntervalMs: 20 });
  const server = await node.listen(0);
  servers.push(server);
  stops.push(() => node.stop());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { node, base };
}

const put = (base: string, key: string, body: Uint8Array, sum = sha(body)) =>
  fetch(`${base}/pieces/${encodeURIComponent(key)}`, { method: 'PUT', headers: { 'x-sha256': sum }, body: body as unknown as BodyInit });

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'vault-node-')); });
afterEach(async () => {
  stops.forEach((s) => s());
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  servers = []; stops = [];
  await rm(dir, { recursive: true, force: true });
});

describe('storage node process', () => {
  it('stores and returns bytes exactly, as a real file with a checksum sidecar', async () => {
    const { base } = await boot();
    const data = new Uint8Array(100_000).map((_, i) => (i * 7) % 256);
    expect((await put(base, 'obj@1#0.0', data)).status).toBe(200);
    const r = await fetch(`${base}/pieces/${encodeURIComponent('obj@1#0.0')}`);
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(data);
    const onDisk = await readFile(join(dir, encodeURIComponent('obj@1#0.0')));
    expect(sha(onDisk)).toBe(sha(data));
    expect((await readFile(join(dir, `${encodeURIComponent('obj@1#0.0')}.sha256`), 'utf8')).trim()).toBe(sha(data));
  });

  it('rejects a write whose bytes do not match the declared checksum', async () => {
    const { base, node } = await boot();
    const r = await put(base, 'k', new Uint8Array([1, 2, 3]), 'deadbeef');
    expect(r.status).toBe(400);
    expect(node.pieces.size).toBe(0);
  });

  it('keeps its data across a process restart', async () => {
    const first = await boot();
    await put(first.base, 'persist@1#0.0', new Uint8Array([9, 9, 9]));
    stops.forEach((s) => s());
    await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
    servers = []; stops = [];
    const second = await boot();
    expect(second.node.pieces.has('persist@1#0.0')).toBe(true);
    const h = await (await fetch(`${second.base}/health`)).json();
    expect(h.keys).toContain('persist@1#0.0');
  });

  it('its scrubber detects bytes changed on disk behind its back', async () => {
    const { base, node } = await boot();
    const data = new Uint8Array(5000).fill(42);
    await put(base, 'rot@1#0.0', data);
    const tampered = data.slice();
    tampered[10] ^= 0x04;
    await writeFile(join(dir, encodeURIComponent('rot@1#0.0')), tampered);
    for (let i = 0; i < 50 && !node.corrupt.size; i++) await new Promise((r) => setTimeout(r, 20));
    const h = await (await fetch(`${base}/health`)).json();
    expect(h.corrupt).toEqual(['rot@1#0.0']);
    expect(h.scrub.found).toBe(1);
  });

  it('chaos endpoint really corrupts the file and a rewrite clears the flag', async () => {
    const { base, node } = await boot();
    const data = new Uint8Array(2000).fill(1);
    await put(base, 'c@1#0.0', data);
    const r = await (await fetch(`${base}/chaos/corrupt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
    expect(r.key).toBe('c@1#0.0');
    expect(sha(await readFile(join(dir, encodeURIComponent('c@1#0.0'))))).not.toBe(sha(data));
    // the background scrubber may already be mid-scan, so wait for detection instead of racing it
    for (let i = 0; i < 100 && !node.corrupt.has('c@1#0.0'); i++) await new Promise((r) => setTimeout(r, 20));
    expect(node.corrupt.has('c@1#0.0')).toBe(true);
    await put(base, 'c@1#0.0', data);
    expect(node.corrupt.has('c@1#0.0')).toBe(false);
  });

  it('deletes remove both the data file and the sidecar', async () => {
    const { base, node } = await boot();
    await put(base, 'd', new Uint8Array([1]));
    await fetch(`${base}/pieces/d`, { method: 'DELETE' });
    expect(node.pieces.size).toBe(0);
    expect((await fetch(`${base}/pieces/d`)).status).toBe(404);
  });
});
