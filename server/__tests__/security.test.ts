// @vitest-environment node
/**
 * Security tests for the public gateway and the internal node APIs.
 * The gateway runs against a small in-memory stand-in for the cluster manager,
 * so these tests are fast and exercise only the HTTP security layer.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { safeEqual } from '../auth';
import { createGateway, validObjectName, type GatewayOptions } from '../gateway';
import type { ClusterManager } from '../manager';
import { createMetaNode } from '../metaNode';
import { createStorageNode } from '../storageNode';

const servers: Server[] = [];
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => { s.closeAllConnections?.(); s.close(r); })));
  for (const fn of cleanup.splice(0)) await fn();
});

function fakeManager() {
  const calls: string[] = [];
  const mgr = {
    ready: true, nodes: [{ id: 'n1' }], objects: new Map(), settings: { policy: 'ec42' }, isolated: false,
    hasQuorum: () => true,
    snapshot: () => ({ mode: 'live', ok: true }),
    putObject: async (name: string, bytes: Uint8Array) => { calls.push(`put ${name} ${bytes.length}`); return { ok: true, obj: { version: 1, sha: 'abc' } }; },
    readObject: async () => ({ ok: true, bytes: new Uint8Array([1, 2, 3]), sha: 'abc', decoded: 0 }),
    deleteObject: async (name: string) => { calls.push(`delete ${name}`); return true; },
    crashNode: (id: string) => { calls.push(`crash ${id}`); return true; },
    restartNode: () => true, injectRot: async () => 'k', crashRandomNode: () => 'n1', setIsolated: () => undefined,
    toggleMeta: () => undefined, addNode: async () => 'n2', updateSettings: async (p: object) => p, addLog: (k: string, m: string) => calls.push(`log ${k} ${m}`),
  };
  return { mgr: mgr as unknown as ClusterManager, calls };
}

async function gateway(opts: GatewayOptions = {}) {
  const { mgr, calls } = fakeManager();
  const { server } = createGateway(mgr, opts);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { base, calls };
}

describe('gateway security headers', () => {
  it('sends a strict Content Security Policy and hardening headers', async () => {
    const { base } = await gateway();
    const r = await fetch(`${base}/api/health`);
    const csp = r.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(r.headers.get('strict-transport-security')).toContain('max-age=');
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    expect(r.headers.get('x-powered-by')).toBeNull();
  });

  it('never leaks internal error details', async () => {
    const { mgr } = fakeManager();
    (mgr as unknown as { readObject: () => never }).readObject = () => { throw new Error('secret path /etc/shadow'); };
    const { server } = createGateway(mgr);
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const origError = console.error;
    console.error = () => undefined;
    const r = await fetch(`${base}/api/objects/x`);
    console.error = origError;
    expect(r.status).toBe(500);
    const body = await r.text();
    expect(body).toContain('Internal server error');
    expect(body).not.toContain('shadow');
  });
});

describe('CORS', () => {
  it('does not allow arbitrary websites to call the API', async () => {
    const { base } = await gateway();
    const r = await fetch(`${base}/api/health`, { headers: { origin: 'https://evil.example' } });
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('allows explicitly configured origins', async () => {
    const { base } = await gateway({ corsOrigins: ['https://vault.example'] });
    const r = await fetch(`${base}/api/health`, { headers: { origin: 'https://vault.example' } });
    expect(r.headers.get('access-control-allow-origin')).toBe('https://vault.example');
  });

  it('rejects WebSocket connections from foreign origins', async () => {
    const { base } = await gateway();
    const url = base.replace('http', 'ws') + '/ws';
    const ok = await new Promise((res) => {
      const ws = new WebSocket(url, { headers: { origin: 'https://evil.example' } });
      ws.on('open', () => { ws.close(); res('open'); });
      ws.on('error', () => res('rejected'));
    });
    expect(ok).toBe('rejected');
    const same = await new Promise((res) => {
      const ws = new WebSocket(url);
      ws.on('message', () => { ws.close(); res('snapshot'); });
      ws.on('error', () => res('error'));
    });
    expect(same).toBe('snapshot');
  });
});

describe('authentication', () => {
  it('requires a bearer token for every change when a token is configured', async () => {
    const { base, calls } = await gateway({ apiToken: 's3cret-token' });
    const put = () => fetch(`${base}/api/objects/a.txt?policy=rep3`, { method: 'PUT', body: 'hi' });
    expect((await put()).status).toBe(401);
    expect((await fetch(`${base}/api/chaos/nodes/n1/crash`, { method: 'POST' })).status).toBe(401);
    expect((await fetch(`${base}/api/objects/a.txt`, { method: 'DELETE', headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    expect(calls).toEqual([]);
    const ok = await fetch(`${base}/api/objects/a.txt?policy=rep3`, { method: 'PUT', body: 'hi', headers: { authorization: 'Bearer s3cret-token' } });
    expect(ok.status).toBe(201);
    expect(calls).toEqual(['put a.txt 2']);
  });

  it('keeps reads open and reports that auth is required', async () => {
    const { base } = await gateway({ apiToken: 't' });
    const h = await (await fetch(`${base}/api/health`)).json();
    expect(h.authRequired).toBe(true);
    expect((await fetch(`${base}/api/objects`)).status).toBe(200);
  });

  it('compares secrets in constant time', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', 'x')).toBe(false);
  });
});

describe('input validation', () => {
  it.each([
    ['', 'empty'], ['a'.repeat(513), 'too long'], ['bad\u0000name', 'control characters'],
    ['/etc/passwd', 'leading slash'], ['a/../b', 'dot-dot segment'], ['./a', 'dot segment'],
  ])('rejects the object name %j (%s)', (name) => {
    expect(validObjectName(name)).not.toBeNull();
  });

  it.each(['photo.jpg', 'uploads/IMG_5804.HEIC', 'a b c', 'mail/a@b#c.txt'])('accepts %j', (name) => {
    expect(validObjectName(name)).toBeNull();
  });

  it('rejects bad names, policies, and node ids over HTTP', async () => {
    const { base, calls } = await gateway();
    expect((await fetch(`${base}/api/objects/${encodeURIComponent('a/../b')}`, { method: 'PUT', body: 'x' })).status).toBe(400);
    expect((await fetch(`${base}/api/objects/x?policy=raid0`, { method: 'PUT', body: 'x' })).status).toBe(400);
    expect((await fetch(`${base}/api/chaos/nodes/${encodeURIComponent('../../x')}/crash`, { method: 'POST' })).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('refuses uploads above the size limit', async () => {
    const { base, calls } = await gateway({ maxUploadMb: 1 });
    const r = await fetch(`${base}/api/objects/big.bin`, { method: 'PUT', body: new Uint8Array(1024 * 1024 + 10) });
    expect(r.status).toBe(413);
    expect((await r.json()).reason).toMatch(/1 MB limit/);
    expect(calls).toEqual([]);
  });

  it('refuses oversized JSON bodies', async () => {
    const { base } = await gateway();
    const r = await fetch(`${base}/api/log`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ msg: 'x'.repeat(40_000) }) });
    expect(r.status).toBe(413);
  });

  it('strips control characters from log messages', async () => {
    const { base, calls } = await gateway();
    await fetch(`${base}/api/log`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'nonsense', msg: 'a\nb\u0007c' }) });
    expect(calls).toEqual(['log info a b c']);
  });
});

describe('abuse protection', () => {
  it('rate-limits clients that send too many changes', async () => {
    const { base } = await gateway({ rateLimit: { perMinute: 100, writesPerMinute: 3 } });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await fetch(`${base}/api/chaos/random-crash`, { method: 'POST' })).status);
    expect(codes).toEqual([200, 200, 200, 429, 429]);
  });

  it('can disable fault injection entirely for public deployments', async () => {
    const { base, calls } = await gateway({ enableChaos: false });
    expect((await fetch(`${base}/api/chaos/nodes/n1/crash`, { method: 'POST' })).status).toBe(403);
    expect(calls).toEqual([]);
  });
});

describe('internal node APIs', () => {
  it('storage nodes reject requests without the manager token', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vault-sec-'));
    const node = await createStorageNode({ id: 'n1', rack: 'A', dir, token: 'node-secret' });
    const server = await node.listen(0);
    servers.push(server);
    cleanup.push(() => node.stop(), () => rm(dir, { recursive: true, force: true }));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    expect((await fetch(`${base}/health`)).status).toBe(401);
    expect((await fetch(`${base}/pieces/x`, { method: 'DELETE', headers: { 'x-vault-token': 'guess' } })).status).toBe(401);
    expect((await fetch(`${base}/health`, { headers: { 'x-vault-token': 'node-secret' } })).status).toBe(200);
  });

  it('metadata replicas reject requests without the manager token', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vault-sec-'));
    const node = await createMetaNode({ id: 'm1', dir, token: 'meta-secret' });
    const server = await node.listen(0);
    servers.push(server);
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const put = await fetch(`${base}/kv/x`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"rev":1,"value":1}' });
    expect(put.status).toBe(401);
    expect(node.entries.size).toBe(0);
  });

  it('storage nodes only listen on localhost', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vault-sec-'));
    const node = await createStorageNode({ id: 'n1', rack: 'A', dir });
    const server = await node.listen(0);
    servers.push(server);
    cleanup.push(() => node.stop(), () => rm(dir, { recursive: true, force: true }));
    expect((server.address() as { address: string }).address).toBe('127.0.0.1');
  });
});