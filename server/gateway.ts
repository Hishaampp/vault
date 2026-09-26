/**
 * HTTP + WebSocket front door for the cluster.
 *
 * REST (S3-style):
 *   PUT    /api/objects/:name?policy=ec42   upload raw bytes
 *   GET    /api/objects/:name               download (verified end to end)
 *   DELETE /api/objects/:name
 *   GET    /api/objects                     list
 *   POST   /api/verify/:name                read + verify, returns a report
 *
 * Operations and fault injection:
 *   GET  /api/health, GET /api/snapshot, PATCH /api/settings, POST /api/nodes
 *   POST /api/chaos/nodes/:id/{crash|restart|corrupt}
 *   POST /api/chaos/random-crash, POST /api/chaos/partition {on}
 *   POST /api/chaos/meta/:id/toggle
 *
 * WebSocket /ws pushes a cluster snapshot whenever it changes.
 *
 * Security: strict security headers (helmet + CSP), CORS allowlist, per-IP rate
 * limits, input validation, body-size limits, optional bearer-token auth for
 * every state-changing request, and generic error messages.
 */
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { POLICIES } from '../src/engine/policies';
import type { LogKind, PolicyKey } from '../src/engine/types';
import { safeEqual } from './auth';
import type { ClusterManager } from './manager';
import compression from 'compression';

export interface GatewayOptions {
  /** serve the built dashboard from this folder */
  staticDir?: string;
  /** how often to check for snapshot changes to push over the WebSocket */
  pushMs?: number;
  /** when set, every state-changing request needs `Authorization: Bearer <token>` */
  apiToken?: string;
  /** extra browser origins allowed to call the API (same-origin always works) */
  corsOrigins?: string[];
  /** disable fault-injection endpoints, e.g. for a public deployment */
  enableChaos?: boolean;
  /** largest accepted upload in megabytes */
  maxUploadMb?: number;
  /** requests per minute per IP: all API calls / state-changing calls */
  rateLimit?: { perMinute: number; writesPerMinute: number };
}

const NAME_MAX = 512;
const NODE_ID = /^[mn]\d{1,4}$/;
const LOG_KINDS: LogKind[] = ['fault', 'warn', 'bad', 'heal', 'repair', 'info'];

/** Object names: 1-512 printable characters, no control characters, no leading slash or dot segments. */
export function validObjectName(name: string): string | null {
  if (!name || name.length > NAME_MAX) return `Object names must be 1 to ${NAME_MAX} characters.`;
  if (/[\u0000-\u001f\u007f]/.test(name)) return 'Object names cannot contain control characters.';
  if (name.startsWith('/') || name.split('/').some((p) => p === '.' || p === '..')) return 'Object names cannot start with "/" or contain "." or ".." segments.';
  return null;
}

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const wrap = (fn: (req: Request, res: Response) => Promise<unknown> | unknown) =>
  (req: Request, res: Response, next: NextFunction) => { Promise.resolve(fn(req, res)).catch(next); };

function objectName(req: Request): string {
  const name = String(req.params.name);
  const bad = validObjectName(name);
  if (bad) throw new HttpError(400, bad);
  return name;
}

function nodeId(req: Request): string {
  const id = String(req.params.id);
  if (!NODE_ID.test(id)) throw new HttpError(400, 'Unknown node id.');
  return id;
}

