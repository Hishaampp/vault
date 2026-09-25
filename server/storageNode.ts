/**
 * A storage node: one OS process that owns one directory on disk.
 *
 *   PUT    /pieces/:key   store bytes (rejected unless x-sha256 matches the body)
 *   GET    /pieces/:key   return the bytes exactly as they are on disk
 *   DELETE /pieces/:key   remove a piece
 *   GET    /health        heartbeat: inventory, bytes, scrubber findings
 *   POST   /config        { scrub: boolean }
 *   POST   /chaos/corrupt flip bits in a piece file on disk (fault injection)
 *
 * Each piece is a data file plus a `.sha256` sidecar holding its checksum,
 * so a local scrubber can detect bit rot without asking anyone.
 */
import express from 'express';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface StorageNodeOptions {
  id: string;
  rack: string;
  dir: string;
  scrub?: boolean;
  /** pieces verified per scrub step */
  scrubBatch?: number;
  scrubIntervalMs?: number;
}

interface PieceEntry { len: number; sum: string }

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const fileFor = (dir: string, key: string) => join(dir, encodeURIComponent(key));

export async function createStorageNode(opts: StorageNodeOptions) {
  const { id, rack, dir } = opts;
  await mkdir(dir, { recursive: true });
  const pieces = new Map<string, PieceEntry>();
  const corrupt = new Set<string>();
  const scrub = { enabled: opts.scrub ?? true, passes: 0, found: 0, cursor: 0, list: [] as string[], busy: false };

  // Recover inventory from disk: data survives process crashes and restarts.
  for (const f of await readdir(dir)) {
    if (!f.endsWith('.sha256')) continue;
    const key = decodeURIComponent(f.slice(0, -'.sha256'.length));
    try {
      const sum = (await readFile(join(dir, f), 'utf8')).trim();
      const data = await readFile(fileFor(dir, key));
      pieces.set(key, { len: data.length, sum });
    } catch {
      /* orphaned sidecar from an interrupted write: ignore */
    }
  }

  const scrubStep = async () => {
    if (!scrub.enabled || scrub.busy) return;
    scrub.busy = true;
    try {
      if (scrub.cursor >= scrub.list.length) {
        if (scrub.list.length) scrub.passes++;
        scrub.list = [...pieces.keys()];
        scrub.cursor = 0;
      }
      for (let i = 0; i < (opts.scrubBatch ?? 4) && scrub.cursor < scrub.list.length; i++) {
        const key = scrub.list[scrub.cursor++];
        const e = pieces.get(key);
        if (!e || corrupt.has(key)) continue;
        try {
          const data = await readFile(fileFor(dir, key));
          if (sha256(data) !== e.sum) {
            corrupt.add(key);
            scrub.found++;
            console.log(`[${id}] scrubber: checksum mismatch in ${key}`);
          }
        } catch {
          /* deleted while scrubbing */
        }
      }
    } finally {
      scrub.busy = false;
    }
  };
  const timer = setInterval(scrubStep, opts.scrubIntervalMs ?? 150);

  const app = express();
  app.use('/pieces', express.raw({ type: () => true, limit: '64mb' }));
  app.use(express.json());

  app.put('/pieces/:key', async (req, res) => {
    const key = req.params.key;
    const body = new Uint8Array(req.body as Buffer);
    const expected = String(req.headers['x-sha256'] ?? '');
    const actual = sha256(body);
    if (!expected || expected !== actual) {
      res.status(400).json({ error: 'checksum mismatch: bytes were damaged in transit', expected, actual });
      return;
    }
    const file = fileFor(dir, key);
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, body);
    await rename(tmp, file); // atomic replace
    await writeFile(`${file}.sha256`, actual);
    pieces.set(key, { len: body.length, sum: actual });
    corrupt.delete(key);
    res.json({ ok: true, len: body.length });
  });

  app.get('/pieces/:key', async (req, res) => {
    const key = req.params.key;
    if (!pieces.has(key)) { res.status(404).json({ error: 'no such piece' }); return; }
    try {
      const data = await readFile(fileFor(dir, key));
      res.setHeader('content-type', 'application/octet-stream');
      res.setHeader('x-sha256', pieces.get(key)!.sum);
      res.end(data);
    } catch {
      res.status(404).json({ error: 'piece file missing' });
    }
  });

  app.delete('/pieces/:key', async (req, res) => {
    const key = req.params.key;
    const file = fileFor(dir, key);
    await rm(file, { force: true });
    await rm(`${file}.sha256`, { force: true });
    pieces.delete(key);
    corrupt.delete(key);
    res.json({ ok: true });
  });

  app.get('/health', (_req, res) => {
    let bytes = 0;
    for (const e of pieces.values()) bytes += e.len;
    res.json({
      id, rack, pid: process.pid, bytes,
      keys: [...pieces.keys()],
      corrupt: [...corrupt],
      scrub: { enabled: scrub.enabled, passes: scrub.passes, found: scrub.found, progress: scrub.list.length ? scrub.cursor / scrub.list.length : 0 },
    });
  });

  app.post('/config', (req, res) => {
    if (typeof req.body?.scrub === 'boolean') scrub.enabled = req.body.scrub;
    res.json({ ok: true, scrub: scrub.enabled });
  });

  // Fault injection: silently flip bits in a file on disk. Nothing else is told.
  app.post('/chaos/corrupt', async (req, res) => {
    const wanted = req.body?.key as string | undefined;
    const candidates = wanted ? [wanted] : [...pieces.keys()].filter((k) => !corrupt.has(k));
    if (!candidates.length) { res.status(404).json({ error: 'no pieces to corrupt' }); return; }
    const key = candidates[Math.floor(Math.random() * candidates.length)];
    const file = fileFor(dir, key);
    const data = new Uint8Array(await readFile(file));
    if (!data.length) { res.status(409).json({ error: 'empty piece' }); return; }
    for (let i = 0; i < 3; i++) {
      const at = Math.floor(Math.random() * data.length);
      data[at] ^= 1 << (1 + Math.floor(Math.random() * 7));
    }
    if (sha256(data) === pieces.get(key)!.sum) data[0] ^= 1;
    await writeFile(file, data);
    res.json({ ok: true, key });
  });

  return {
    app,
    pieces,
    corrupt,
    scrub,
    scrubStep,
    listen(port: number): Promise<Server> {
      return new Promise((resolve) => {
        const server = app.listen(port, '127.0.0.1', () => resolve(server));
      });
    },
    stop() { clearInterval(timer); },
  };
}

/* ------------------------------------------------------------ run as process */

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`missing --${name}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    // If the manager process dies, exit too instead of lingering as an orphan.
  process.on('disconnect', () => process.exit(0));
  const node = await createStorageNode({ id: arg('id'), rack: arg('rack'), dir: arg('dir'), scrub: arg('scrub', 'true') === 'true' });
  const port = Number(arg('port'));
  await node.listen(port);
  console.log(`[${arg('id')}] storage node listening on :${port} (rack ${arg('rack')}, ${node.pieces.size} pieces on disk)`);
}
