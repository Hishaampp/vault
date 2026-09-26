# Security

## Threat model

Vault stores untrusted files for clients over HTTP and runs internal storage and metadata processes. The main risks are:

| Threat | Mitigation |
|---|---|
| Unauthorized changes (uploads, deletes, settings, fault injection) | Optional bearer token (`VAULT_API_TOKEN`) on every state-changing endpoint, compared in constant time |
| Fault-injection endpoints abused on a public deployment | Disabled entirely with `VAULT_ENABLE_CHAOS=false` (responds 403) |
| Local processes talking to storage nodes directly | Nodes listen on `127.0.0.1` only **and** require a random 256-bit token generated per cluster start, passed through the environment (not the command line, so it never appears in `ps`) |
| Cross-site requests from other websites | CORS allows same-origin only, plus origins listed in `VAULT_CORS_ORIGINS`; WebSocket connections from foreign origins are refused |
| Cross-site scripting, clickjacking, MIME sniffing | Helmet security headers with a strict Content Security Policy (`script-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`), `X-Content-Type-Options: nosniff`, HSTS, `Referrer-Policy: no-referrer` |
| Floods and brute force | Per-client rate limits: 1,200 requests per minute overall and 300 state-changing requests per minute (HTTP 429 beyond that) |
| Oversized or malformed input | Upload size limit (`VAULT_MAX_UPLOAD_MB`, default 64), 16 KB limit on JSON bodies, 1 KB limit on WebSocket messages, validation of object names, policies, and node ids |
| Path traversal | Object names cannot start with `/` or contain `.` or `..` segments, and every piece is stored under a URL-encoded file name, so no name can escape its node's directory |
| Silent data tampering or corruption | Every piece carries a SHA-256 checksum. Nodes refuse writes whose bytes don't match; every read, repair, and background scrub re-verifies |
| Information leaks through errors | Unexpected errors are logged on the server and returned as a generic "Internal server error"; `X-Powered-By` is removed |
| Container escape impact | The production image runs as the unprivileged `node` user, with only the data directory writable |
| Vulnerable dependencies | `npm audit --omit=dev` reports 0 vulnerabilities and runs in CI on every push |

## Verified by tests

`server/__tests__/security.test.ts` (27 tests) checks the headers, CORS and WebSocket origin rules, token enforcement, constant-time comparison, input validation, size limits, rate limiting, the fault-injection switch, and that internal nodes reject unauthenticated requests and bind to localhost only.

## Recommended production settings

```bash
VAULT_API_TOKEN=$(openssl rand -hex 32)   # require a token for changes
VAULT_ENABLE_CHAOS=false                   # no fault injection in production
VAULT_CORS_ORIGINS=https://your-frontend.example   # only if the UI is hosted elsewhere
```

## Reporting a vulnerability

Please open a private security advisory on the GitHub repository rather than a public issue.