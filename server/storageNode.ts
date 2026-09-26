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
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { requireNodeToken } from './auth';

export interface StorageNodeOptions {
  id: string;
  rack: string;
  dir: string;
  scrub?: boolean;

  /** pieces verified per scrub step */
  scrubBatch?: number;

  scrubIntervalMs?: number;

  /** shared secret required on every request */
  token?: string;
}

interface PieceEntry {
  len: number;
  sum: string;
}

const sha256 = (b: Uint8Array) =>
  createHash('sha256').update(b).digest('hex');

/**
 * Convert the logical Vault key into a safe filename.
 *
 * Example:
 * uploads/26104501 .xlsx@1#0.0
 *
 * becomes something like:
 *
 * uploads%2F26104501%20.xlsx%401%230.0
 */
const fileFor = (dir: string, key: string) =>
  join(dir, encodeURIComponent(key));

export async function createStorageNode(opts: StorageNodeOptions) {
  const { id, rack, dir } = opts;

  /*
   * Make absolutely sure the storage directory exists.
   */
  await mkdir(dir, {
    recursive: true,
  });

  const pieces = new Map<string, PieceEntry>();
  const corrupt = new Set<string>();

  const scrub = {
    enabled: opts.scrub ?? true,
    passes: 0,
    found: 0,
    cursor: 0,
    list: [] as string[],
    busy: false,
  };

  /*
   * Recover inventory from disk.
   *
   * This allows pieces to survive a storage-node process restart.
   */
  try {
    const files = await readdir(dir);

    for (const f of files) {
      if (!f.endsWith('.sha256')) continue;

      const encodedKey = f.slice(0, -'.sha256'.length);

      let key: string;

      try {
        key = decodeURIComponent(encodedKey);
      } catch {
        console.error(
          `[${id}] Failed to decode stored key: ${encodedKey}`,
        );
        continue;
      }

      try {
        const sum = (
          await readFile(join(dir, f), 'utf8')
        ).trim();

        const data = await readFile(
          fileFor(dir, key),
        );

        pieces.set(key, {
          len: data.length,
          sum,
        });
      } catch (err) {
        console.error(
          `[${id}] Failed to recover piece ${key}:`,
          err,
        );
      }
    }
  } catch (err) {
    console.error(
      `[${id}] Failed to scan storage directory ${dir}:`,
      err,
    );
  }

  /*
   * Scrubber
   */
  const scrubStep = async () => {
    if (!scrub.enabled || scrub.busy) return;

    scrub.busy = true;

    try {
      if (scrub.cursor >= scrub.list.length) {
        if (scrub.list.length) {
          scrub.passes++;
        }

        scrub.list = [...pieces.keys()];
        scrub.cursor = 0;
      }

      for (
        let i = 0;
        i < (opts.scrubBatch ?? 4) &&
        scrub.cursor < scrub.list.length;
        i++
      ) {
        const key = scrub.list[scrub.cursor++];

        const entry = pieces.get(key);

        if (!entry || corrupt.has(key)) {
          continue;
        }

        try {
          const data = await readFile(
            fileFor(dir, key),
          );

          if (sha256(data) !== entry.sum) {
            corrupt.add(key);
            scrub.found++;

            console.log(
              `[${id}] scrubber: checksum mismatch in ${key}`,
            );
          }
        } catch (err) {
          console.error(
            `[${id}] scrubber failed for ${key}:`,
            err,
          );
        }
      }
    } finally {
      scrub.busy = false;
    }
  };

  const timer = setInterval(
    scrubStep,
    opts.scrubIntervalMs ?? 150,
  );

  /*
   * Express
   */
  const app = express();

  app.disable('x-powered-by');

  app.use(
    requireNodeToken(
      opts.token ?? process.env.VAULT_NODE_TOKEN,
    ),
  );

  /*
   * IMPORTANT:
   *
   * Parse piece bodies as raw binary.
   */
  app.use(
    '/pieces',
    express.raw({
      type: () => true,
      limit: '64mb',
    }),
  );

  /*
   * Validate key.
   */
  app.param(
    'key',
    (_req, res, next, key: string) => {
      if (
        key.length > 1024 ||
        /[\u0000-\u001f]/.test(key)
      ) {
        res.status(400).json({
          error: 'invalid key',
        });

        return;
      }

      next();
    },
  );

  app.use(express.json());

  /*
   * ------------------------------------------------------------
   * PUT PIECE
   * ------------------------------------------------------------
   */
  app.put(
    '/pieces/:key',
    async (req, res) => {
      const key = req.params.key;

      try {
        /*
         * Express raw() should give us a Buffer.
         */
        if (!Buffer.isBuffer(req.body)) {
          console.error(
            `[${id}] Invalid request body for key=${key}`,
          );

          res.status(400).json({
            error: 'request body is not binary data',
          });

          return;
        }

        const body = new Uint8Array(req.body);

        /*
         * Verify checksum before touching disk.
         */
        const expected = String(
          req.headers['x-sha256'] ?? '',
        );

        const actual = sha256(body);

        if (!expected) {
          res.status(400).json({
            error: 'missing x-sha256 header',
          });

          return;
        }

        if (expected !== actual) {
          console.error(
            `[${id}] Checksum mismatch for ${key}`,
          );

          res.status(400).json({
            error:
              'checksum mismatch: bytes were damaged in transit',
            expected,
            actual,
          });

          return;
        }

        /*
         * Ensure storage directory still exists.
         *
         * This is useful if the Railway container/process
         * was restarted or the directory was recreated.
         */
        await mkdir(dir, {
          recursive: true,
        });

        const file = fileFor(dir, key);

        /*
         * Temporary file.
         *
         * We write completely first and then rename it.
         * This prevents readers from seeing partial data.
         */
        const tmp =
          `${file}.tmp-${process.pid}-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2)}`;

        console.log(
          `[${id}] writing piece key=${key} bytes=${body.length}`,
        );

        /*
         * Write the actual piece.
         */
        await writeFile(tmp, Buffer.from(body));

        /*
         * Atomic replacement.
         */
        await rename(tmp, file);

        /*
         * Write checksum sidecar.
         */
        await writeFile(
          `${file}.sha256`,
          actual,
          'utf8',
        );

        /*
         * Update in-memory inventory only after the disk
         * operations succeeded.
         */
        pieces.set(key, {
          len: body.length,
          sum: actual,
        });

        corrupt.delete(key);

        console.log(
          `[${id}] piece stored successfully key=${key} bytes=${body.length}`,
        );

        res.status(201).json({
          ok: true,
          len: body.length,
          sha256: actual,
        });
      } catch (err) {
        /*
         * THIS IS THE IMPORTANT FIX.
         *
         * Previously an fs error became a generic HTML 500.
         * Now Railway logs the actual filesystem error.
         */
        console.error(
          `[${id}] STORAGE WRITE FAILED`,
          {
            key,
            dir,
            pid: process.pid,
            error:
              err instanceof Error
                ? err.stack
                : String(err),
          },
        );

        res.status(500).json({
          ok: false,
          error: 'storage write failed',
          node: id,
          key,
          message:
            err instanceof Error
              ? err.message
              : String(err),
        });
      }
    },
  );

  /*
   * ------------------------------------------------------------
   * GET PIECE
   * ------------------------------------------------------------
   */
  app.get(
    '/pieces/:key',
    async (req, res) => {
      const key = req.params.key;

      if (!pieces.has(key)) {
        res.status(404).json({
          error: 'no such piece',
        });

        return;
      }

      try {
        const data = await readFile(
          fileFor(dir, key),
        );

        res.setHeader(
          'content-type',
          'application/octet-stream',
        );

        res.setHeader(
          'x-sha256',
          pieces.get(key)!.sum,
        );

        res.end(data);
      } catch (err) {
        console.error(
          `[${id}] Failed to read piece ${key}:`,
          err,
        );

        res.status(404).json({
          error: 'piece file missing',
        });
      }
    },
  );

  /*
   * ------------------------------------------------------------
   * DELETE PIECE
   * ------------------------------------------------------------
   */
  app.delete(
    '/pieces/:key',
    async (req, res) => {
      const key = req.params.key;

      try {
        const file = fileFor(dir, key);

        await rm(file, {
          force: true,
        });

        await rm(`${file}.sha256`, {
          force: true,
        });

        pieces.delete(key);
        corrupt.delete(key);

        res.json({
          ok: true,
        });
      } catch (err) {
        console.error(
          `[${id}] Failed to delete piece ${key}:`,
          err,
        );

        res.status(500).json({
          ok: false,
          error: 'failed to delete piece',
          message:
            err instanceof Error
              ? err.message
              : String(err),
        });
      }
    },
  );

  /*
   * ------------------------------------------------------------
   * HEALTH
   * ------------------------------------------------------------
   */
  app.get(
    '/health',
    (_req, res) => {
      let bytes = 0;

      for (const entry of pieces.values()) {
        bytes += entry.len;
      }

      res.json({
        id,
        rack,
        pid: process.pid,
        bytes,
        keys: [...pieces.keys()],
        corrupt: [...corrupt],
        scrub: {
          enabled: scrub.enabled,
          passes: scrub.passes,
          found: scrub.found,
          progress:
            scrub.list.length
              ? scrub.cursor / scrub.list.length
              : 0,
        },
      });
    },
  );

  /*
   * ------------------------------------------------------------
   * CONFIG
   * ------------------------------------------------------------
   */
  app.post(
    '/config',
    (req, res) => {
      if (
        typeof req.body?.scrub === 'boolean'
      ) {
        scrub.enabled = req.body.scrub;
      }

      res.json({
        ok: true,
        scrub: scrub.enabled,
      });
    },
  );

  /*
   * ------------------------------------------------------------
   * CHAOS / CORRUPTION
   * ------------------------------------------------------------
   */
  app.post(
    '/chaos/corrupt',
    async (req, res) => {
      try {
        const wanted =
          req.body?.key as string | undefined;

        const candidates = wanted
          ? [wanted]
          : [...pieces.keys()].filter(
              (k) => !corrupt.has(k),
            );

        if (!candidates.length) {
          res.status(404).json({
            error: 'no pieces to corrupt',
          });

          return;
        }

        const key =
          candidates[
            Math.floor(
              Math.random() * candidates.length,
            )
          ];

        const file = fileFor(dir, key);

        const data = new Uint8Array(
          await readFile(file),
        );

        if (!data.length) {
          res.status(409).json({
            error: 'empty piece',
          });

          return;
        }

        /*
         * Flip three random bits.
         */
        for (let i = 0; i < 3; i++) {
          const at = Math.floor(
            Math.random() * data.length,
          );

          data[at] ^=
            1 <<
            (1 +
              Math.floor(
                Math.random() * 7,
              ));
        }

        /*
         * Make absolutely sure corruption happened.
         */
        if (
          sha256(data) ===
          pieces.get(key)!.sum
        ) {
          data[0] ^= 1;
        }

        await writeFile(
          file,
          Buffer.from(data),
        );

        res.json({
          ok: true,
          key,
        });
      } catch (err) {
        console.error(
          `[${id}] Corruption injection failed:`,
          err,
        );

        res.status(500).json({
          ok: false,
          error: 'corruption injection failed',
          message:
            err instanceof Error
              ? err.message
              : String(err),
        });
      }
    },
  );

  return {
    app,

    pieces,

    corrupt,

    scrub,

    scrubStep,

    listen(port: number): Promise<Server> {
      return new Promise((resolve, reject) => {
        const server = app.listen(
          port,
          '127.0.0.1',
          () => {
            console.log(
              `[${id}] storage node listening on :${port} ` +
              `(rack ${rack}, ${pieces.size} pieces on disk, dir=${dir})`,
            );

            resolve(server);
          },
        );

        server.on('error', reject);
      });
    },

    stop() {
      clearInterval(timer);
    },
  };
}

/* ------------------------------------------------------------ run as process */

function arg(
  name: string,
  fallback?: string,
): string {
  const i = process.argv.indexOf(`--${name}`);

  if (
    i >= 0 &&
    process.argv[i + 1]
  ) {
    return process.argv[i + 1];
  }

  if (fallback !== undefined) {
    return fallback;
  }

  throw new Error(
    `missing --${name}`,
  );
}

if (
  process.argv[1] &&
  import.meta.url ===
    pathToFileURL(process.argv[1]).href
) {
  /*
   * If the manager process dies, exit too instead
   * of lingering as an orphan.
   */
  process.on(
    'disconnect',
    () => process.exit(0),
  );

  const node =
    await createStorageNode({
      id: arg('id'),
      rack: arg('rack'),
      dir: arg('dir'),
      scrub:
        arg('scrub', 'true') ===
        'true',
    });

  const port = Number(
    arg('port'),
  );

  await node.listen(port);

  console.log(
    `[${arg('id')}] storage node ready`,
  );
}