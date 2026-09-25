# Vault: fault-tolerant distributed object storage

Vault stores, replicates, verifies, and repairs objects across independently failing storage nodes. It runs as a **real multi-process cluster on Node.js** (every storage node and metadata replica is its own OS process with its own files on disk), and ships with a live **Mission Control** dashboard for injecting faults and watching the cluster heal itself.

## Quick start

Requires Node.js 20.6 or newer.

```bash
npm install
npm run dev:live      # starts the cluster AND the dashboard -> open http://localhost:5173
```

Other ways to run it:

```bash
npm run cluster          # backend only (API on http://localhost:7000), keeps data between runs
npm run cluster:fresh    # backend with a wiped data directory
npm start                # build the dashboard, then serve everything from http://localhost:7000
npm run dev              # dashboard only; with no backend it falls back to the in-browser simulator
npm test                 # all 93 tests (engine, UI, storage node, metadata, live cluster)
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
| Live updates | WebSocket (`ws`) |
| Process supervision | `child_process.fork`: each node is a separate OS process |
| Storage | Plain files on disk, written atomically (temp file + rename), with SHA-256 sidecars |
| Checksums | SHA-256 (`node:crypto` on the server, Web Crypto in the browser) |
| Erasure coding | Reed-Solomon over GF(2⁸), Cauchy matrix, written from scratch and shared by server and browser |
| Frontend | React 19, Vite 7, plain CSS with light/dark themes |
| Tests | Vitest, React Testing Library, jsdom, real multi-process integration tests |

## REST API

```bash
# upload with a durability policy: rep3, rep2, or ec42
curl -X PUT --data-binary @photo.jpg "http://localhost:7000/api/objects/photo.jpg?policy=ec42"

# download (verified end to end; header x-vault-sha256 carries the checksum)
curl http://localhost:7000/api/objects/photo.jpg -o photo-back.jpg

curl http://localhost:7000/api/objects                    # list
curl -X DELETE http://localhost:7000/api/objects/photo.jpg
curl -X POST http://localhost:7000/api/verify/photo.jpg   # read + verify report
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
  __tests__/           unit tests for both node types + live multi-process integration tests
src/
  engine/              shared core: Reed-Solomon, hashing, policies, snapshot types,
                       and the in-browser simulator used when no backend is running
  live/remote.ts       dashboard client for the live backend (WebSocket + REST)
  hooks/useVault.ts    picks live or simulator automatically
  components/          React UI
```

## What the tests prove (93 tests)

- **Live cluster (real processes):** 12 distinct OS processes; uploads over HTTP return identical bytes; pieces exist as real files whose checksums match metadata; two SIGKILLed nodes don't prevent reads and their data is rebuilt elsewhere; bit rot on a real disk is found by the node's scrubber and rewritten in place; writes pause without metadata quorum while reads continue; a partitioned rack doesn't affect reads; after the entire cluster is stopped and restarted, all metadata is recovered from the replicas and every byte reads back identical.
- **Storage node:** checksum-mismatched writes rejected; data survives process restarts; scrubber detects tampering; deletes remove files and sidecars.
- **Metadata replica:** stale revisions rejected; every acknowledged write persisted.
- **Engine and simulator:** Reed-Solomon recovers from all 15 two-shard losses; rack-aware placement; quorums; concurrent writers; repair priority; partitions; rebalancing.
- **UI:** fault buttons, node state changes, uploads, policies, chunk maps, verify reads, theme switching.

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

## Limits worth knowing

All processes run on one machine and talk over localhost, so a partition is simulated in the manager's network layer rather than with firewall rules. The manager is a single coordinator: if it crashes, reads and writes stop until it restarts, but no committed data is lost because it rebuilds its state from the metadata replicas. The natural next steps are running nodes on separate machines or containers and replicating the manager itself.
