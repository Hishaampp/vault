# Vault: fault-tolerant distributed object storage

Vault stores, replicates, verifies, and repairs objects across independently failing storage nodes. It runs as a **real multi-process cluster on Node.js** (every storage node and metadata replica is its own OS process with its own files on disk), and ships with a live **Mission Control** dashboard for injecting faults and watching the cluster heal itself.

## Quick start

Requires Node.js 20.6 or newer. The backend uses port **7070** (macOS reserves 7000 for AirPlay Receiver). To use another port: `VAULT_PORT=7171 npm run dev:live`.

```bash
npm install
npm run dev:live      # starts the cluster AND the dashboard -> open http://localhost:5173
```

Other ways to run it:

```bash
npm run cluster          # backend only (API on http://localhost:7070), keeps data between runs
VAULT_PORT=7171 npm run dev:live   # use a different backend port if 7070 is busy
npm run cluster:fresh    # backend with a wiped data directory
npm start                # build the dashboard, then serve everything from http://localhost:7070
npm run dev              # dashboard only; with no backend it falls back to the in-browser simulator
npm test                 # all tests (engine, UI, accessibility, storage node, metadata, live cluster)
npm run test:a11y        # accessibility tests only
npm run lint             # lint the whole codebase (TypeScript + strict accessibility rules)
npm run bench            # performance benchmarks
npm run build:single     # one self-contained HTML file (simulator mode) for offline demos
```

The dashboard shows a **Live cluster** badge when it's connected to the backend, and **Simulator** when it's running entirely in the browser. Add `?sim` to the URL to force the simulator.

## Architecture

```
  Browser dashboard (React)
     │  REST: upload, download, chaos        │  WebSocket: live snapshots (4/s)
     ▼                                        ▼
 ┌──────────────────────── Gateway + Manager (Node.js) ────────────────────────┐
 │  write path · read path · heartbeats · repair queue · rebalancer · traffic   │
 └───────┬──────────────────────────────────────────────────────┬──────────────┘
         │ HTTP                                                   │ HTTP
         ▼                                                        ▼
  Storage node processes (n1..n9)                        Metadata replicas (m1..m3)
  rack A: n1 n4 n7   rack B: n2 n5 n8   rack C: n3 n6 n9  versioned key-value store
  each: own directory of piece files + .sha256 sidecars   commit = 2 of 3 acknowledge
        local integrity scrubber                           persisted to disk
```

All data lives under `.vault-data/`: one folder per node. You can open it and see the actual piece files.

## Tech stack

| Layer | Technology |
|---|---|
| Backend runtime | Node.js 20+, TypeScript run directly with tsx |
| HTTP servers | Express 5 (gateway, every storage node, every metadata replica) |
| Security | Helmet (CSP and security headers), express-rate-limit, CORS allowlist, constant-time token checks |
| Efficiency | compression (gzip), WebSocket permessage-deflate, bounded parallel I/O |
| Live updates | WebSocket (`ws`) |
| Process supervision | `child_process.fork`: each node is a separate OS process |
| Storage | Plain files on disk, written atomically (temp file + rename), with SHA-256 sidecars |
| Checksums | SHA-256 (`node:crypto` on the server, Web Crypto in the browser) |
| Erasure coding | Reed-Solomon over GF(2⁸), Cauchy matrix, written from scratch and shared by server and browser |
| Frontend | React 19, Vite 7, plain CSS with light/dark themes |
| Tests | Vitest, React Testing Library, jsdom, axe-core, real multi-process integration tests, Vitest benchmarks |
| Quality | ESLint (typescript-eslint, jsx-a11y strict, react-hooks), GitHub Actions CI |

## REST API

```bash
# upload with a durability policy: rep3, rep2, or ec42
curl -X PUT --data-binary @photo.jpg "http://localhost:7070/api/objects/photo.jpg?policy=ec42"

# download (verified end to end; header x-vault-sha256 carries the checksum)
curl http://localhost:7070/api/objects/photo.jpg -o photo-back.jpg

curl http://localhost:7070/api/objects                    # list
curl -X DELETE http://localhost:7070/api/objects/photo.jpg
curl -X POST http://localhost:7070/api/verify/photo.jpg   # read + verify report
```

Fault injection and operations:

| Method and path | Effect |
|---|---|
| `POST /api/chaos/nodes/:id/crash` | Kill the node's process with SIGKILL |
| `POST /api/chaos/nodes/:id/restart` | Start the process again; its disk is still there |
| `POST /api/chaos/nodes/:id/corrupt` | Flip bits in one piece file on that node's disk |
| `POST /api/chaos/random-crash` | Kill a random storage node |
| `POST /api/chaos/partition` `{"on":true}` | Cut rack C off from the manager |
| `POST /api/chaos/meta/:id/toggle` | Kill or restart a metadata replica |
| `POST /api/nodes` | Launch a new storage node process and rebalance onto it |
| `PATCH /api/settings` | Policy, dead timeout, parallel repairs, repair bandwidth, scrubber, traffic |
| `GET /api/snapshot` | Full cluster state as JSON |

