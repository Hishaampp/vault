/**
 * Starts a Vault cluster:
 *   - 9 logical storage-node processes
 *   - 3 metadata-replica processes
 *   - 1 API gateway
 *
 * Local:
 *   npm run cluster
 *   npm run cluster -- --fresh
 *
 * Railway:
 *   PORT is provided automatically by Railway.
 *
 * Environment:
 *   PORT                  Railway/platform-provided port
 *   VAULT_PORT            Optional local override
 *   VAULT_API_TOKEN       Optional API authentication token
 *   VAULT_CORS_ORIGINS    Comma-separated allowed frontend origins
 *   VAULT_ENABLE_CHAOS    "false" to disable fault injection
 *   VAULT_MAX_UPLOAD_MB   Maximum upload size (default 64)
 *   VAULT_NODES           Number of logical storage nodes (default 9)
 *   VAULT_SEED            "false" to disable demo seed data
 *   VAULT_TRAFFIC         "false" to disable background demo traffic
 */

import { rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGateway } from './gateway';
import { ClusterManager } from './manager';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ─────────────────────────────────────────────────────────────
// CLI helpers
// ─────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);

const flag = (name: string) =>
  argv.includes(`--${name}`);

const opt = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1]
    ? argv[i + 1]
    : fallback;
};

// ─────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────

const isProduction =
  process.env.NODE_ENV === 'production' ||
  !!process.env.RAILWAY_ENVIRONMENT;

const port = Number(
  opt(
    'port',
    process.env.VAULT_PORT ??
      process.env.PORT ??
      '7070',
  ),
);

const dataDir = resolve(
  opt(
    'data',
    process.env.VAULT_DATA_DIR ??
      join(ROOT, '.vault-data'),
  ),
);

const nodeCount = Number(
  opt(
    'nodes',
    process.env.VAULT_NODES ?? '9',
  ),
);

// Local CLI --fresh is allowed.
// Never wipe Railway data automatically.
const fresh =
  flag('fresh') &&
  !isProduction;

if (fresh) {
  console.log(`Removing Vault data directory: ${dataDir}`);
  await rm(dataDir, {
    recursive: true,
    force: true,
  });
}

// Seed demo data locally by default.
// In production, disable unless explicitly requested.
const seed =
  process.env.VAULT_SEED !== undefined
    ? process.env.VAULT_SEED !== 'false'
    : !isProduction;

// Background demo traffic should normally be disabled
// in production so it doesn't compete with real uploads.
const traffic =
  process.env.VAULT_TRAFFIC !== undefined
    ? process.env.VAULT_TRAFFIC !== 'false'
    : !isProduction;

const quiet =
  process.env.VAULT_VERBOSE === 'true'
    ? false
    : !flag('verbose');

// ─────────────────────────────────────────────────────────────
// Startup information
// ─────────────────────────────────────────────────────────────

console.log('');
console.log('══════════════════════════════════════════════════');
console.log('                 VAULT STARTUP');
console.log('══════════════════════════════════════════════════');
console.log(`Environment : ${isProduction ? 'production' : 'development'}`);
console.log(`Port        : ${port}`);
console.log(`Data        : ${dataDir}`);
console.log(`Nodes       : ${nodeCount}`);
console.log(`Seed        : ${seed}`);
console.log(`Traffic     : ${traffic}`);
console.log(`Fresh       : ${fresh}`);
console.log('Metadata    : 3 replicas');
console.log('══════════════════════════════════════════════════');
console.log('');

// ─────────────────────────────────────────────────────────────
// Start cluster
// ─────────────────────────────────────────────────────────────

const mgr = new ClusterManager({
  dataDir,
  nodes: nodeCount,
  seed,
  quiet,

  // IMPORTANT:
  // Do not generate background traffic on Railway
  // unless explicitly enabled.
  traffic,
});

await mgr.start();

console.log('');
console.log(
  `Vault cluster started with ${nodeCount} storage nodes + 3 metadata replicas.`,
);

// ─────────────────────────────────────────────────────────────
// Gateway
// ─────────────────────────────────────────────────────────────

const env = process.env;

const apiToken =
  env.VAULT_API_TOKEN || undefined;

