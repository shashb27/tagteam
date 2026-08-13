// Load test for the TagTeam server.
// Informational only — finds the single-process ceiling before scaling.
// Runs: HTTP GET /healthz (50 conns, 10s) and WebSocket /ws (10 conns, 10s).
//
// Usage:
//   node test/load/run.mjs
//
// Server is started as a child process with MOCK_CLAUDE=1 PORT=3990.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import autocannon from 'autocannon';

const PORT = 3990;
const BASE = `http://localhost:${PORT}`;

function startServer() {
  const child = spawn('node', ['server/index.js'], {
    env: { ...process.env, MOCK_CLAUDE: '1', PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write(`[srv] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[srv!] ${d}`));
  return child;
}

async function waitForHealth() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) return;
    } catch {}
    await sleep(200);
  }
  throw new Error('server did not become healthy on /healthz within 15s');
}

function summarize(label, r) {
  return {
    label,
    req_per_sec: r.requests.average ? Number(r.requests.average).toFixed(1) : Number(r.requests.sent / r.duration).toFixed(1),
    total_reqs: r.requests.sent,
    p50_ms: r.latency.p50 != null ? Number(r.latency.p50).toFixed(2) : '-',
    p99_ms: r.latency.p99 != null ? Number(r.latency.p99).toFixed(2) : '-',
    max_ms: r.latency.max != null ? Number(r.latency.max).toFixed(2) : '-',
    errors: (r.errors || 0) + (r.non2xx || 0),
    duration_s: Number(r.duration).toFixed(2),
  connections: r.connections,
  ws: !!r.ws,
  raw: r,
  };
}

function printResult(r) {
  if (r.error) {
    console.log(`${r.label}: ERROR ${r.error}`);
    return;
  }
  console.log(
    `${r.label}: ${r.req_per_sec} req/s | p50 ${r.p50_ms} ms | p99 ${r.p99_ms} ms | max ${r.max_ms} ms | errors ${r.errors} | ${r.total_reqs} reqs in ${r.duration_s}s`,
  );
}

async function runHttp() {
  const r = await autocannon({
    url: `${BASE}/healthz`,
    connections: 50,
    duration: 10,
    method: 'GET',
  });
  return summarize('HTTP GET /healthz (c=50, 10s)', r);
}

async function runWs() {
  try {
    const r = await autocannon({
      url: `ws://localhost:${PORT}/ws`,
      connections: 10,
      duration: 10,
      // No auth: connections will be rejected by the server's WS handshake,
      // but this still exercises the upgrade path / accept loop. The number
      // of completed WS frames is expected to be ~0; errors reflect handshakes
      // that the server closed because of missing auth.
      ws: true,
    });
    return summarize('WS /ws (c=10, 10s)', r);
  } catch (e) {
    return { label: 'WS /ws (c=10, 10s)', error: String(e && e.message ? e.message : e) };
  }
}

async function main() {
  const srv = startServer();
  let http, ws;
  try {
    await waitForHealth();
    console.log(`# server healthy on ${BASE}/healthz — starting load tests\n`);
    http = await runHttp();
    printResult(http);
    console.log('');
    ws = await runWs();
    printResult(ws);
  } finally {
    srv.kill('SIGTERM');
    await sleep(500);
    if (!srv.killed) srv.kill('SIGKILL');
  }

  // Write docs/LOAD.md
  const fs = await import('node:fs/promises');
  const lines = [
    '# Load test — single-process ceiling',
    '',
    '> Informational only (not a merge gate). Run with `node test/load/run.mjs`.',
    '',
    'Environment:',
    '',
    '- `MOCK_CLAUDE=1 PORT=3990 node server/index.js`',
    '- Node single process, no cluster, no reverse proxy.',
    '- Endpoints: `GET /healthz` (no auth) and `WS /ws` (no auth, expect handshake rejection).',
    '',
    '| Scenario | req/s | p50 (ms) | p99 (ms) | max (ms) | errors | total reqs | duration (s) |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const r of [http, ws]) {
    if (r.error) {
      lines.push(`| ${r.label} | ERROR: ${r.error} | - | - | - | - | - | - |`);
    } else {
      lines.push(`| ${r.label} | ${r.req_per_sec} | ${r.p50_ms} | ${r.p99_ms} | ${r.max_ms} | ${r.errors} | ${r.total_reqs} | ${r.duration_s} |`);
      }
  }
  lines.push('');
  lines.push('Notes:');
  lines.push('');
  lines.push('- HTTP `/healthz` is a trivial in-process JSON endpoint; the number above is the ceiling for the event loop under this single process.');
  lines.push('- WS `/ws` without auth is rejected at the handshake; the numbers reflect upgrade/handshake throughput, not chat traffic. Real chat load depends on the Claude provider (mocked here).');
  lines.push('- Before scaling horizontally, confirm this ceiling is comfortably above expected peak RPS. Scale by running multiple processes behind a load balancer.');
  lines.push('');
  await fs.writeFile('docs/LOAD.md', lines.join('\n'));
  console.log('\nWrote docs/LOAD.md');
}

main().catch((e) => {
  console.error('load test failed:', e);
  process.exit(1);
});
