// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMetaNode } from '../metaNode';

let dir: string;
let server: Server | null = null;

async function boot() {
  const node = await createMetaNode({ id: 'm1', dir });
  server = await node.listen(0);
  return { node, base: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}
const put = (base: string, key: string, rev: number, value: unknown) =>
  fetch(`${base}/kv/${key}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rev, value }) });

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'vault-meta-')); });
afterEach(async () => {
  if (server) await new Promise((r) => server!.close(r));
  server = null;
  await rm(dir, { recursive: true, force: true });
});

describe('metadata replica', () => {
  it('accepts newer revisions and rejects stale ones', async () => {
    const { base } = await boot();
    expect((await put(base, 'a', 5, { v: 1 })).status).toBe(200);
    expect((await put(base, 'a', 4, { v: 0 })).status).toBe(409);
    expect((await put(base, 'a', 5, { v: 2 })).status).toBe(409);
    expect((await put(base, 'a', 6, { v: 3 })).status).toBe(200);
    expect(await (await fetch(`${base}/kv/a`)).json()).toEqual({ rev: 6, value: { v: 3 } });
  });

  it('persists every acknowledged write to disk', async () => {
    const first = await boot();
    await put(first.base, 'x', 1, 'hello');
    await put(first.base, 'y', 2, null);
    await new Promise((r) => server!.close(r));
    server = null;
    const second = await boot();
    expect(second.node.entries.get('x')).toEqual({ rev: 1, value: 'hello' });
    expect(second.node.entries.get('y')).toEqual({ rev: 2, value: null });
  });

  it('lists every entry for recovery', async () => {
    const { base } = await boot();
    await put(base, 'a', 1, 1);
    await put(base, 'b', 2, 2);
    const { entries } = await (await fetch(`${base}/kv`)).json();
    expect(entries.map((e: [string]) => e[0]).sort()).toEqual(['a', 'b']);
  });
});