const corsOrigins = (
  env.VAULT_CORS_ORIGINS ?? ''
)
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const enableChaos =
  env.VAULT_ENABLE_CHAOS !== 'false';

const maxUploadMb =
  Number(env.VAULT_MAX_UPLOAD_MB ?? 64);

const { server } = createGateway(mgr, {
  staticDir: join(ROOT, 'dist'),

  apiToken,

  corsOrigins,

  enableChaos,

  maxUploadMb,
});

// ─────────────────────────────────────────────────────────────
// Server errors
// ─────────────────────────────────────────────────────────────

server.on(
  'error',
  async (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error('');
      console.error(
        `Port ${port} is already in use.`,
      );
      console.error(
        'Try another local port, for example:',
      );
      console.error(
        'VAULT_PORT=7171 npm run dev:live',
      );
    } else {
      console.error(
        '[Vault] Gateway error:',
        err,
      );
    }

    await mgr.stop();
    process.exit(1);
  },
);

// ─────────────────────────────────────────────────────────────
// Listen
// ─────────────────────────────────────────────────────────────
//
// IMPORTANT:
// Railway requires the application to listen on
// the PORT environment variable and accept external
// connections.
//
// If createGateway/server is not already binding to
// 0.0.0.0 internally, change this to:
//
// server.listen(port, '0.0.0.0', () => {
//
// ─────────────────────────────────────────────────────────────

server.listen(port, '0.0.0.0', () => {
  console.log('');
  console.log('══════════════════════════════════════════════════');
  console.log('                 VAULT IS RUNNING');
  console.log('══════════════════════════════════════════════════');

  if (isProduction) {
    console.log(
      `  Environment : production`,
    );
    console.log(
      `  Listening   : 0.0.0.0:${port}`,
    );
    console.log(
      `  API         : /api/health`,
    );
  } else {
    console.log(
      `  API         : http://localhost:${port}/api/health`,
    );
    console.log(
      `  Dashboard   : http://localhost:${port}`,
    );
  }

  console.log('');
  console.log('Cluster nodes:');

  for (const n of mgr.nodes) {
    console.log(
      `  ${n.id}  rack=${n.rack}  pid=${n.proc?.pid}  port=${n.port}`,
    );
  }

  console.log('');
  console.log('Metadata replicas:');

  for (const m of mgr.metas) {
    console.log(
      `  ${m.id}  pid=${m.proc?.pid}  port=${m.port}`,
    );
  }

  console.log('');
  console.log(
    `API token  : ${apiToken ? 'enabled' : 'disabled'}`,
  );
  console.log(
    `Chaos      : ${enableChaos ? 'enabled' : 'disabled'}`,
  );
  console.log(
    `Max upload : ${maxUploadMb} MB`,
  );
  console.log(
    `Traffic    : ${traffic ? 'enabled' : 'disabled'}`,
  );

  console.log('══════════════════════════════════════════════════');
  console.log('');
});

// ─────────────────────────────────────────────────────────────
// Graceful shutdown
// ─────────────────────────────────────────────────────────────

let shuttingDown = false;

const shutdown = async (signal: string) => {
  if (shuttingDown) return;

  shuttingDown = true;

  console.log('');
  console.log(
    `[Vault] Received ${signal}. Stopping cluster...`,
  );

  try {
    server.close();

    await mgr.stop();

    console.log(
      '[Vault] Cluster stopped cleanly.',
    );

    process.exit(0);
  } catch (err) {
    console.error(
      '[Vault] Shutdown error:',
      err,
    );

    process.exit(1);
  }
};

process.on(
  'SIGINT',
  () => shutdown('SIGINT'),
);

process.on(
  'SIGTERM',
  () => shutdown('SIGTERM'),
);

// ─────────────────────────────────────────────────────────────
// Unexpected errors
// ─────────────────────────────────────────────────────────────

process.on(
  'uncaughtException',
  async (err) => {
    console.error(
      '[Vault] Uncaught exception:',
      err,
    );

    try {
      await mgr.stop();
    } finally {
      process.exit(1);
    }
  },
);

process.on(
  'unhandledRejection',
  async (reason) => {
    console.error(
      '[Vault] Unhandled promise rejection:',
      reason,
    );

    try {
      await mgr.stop();
    } finally {
      process.exit(1);
    }
  },
);