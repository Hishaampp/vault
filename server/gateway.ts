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
 *   POST /api/chaos/random-crash, POST /api/chaos/partition
 *   POST /api/chaos/meta/:id/toggle
 *
 * WebSocket /ws pushes a full cluster snapshot several times per second.
 */

import express, {
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import cors from 'cors';

import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';

import { WebSocketServer, WebSocket } from 'ws';

import type { ClusterManager } from './manager';
import { POLICIES } from '../src/engine/policies';
import type { LogKind, PolicyKey } from '../src/engine/types';

export interface GatewayOptions {
  staticDir?: string;
  pushMs?: number;
}

const wrap = (
  fn: (req: Request, res: Response) => Promise<unknown> | unknown,
) =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res)).catch(next);
  };

export function createGateway(
  mgr: ClusterManager,
  opts: GatewayOptions = {},
) {
  const app = express();

  app.disable('x-powered-by');

  // CORS
  //
  // Local development:
  //   http://localhost:5173
  //
  // Production:
  //   Set FRONTEND_URL to your Vercel frontend URL.
  //
  // Example:
  //   FRONTEND_URL=https://your-vault.vercel.app
  app.use(
    cors({
      origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    }),
  );

  // ---------------------------------------------------------------------------
  // Health
  // ---------------------------------------------------------------------------

  app.get('/api/health', (_req, res) => {
    res.json({
      service: 'vault',
      ready: mgr.ready,
      nodes: mgr.nodes.length,
      objects: mgr.objects.size,
      quorum: mgr.hasQuorum(),
    });
  });

  // ---------------------------------------------------------------------------
  // Cluster snapshot
  // ---------------------------------------------------------------------------

  app.get('/api/snapshot', (_req, res) => {
    res.json(mgr.snapshot());
  });

  // ---------------------------------------------------------------------------
  // Objects
  // ---------------------------------------------------------------------------

  app.get('/api/objects', (_req, res) => {
    res.json(
      [...mgr.objects.values()].map((o) => ({
        name: o.name,
        size: o.size,
        policy: o.policy,
        version: o.version,
        sha256: o.sha,
      })),
    );
  });

  app.put(
    '/api/objects/:name',
    express.raw({
      type: () => true,
      limit: '64mb',
    }),
    wrap(async (req, res) => {
      const policy = String(
        req.query.policy ?? mgr.settings.policy,
      ) as PolicyKey;

      if (!POLICIES[policy]) {
        res.status(400).json({
          ok: false,
          reason: `Unknown policy "${policy}". Use rep3, rep2, or ec42.`,
        });
        return;
      }

      const body = Buffer.isBuffer(req.body)
        ? new Uint8Array(req.body)
        : new Uint8Array(0);

      const r = await mgr.putObject(
        String(req.params.name),
        body,
        policy,
      );

      const { obj, ...rest } = r;

      res.status(r.ok ? 201 : 503).json({
        ...rest,
        version: obj?.version,
        sha256: obj?.sha,
      });
    }),
  );

  app.get(
    '/api/objects/:name',
    wrap(async (req, res) => {
      const r = await mgr.readObject(String(req.params.name));

      if (!r.ok || !r.bytes) {
        res
          .status(
            r.reason?.includes('does not exist') ? 404 : 503,
          )
          .json({
            ok: false,
            reason: r.reason ?? 'checksum mismatch',
          });

        return;
      }

      res.setHeader(
        'content-type',
        'application/octet-stream',
      );

      res.setHeader('x-vault-sha256', r.sha!);

      res.setHeader(
        'x-vault-rebuilt-segments',
        String(r.decoded ?? 0),
      );

      res.end(Buffer.from(r.bytes));
    }),
  );

  app.delete(
    '/api/objects/:name',
    wrap(async (req, res) => {
      const ok = await mgr.deleteObject(
        String(req.params.name),
      );

      res.status(ok ? 200 : 404).json({ ok });
    }),
  );

  app.post(
    '/api/verify/:name',
    wrap(async (req, res) => {
      const {
        bytes: _bytes,
        ...report
      } = await mgr.readObject(String(req.params.name));

      res.json(report);
    }),
  );

  // ---------------------------------------------------------------------------
  // JSON API
  // ---------------------------------------------------------------------------

  app.use(express.json());

  app.patch(
    '/api/settings',
    wrap(async (req, res) =>
      res.json(await mgr.updateSettings(req.body ?? {})),
    ),
  );

  app.post(
    '/api/nodes',
    wrap(async (_req, res) =>
      res.status(201).json({
        id: await mgr.addNode(),
      }),
    ),
  );

  // ---------------------------------------------------------------------------
  // Chaos / fault injection
  // ---------------------------------------------------------------------------

  app.post(
    '/api/chaos/nodes/:id/crash',
    (req, res) => {
      res.json({
        ok: mgr.crashNode(String(req.params.id)),
      });
    },
  );

  app.post(
    '/api/chaos/nodes/:id/restart',
    (req, res) => {
      res.json({
        ok: mgr.restartNode(String(req.params.id)),
      });
    },
  );

  app.post(
    '/api/chaos/nodes/:id/corrupt',
    wrap(async (req, res) => {
      const key = await mgr.injectRot(
        String(req.params.id),
      );

      res.json({
        ok: !!key,
        key,
      });
    }),
  );

  app.post(
    '/api/chaos/random-crash',
    (_req, res) => {
      res.json({
        node: mgr.crashRandomNode(),
      });
    },
  );

  app.post(
    '/api/chaos/partition',
    (req, res) => {
      mgr.setIsolated(!!req.body?.on);

      res.json({
        isolated: mgr.isolated,
      });
    },
  );

  app.post(
    '/api/chaos/meta/:id/toggle',
    (req, res) => {
      mgr.toggleMeta(String(req.params.id));

      res.json({
        ok: true,
      });
    },
  );

  // ---------------------------------------------------------------------------
  // Logging
  // ---------------------------------------------------------------------------

  app.post('/api/log', (req, res) => {
    const kinds: LogKind[] = [
      'fault',
      'warn',
      'bad',
      'heal',
      'repair',
      'info',
    ];

    const kind = kinds.includes(req.body?.kind)
      ? req.body.kind
      : 'info';

    mgr.addLog(
      kind,
      String(req.body?.msg ?? '').slice(0, 300),
    );

    res.json({ ok: true });
  });

  // ---------------------------------------------------------------------------
  // Static frontend (optional)
  // ---------------------------------------------------------------------------

  if (
    opts.staticDir &&
    existsSync(join(opts.staticDir, 'index.html'))
  ) {
    app.use(express.static(opts.staticDir));

    app.get(
      /^\/(?!api|ws).*/,
      (_req, res) =>
        res.sendFile(
          join(opts.staticDir!, 'index.html'),
        ),
    );
  }

  // ---------------------------------------------------------------------------
  // Error handler
  // ---------------------------------------------------------------------------

  app.use(
    (
      err: Error,
      _req: Request,
      res: Response,
      _next: NextFunction,
    ) => {
      console.error(err);

      res.status(500).json({
        ok: false,
        reason: err.message,
      });
    },
  );

  // ---------------------------------------------------------------------------
  // HTTP + WebSocket server
  // ---------------------------------------------------------------------------

  const server: Server = createServer(app);

  const wss = new WebSocketServer({
    server,
    path: '/ws',
  });

  // The HTTP server reports listen errors such as a busy port.
  // Don't throw them a second time here.
  wss.on('error', () => undefined);

  const push = () => {
    if (!wss.clients.size) return;

    const msg = JSON.stringify(mgr.snapshot());

    for (const c of wss.clients) {
      if (c.readyState === WebSocket.OPEN) {
        c.send(msg);
      }
    }
  };

  wss.on('connection', (ws) => {
    ws.send(JSON.stringify(mgr.snapshot()));
  });

  const timer = setInterval(
    push,
    opts.pushMs ?? 250,
  );

  server.on('close', () => {
    clearInterval(timer);
    wss.close();
  });

  return {
    app,
    server,
  };
}