## How each requirement is met

| Requirement | Implementation |
|---|---|
| Large objects | Split into segments (256 KB replicated, 512 KB erasure coded) |
| Configurable durability | Per-upload policy: Replicate ×3, Replicate ×2, or Erasure 4+2 |
| Low storage overhead | Erasure 4+2 survives any 2 failures at 50% overhead, versus 200% for three copies |
| Rack-level tolerance | Pieces dealt round-robin across racks: a 4+2 segment lands 2-2-2 and survives losing a whole rack |
| Write safety | Pieces written in parallel; acknowledged only after a write quorum (2 of 3, or 5 of 6); metadata committed last; failures rolled back |
| End-to-end integrity | The manager sends a SHA-256 with every piece; the storage node refuses bytes that don't match |
| Metadata consistency | Every change goes to 3 replicas with a monotonic revision; committed when 2 acknowledge; stale revisions rejected |
| Manager recovery | On startup the manager rebuilds all metadata from a majority of replicas (newest revision wins) |
| Node failures | HTTP heartbeats every 250 ms: Online → Missed heartbeats → Declared dead after a configurable timeout |
| Network partitions | All manager traffic goes through one network layer that can drop a rack's traffic; cut-off nodes are never trusted |
| Corruption | Each storage node scrubs its own disk against its sidecars; every read and repair re-verifies against metadata |
| Automatic repair | Priority queue repairs the most at-risk segments first; limited parallelism and a bandwidth throttle protect client traffic |
| Replica inconsistency | A returning node's stale or unreferenced pieces are garbage-collected before it is trusted again |
| Rebalancing | New or nearly empty returning nodes receive a fair share of pieces; everything else stays put |

## Project layout

```
server/
  main.ts              starts the cluster and gateway (npm run cluster)
  manager.ts           control plane: processes, heartbeats, write/read, repair, rebalancing
  gateway.ts           REST API, WebSocket feed, serves the built dashboard
  storageNode.ts       storage node process: piece files, checksum checks, local scrubber
  metaNode.ts          metadata replica process: versioned key-value store on disk
  auth.ts              shared-secret checks for internal node APIs (constant time)
  __tests__/           node, security, and live multi-process integration tests
bench/                 performance benchmarks (npm run bench)
src/
  engine/              shared core used by both server and browser: Reed-Solomon (gf256.ts),
                       placement policy (placement.ts), piece keys, hashing, policies,
                       snapshot types, and the in-browser simulator
  live/remote.ts       dashboard client for the live backend (WebSocket + REST)
  hooks/useVault.ts    picks live or simulator automatically
  components/          React UI
```

## Accessibility

The dashboard targets **WCAG 2.2 AA** and is tested on every `npm test` run: axe-core finds **0 violations** on every page (also in real Chrome, in both themes, on desktop and phone), every text color is verified at **≥ 4.5:1 contrast**, and components are linted with **eslint-plugin-jsx-a11y (strict)**. It includes a skip link, focus management between pages, keyboard-scrollable regions, screen-reader descriptions for charts, and support for Reduce motion, Increase contrast, and Windows High Contrast. Details: [ACCESSIBILITY.md](ACCESSIBILITY.md).

## Security

Hardened for deployment: Helmet security headers with a strict Content Security Policy, a CORS allowlist, WebSocket origin checks, per-client rate limiting, input validation and size limits, an optional API token for every change (constant-time comparison), a switch to disable fault injection, and a random per-cluster token that storage and metadata nodes require from the manager. The production container runs as a non-root user, and `npm audit` finds 0 vulnerabilities in production dependencies. 27 security tests verify these controls. Details: [SECURITY.md](SECURITY.md).

## Performance

Measured with `npm run bench` (Node 22, one CPU core):

| Operation | Throughput |
|---|---|
| Erasure-encode a 512 KB segment (4+2) | ~660 per second (~330 MB/s) |
| Decode a segment after losing 2 data shards | ~500 per second, **1.9x faster** than the previous read path |
| Decode with no losses | ~1,100,000 per second (zero-copy fast path) |
| SHA-256 of a 128 KB piece | ~10,000 per second (~1.2 GB/s) |
| Choose a repair target (30 nodes, 10,000 pieces) | ~3,400 per second, **32x faster** than before |
| Place 6 pieces across 30 nodes | ~28,000 per second |

