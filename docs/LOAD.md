# Load test — single-process ceiling

> Informational only (not a merge gate). Run with `node test/load/run.mjs`.

Environment:

- `MOCK_CLAUDE=1 PORT=3990 node server/index.js`
- Node single process, no cluster, no reverse proxy.
- Endpoints: `GET /healthz` (no auth) and `WS /ws` (no auth, expect handshake rejection).

| Scenario | req/s | p50 (ms) | p99 (ms) | max (ms) | errors | total reqs | duration (s) |
|---|---|---|---|---|---|---|---|
| HTTP GET /healthz (c=50, 10s) | 91052.8 | 0.00 | 1.00 | 10.00 | 0 | 910545 | 10.01 |
| WS /ws (c=10, 10s) | 2.0 | 0.00 | 0.00 | 0.00 | 10 | 20 | 10.02 |

Notes:

- HTTP `/healthz` is a trivial in-process JSON endpoint; the number above is the ceiling for the event loop under this single process.
- WS `/ws` without auth is rejected at the handshake; the numbers reflect upgrade/handshake throughput, not chat traffic. Real chat load depends on the Claude provider (mocked here).
- Before scaling horizontally, confirm this ceiling is comfortably above expected peak RPS. Scale by running multiple processes behind a load balancer.
