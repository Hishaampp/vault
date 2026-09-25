import type { ClusterActions, ClusterSnapshot, LiveSettings } from '../engine/snapshot';
import type { PolicyKey, ReadResult, WriteResult } from '../engine/types';

/**
 * Connects the dashboard to the real Node.js cluster: snapshots arrive over
 * a WebSocket, actions go out as REST calls.
 */
export class RemoteCluster {
  snapshot: ClusterSnapshot | null = null;
  /** performance.now() when the latest snapshot arrived */
  receivedAt = 0;
  connected = false;
  private ws: WebSocket | null = null;
  private listeners = new Set<() => void>();
  private retry: number | undefined;
  private closed = false;

  constructor(private base = '') {}

  static async detect(base = '', timeoutMs = 900): Promise<boolean> {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeoutMs);
      const r = await fetch(`${base}/api/health`, { signal: ctl.signal });
      clearTimeout(t);
      if (!r.ok) return false;
      const j = await r.json();
      return j?.service === 'vault';
    } catch {
      return false;
    }
  }

  connect(): void {
    this.closed = false;
    const url = new URL(`${this.base}/ws`, window.location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => { this.connected = true; this.emit(); };
    ws.onmessage = (ev) => {
      this.snapshot = JSON.parse(String(ev.data)) as ClusterSnapshot;
      this.receivedAt = performance.now();
      this.emit();
    };
    ws.onclose = () => {
      this.connected = false;
      this.emit();
      if (!this.closed) this.retry = window.setTimeout(() => this.connect(), 1000);
    };
  }

  close(): void {
    this.closed = true;
    window.clearTimeout(this.retry);
    this.ws?.close();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() { for (const fn of this.listeners) fn(); }

  private async post(path: string, body?: unknown, method = 'POST'): Promise<unknown> {
    const r = await fetch(`${this.base}/api${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return r.headers.get('content-type')?.includes('json') ? r.json() : null;
  }

  actions(): ClusterActions {
    const enc = encodeURIComponent;
    return {
      crashNode: (id) => this.post(`/chaos/nodes/${enc(id)}/crash`),
      restartNode: (id) => this.post(`/chaos/nodes/${enc(id)}/restart`),
      injectRot: (id) => this.post(`/chaos/nodes/${enc(id)}/corrupt`),
      crashRandomNode: () => this.post('/chaos/random-crash'),
      setIsolated: (on) => this.post('/chaos/partition', { on }),
      addNode: () => this.post('/nodes'),
      toggleMeta: (id) => this.post(`/chaos/meta/${enc(id)}/toggle`),
      updateSettings: (patch: Partial<LiveSettings>) => this.post('/settings', patch, 'PATCH'),
      putObject: async (name: string, bytes: Uint8Array, policy: PolicyKey): Promise<WriteResult> => {
        const r = await fetch(`${this.base}/api/objects/${enc(name)}?policy=${policy}`, {
          method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: bytes as BodyInit,
        });
        return (await r.json()) as WriteResult;
      },
      readObject: async (name: string): Promise<ReadResult> =>
        (await this.post(`/verify/${enc(name)}`)) as ReadResult,
      deleteObject: (name) => this.post(`/objects/${enc(name)}`, undefined, 'DELETE'),
      note: (kind, msg) => this.post('/log', { kind, msg }),
    };
  }
}