export function createGateway(mgr: ClusterManager, opts: GatewayOptions = {}) {
  const allowed = new Set(opts.corsOrigins ?? []);
  const enableChaos = opts.enableChaos ?? true;
  const maxUploadMb = opts.maxUploadMb ?? 64;
  const limits = opts.rateLimit ?? { perMinute: 1200, writesPerMinute: 300 };

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Cloud Run and most PaaS put one proxy in front; needed for per-client rate limits

  // Security headers, including a Content Security Policy that only allows this origin,
  // Google Fonts, and the WebSocket back to this origin.
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        // HTTPS is enforced by the platform (e.g. Cloud Run); upgrading would break plain-http local use.
        upgradeInsecureRequests: null,
      },
    },
    crossOriginEmbedderPolicy: false,
  }));

  // Gzip text responses (JSON, HTML, JS, CSS). Object bytes are sent as-is.
  app.use(compression({ filter: (req, res) => !String(res.getHeader('content-type') ?? '').includes('octet-stream') && compression.filter(req, res) }));

  // CORS: same-origin always works; other origins only if explicitly allowed.
  app.use('/api', cors({
    origin: (origin, cb) => cb(null, !origin || allowed.has(origin)),
    methods: ['GET', 'PUT', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['content-type', 'authorization'],
    exposedHeaders: ['x-vault-sha256', 'x-vault-rebuilt-segments'],
    maxAge: 600,
  }));

  // Rate limits per client IP.
  app.use('/api', rateLimit({ windowMs: 60_000, limit: limits.perMinute, standardHeaders: 'draft-8', legacyHeaders: false, message: { ok: false, reason: 'Too many requests. Try again in a minute.' } }));
  const writeLimit = rateLimit({ windowMs: 60_000, limit: limits.writesPerMinute, standardHeaders: 'draft-8', legacyHeaders: false, message: { ok: false, reason: 'Too many changes. Try again in a minute.' } });

  // Optional bearer token for every state-changing request.
  const requireToken = (req: Request, res: Response, next: NextFunction) => {
    if (!opts.apiToken) { next(); return; }
    const header = req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!safeEqual(token, opts.apiToken)) { res.status(401).json({ ok: false, reason: 'Missing or invalid API token.' }); return; }
    next();
  };
  const guard = [writeLimit, requireToken];
  const chaos = (_req: Request, res: Response, next: NextFunction) => {
    if (!enableChaos) { res.status(403).json({ ok: false, reason: 'Fault injection is disabled on this deployment.' }); return; }
    next();
  };
  const json = express.json({ limit: '16kb' });

  /* ------------------------------------------------------------------ reads */

  app.get('/api/health', (_req, res) => {
    res.json({ service: 'vault', ready: mgr.ready, nodes: mgr.nodes.length, objects: mgr.objects.size, quorum: mgr.hasQuorum(), authRequired: !!opts.apiToken, chaos: enableChaos });
  });
  const snapshot = () => ({ ...mgr.snapshot(), authRequired: !!opts.apiToken });
  app.get('/api/snapshot', (_req, res) => res.json(snapshot()));

  app.get('/api/objects', (_req, res) => {
    res.json([...mgr.objects.values()].map((o) => ({ name: o.name, size: o.size, policy: o.policy, version: o.version, sha256: o.sha })));
  });

  app.get('/api/objects/:name', wrap(async (req, res) => {
    const r = await mgr.readObject(objectName(req));
    if (!r.ok || !r.bytes) {
      res.status(r.reason?.includes('does not exist') ? 404 : 503).json({ ok: false, reason: r.reason ?? 'Checksum mismatch.' });
      return;
    }
    res.setHeader('content-type', 'application/octet-stream');
    const base = String(req.params.name).split('/').pop() || 'object';
    res.setHeader('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(base)}`);
    res.setHeader('x-vault-sha256', r.sha!);
    res.setHeader('x-vault-rebuilt-segments', String(r.decoded ?? 0));
    res.setHeader('cache-control', 'no-store');
    res.end(Buffer.from(r.bytes));
  }));

  app.post('/api/verify/:name', wrap(async (req, res) => {
    const { bytes: _bytes, ...report } = await mgr.readObject(objectName(req));
    res.json(report);
  }));

  /* ------------------------------------------------------------------ writes */

  app.put('/api/objects/:name', ...guard, express.raw({ type: () => true, limit: `${maxUploadMb}mb` }), wrap(async (req, res) => {
    const name = objectName(req);
    const policy = String(req.query.policy ?? mgr.settings.policy) as PolicyKey;
    if (!Object.hasOwn(POLICIES, policy)) throw new HttpError(400, `Unknown policy "${policy}". Use rep3, rep2, or ec42.`);
    const body = Buffer.isBuffer(req.body) ? new Uint8Array(req.body) : new Uint8Array(0);
    const r = await mgr.putObject(name, body, policy);
    const { obj, ...rest } = r;
    res.status(r.ok ? 201 : 503).json({ ...rest, version: obj?.version, sha256: obj?.sha });
  }));

  app.delete('/api/objects/:name', ...guard, wrap(async (req, res) => {
    const ok = await mgr.deleteObject(objectName(req));
    res.status(ok ? 200 : 404).json({ ok });
  }));

  app.patch('/api/settings', ...guard, json, wrap(async (req, res) => res.json(await mgr.updateSettings(req.body ?? {}))));
  app.post('/api/nodes', ...guard, wrap(async (_req, res) => {
    if (mgr.nodes.length >= 32) throw new HttpError(409, 'This cluster is limited to 32 storage nodes.');
    res.status(201).json({ id: await mgr.addNode() });
  }));
  app.post('/api/log', ...guard, json, (req, res) => {
    const kind: LogKind = LOG_KINDS.includes(req.body?.kind) ? req.body.kind : 'info';
    mgr.addLog(kind, String(req.body?.msg ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 300));
    res.json({ ok: true });
  });

  /* ---------------------------------------------------------- fault injection */

  app.post('/api/chaos/nodes/:id/crash', chaos, ...guard, wrap((req, res) => res.json({ ok: mgr.crashNode(nodeId(req)) })));
  app.post('/api/chaos/nodes/:id/restart', chaos, ...guard, wrap((req, res) => res.json({ ok: mgr.restartNode(nodeId(req)) })));
  app.post('/api/chaos/nodes/:id/corrupt', chaos, ...guard, wrap(async (req, res) => { const key = await mgr.injectRot(nodeId(req)); res.json({ ok: !!key, key }); }));
  app.post('/api/chaos/random-crash', chaos, ...guard, (_req, res) => { res.json({ node: mgr.crashRandomNode() }); });
  app.post('/api/chaos/partition', chaos, ...guard, json, (req, res) => { mgr.setIsolated(req.body?.on === true); res.json({ isolated: mgr.isolated }); });
  app.post('/api/chaos/meta/:id/toggle', chaos, ...guard, wrap((req, res) => { mgr.toggleMeta(nodeId(req)); res.json({ ok: true }); }));

  app.use('/api', (_req, res) => { res.status(404).json({ ok: false, reason: 'Not found.' }); });

  /* ------------------------------------------------------------ the dashboard */

  if (opts.staticDir && existsSync(join(opts.staticDir, 'index.html'))) {
    // Hashed build assets never change, so browsers may cache them for a year; index.html is always revalidated.
    app.use('/assets', express.static(join(opts.staticDir, 'assets'), { immutable: true, maxAge: '365d', index: false }));
    app.use(express.static(opts.staticDir, { index: false, maxAge: 0 }));
    app.get(/^\/(?!api|ws).*/, (_req, res) => {
      res.setHeader('cache-control', 'no-cache');
      res.sendFile(join(opts.staticDir!, 'index.html'));
    });
  }

  // Errors: known client errors keep their message; anything unexpected is logged and hidden.
  app.use((err: Error & { status?: number; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    const status = err instanceof HttpError ? err.status : err.status ?? 500;
    if (status >= 500) console.error('[gateway]', err);
    const reason = err instanceof HttpError ? err.message
      : status === 413 ? `Upload is larger than the ${maxUploadMb} MB limit.`
      : status < 500 ? 'Bad request.' : 'Internal server error.';
    res.status(status).json({ ok: false, reason });
  });

  /* --------------------------------------------------------------- WebSocket */

  const server: Server = createServer(app);
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    maxPayload: 1024, // clients only listen
    perMessageDeflate: { threshold: 1024 }, // snapshots compress roughly 10:1
    verifyClient: ({ origin, req }: { origin?: string; req: IncomingMessage }) =>
      !origin || allowed.has(origin) || new URL(origin).host === req.headers.host,
  });
  // The HTTP server reports listen errors (like a busy port); don't throw them a second time here.
  wss.on('error', () => undefined);

  // Push only when something changed, so idle dashboards cost nothing.
  let last = '';
  const push = () => {
    if (!wss.clients.size) return;
    const msg = JSON.stringify(snapshot());
    if (msg === last) return;
    last = msg;
    for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(msg);
  };
  wss.on('connection', (ws) => {
    ws.on('message', () => ws.close(1003, 'read-only'));
    ws.send(JSON.stringify(snapshot()));
  });
  const timer = setInterval(push, opts.pushMs ?? 250);
  server.on('close', () => { clearInterval(timer); wss.close(); });

  return { app, server };
}