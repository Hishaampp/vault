/**
 * A metadata replica: a versioned key-value store persisted to disk.
 *
 *   PUT /kv/:key  { rev, value }  accepted only if rev is newer (stale writes rejected)
 *   GET /kv/:key                  one entry
 *   GET /kv                       every entry (used for recovery and re-sync)
 *   GET /health
 *
 * The manager writes every change to all 3 replicas and treats it as
 * committed once 2 acknowledge. Any 2 replicas therefore always contain the
 * latest committed revision, so the manager can crash and rebuild its state
 * from a majority.
 */
import express from 'express';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface MetaEntry { rev: number; value: unknown }

export async function createMetaNode(opts: { id: string; dir: string }) {
  const { id, dir } = opts;
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'metadata.json');
  const entries = new Map<string, MetaEntry>();
  try {
    const saved = JSON.parse(await readFile(file, 'utf8')) as [string, MetaEntry][];
    for (const [k, v] of saved) entries.set(k, v);
  } catch {
    /* first boot */
  }

  // Serialize persistence so concurrent writes never interleave on disk.
  let chain: Promise<void> = Promise.resolve();
  const persist = () => {
    chain = chain.then(async () => {
      const tmp = `${file}.tmp`;
      await writeFile(tmp, JSON.stringify([...entries]));
      await rename(tmp, file);
    });
    return chain;
  };

  const app = express();
  app.use(express.json({ limit: '32mb' }));

  app.put('/kv/:key', async (req, res) => {
    const { rev, value } = req.body as MetaEntry;
    if (typeof rev !== 'number') { res.status(400).json({ error: 'rev required' }); return; }
    const cur = entries.get(req.params.key);
    if (cur && cur.rev >= rev) { res.status(409).json({ ok: false, rev: cur.rev }); return; }
    entries.set(req.params.key, { rev, value });
    await persist(); // acknowledge only after the write is on disk
    res.json({ ok: true, rev });
  });

  app.get('/kv/:key', (req, res) => {
    const e = entries.get(req.params.key);
    if (!e) { res.status(404).json({ error: 'not found' }); return; }
    res.json(e);
  });

  app.get('/kv', (_req, res) => res.json({ entries: [...entries] }));
  app.get('/health', (_req, res) => res.json({ id, entries: entries.size, pid: process.pid }));

  return {
    app,
    entries,
    listen(port: number): Promise<Server> {
      return new Promise((resolve) => {
        const server = app.listen(port, '127.0.0.1', () => resolve(server));
      });
    },
  };
}

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || !process.argv[i + 1]) throw new Error(`missing --${name}`);
  return process.argv[i + 1];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    // If the manager process dies, exit too instead of lingering as an orphan.
  process.on('disconnect', () => process.exit(0));
  const node = await createMetaNode({ id: arg('id'), dir: arg('dir') });
  const port = Number(arg('port'));
  await node.listen(port);
  console.log(`[${arg('id')}] metadata replica listening on :${port} (${node.entries.size} entries)`);
}
