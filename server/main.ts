/**
 * Starts a Vault cluster on this machine:
 *   9 storage-node processes, 3 metadata-replica processes, and the gateway.
 *
 *   npm run cluster            keep data from previous runs
 *   npm run cluster -- --fresh wipe the data directory first
 *
 * Flags: --port 7070  --data ./.vault-data  --nodes 9  --fresh  --no-seed
 *
 * Port 7070 is the default because macOS uses 7000 for AirPlay Receiver.
 */
import { rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGateway } from './gateway';
import { ClusterManager } from './manager';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const opt = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const port = Number(opt('port', process.env.VAULT_PORT ?? process.env.PORT ?? '7070'));
const dataDir = resolve(opt('data', join(ROOT, '.vault-data')));
if (flag('fresh')) await rm(dataDir, { recursive: true, force: true });

const mgr = new ClusterManager({ dataDir, nodes: Number(opt('nodes', '9')), seed: !flag('no-seed'), quiet: !flag('verbose') });
console.log(`Starting Vault: ${opt('nodes', '9')} storage nodes + 3 metadata replicas, data in ${dataDir}`);
await mgr.start();

const { server } = createGateway(mgr, { staticDir: join(ROOT, 'dist') });
server.on('error', async (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${port} is already in use by another program.`);
    console.error(`On macOS this is often AirPlay Receiver (ports 5000 and 7000).`);
    console.error(`Start Vault on another port instead:  VAULT_PORT=7171 npm run dev:live\n`);
  } else {
    console.error(err);
  }
  await mgr.stop();
  process.exit(1);
});
server.listen(port, () => {
  console.log(`\nVault is running.`);
  console.log(`  API        http://localhost:${port}/api/health`);
  console.log(`  Dashboard  http://localhost:${port}   (after "npm run build"; or run "npm run dev" and open http://localhost:5173)`);
  console.log(`\nTry:  curl -X PUT --data-binary @README.md "http://localhost:${port}/api/objects/readme.md?policy=ec42"`);
  console.log(`      curl http://localhost:${port}/api/objects/readme.md\n`);
  for (const n of mgr.nodes) console.log(`  ${n.id}  rack ${n.rack}  pid ${n.proc?.pid}  port ${n.port}`);
  for (const m of mgr.metas) console.log(`  ${m.id}  metadata  pid ${m.proc?.pid}  port ${m.port}`);
});

const shutdown = async () => {
  console.log('\nStopping cluster…');
  server.close();
  await mgr.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', async (err) => {
  console.error(err);
  await mgr.stop(); // never leave node processes running in the background
  process.exit(1);
});