Efficiency measures in the system:
- **Storage:** erasure coding stores 1.5x the data instead of 3x for the same two-failure tolerance.
- **Reads:** pieces are fetched in parallel; all missing shards of a segment are rebuilt with one matrix inversion, cached per survivor set.
- **Writes:** up to 4 segments are encoded and uploaded in parallel, with every piece of a segment written concurrently.
- **Repair:** reference counts are computed once per scheduling pass instead of inside sort comparisons; repair traffic is bandwidth-throttled so it never starves client reads.
- **Network:** HTTP responses are gzip-compressed (the dashboard's JavaScript shrinks 68%, from 295 KB to 93 KB); WebSocket snapshots are compressed and pushed only when something changed; built assets are cached by browsers for a year.
- **UI:** the dashboard repaints only when the cluster reports a change, at most once per frame budget.

## Deploy to Google Cloud Run

The repository includes a production `Dockerfile` (multi-stage build, production dependencies only, non-root user, health check).

```bash
gcloud run deploy vault \
  --source . \
  --region asia-south1 \
  --allow-unauthenticated \
  --memory 1Gi \
  --max-instances 1 \
  --no-cpu-throttling \
  --session-affinity \
  --set-env-vars VAULT_ENABLE_CHAOS=true
```

`--max-instances 1` keeps the whole cluster in one instance, `--no-cpu-throttling` keeps heartbeats and repairs running between requests, and `--session-affinity` keeps each dashboard's WebSocket on that instance. Cloud Run storage is temporary, so data resets when the instance restarts; this deployment is for demonstration. For a public deployment, also set `VAULT_API_TOKEN`.

## Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request: type check, lint, all tests (including the live multi-process cluster), production build, and a dependency audit.

## What the tests prove (168 tests)

- **Live cluster (real processes):** 12 distinct OS processes; uploads over HTTP return identical bytes; pieces exist as real files whose checksums match metadata; two SIGKILLed nodes don't prevent reads and their data is rebuilt elsewhere; bit rot on a real disk is found by the node's scrubber and rewritten in place; writes pause without metadata quorum while reads continue; a partitioned rack doesn't affect reads; after the entire cluster is stopped and restarted, all metadata is recovered from the replicas and every byte reads back identical.
- **Storage node:** checksum-mismatched writes rejected; data survives process restarts; scrubber detects tampering; deletes remove files and sidecars.
- **Metadata replica:** stale revisions rejected; every acknowledged write persisted.
- **Engine and simulator:** Reed-Solomon recovers from all 15 two-shard losses; rack-aware placement; quorums; concurrent writers; repair priority; partitions; rebalancing.
- **Security:** headers, CORS and WebSocket origins, token enforcement, validation, size limits, rate limiting, node authentication.
- **Accessibility:** axe-core finds 0 WCAG violations on every page; contrast of every color token; keyboard and screen-reader behavior.
- **UI:** fault buttons, node state changes, uploads, policies, chunk maps, verify reads, theme switching, page navigation.

The tests found two real bugs during development, both fixed: placement could put half an object's pieces in one rack, and a restarted node could be trusted before it answered a heartbeat, which left stale files on disk.

## Five-minute demo

1. `npm run dev:live` and open the dashboard. Point out the **Live cluster** badge and show the process list printed in the terminal.
2. Upload a real file and open its chunk map. Optionally show its pieces in `.vault-data/`.
3. **Crash node**: the process is killed. Watch it go amber, then red, then watch repair traffic until "Fully protected" returns.
4. **Inject bit rot**: a real file on disk is corrupted. The node's scrubber catches it and the piece is rewritten.
5. **Download** the file and show it is bit-for-bit identical.
6. Crash two metadata replicas: writes pause safely, reads continue. Restart one: writes resume.
7. Stop the whole cluster with Ctrl+C, start it again, and show every object is still there.
8. Finish on the storage overhead panel.

## Troubleshooting

| Problem | Fix |
|---|---|
| `EADDRINUSE` on startup | Another program uses the port. Run `lsof -i :7070` to see it, or start with `VAULT_PORT=7171 npm run dev:live` |
| Red squiggles like "Cannot find name 'process'" in VS Code | Editor-only. Run `npm install`, then in VS Code: Cmd/Ctrl+Shift+P → "TypeScript: Restart TS Server" |
| Old node processes still running after a crash | macOS/Linux: `pkill -f storageNode.ts; pkill -f metaNode.ts` |
| Dashboard says "Simulator" | The backend isn't running or isn't reachable. Check the `[cluster]` lines in the terminal |

## Limits worth knowing

All processes run on one machine and talk over localhost, so a partition is simulated in the manager's network layer rather than with firewall rules. The manager is a single coordinator: if it crashes, reads and writes stop until it restarts, but no committed data is lost because it rebuilds its state from the metadata replicas. The natural next steps are running nodes on separate machines or containers and replicating the manager itself.