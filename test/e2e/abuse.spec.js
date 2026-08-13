// TagTeam E2E — abuse guard gate (task 1.18, mock mode).
// Per-IP token bucket: 10 session-creates / min → 429 with Retry-After.
//
// This is an API-level abuse test (per spec: "Use fetch directly, not Playwright
// UI"). We spin up a DEDICATED server on a side port with an in-memory SQLite DB
// so the shared Playwright webServer (used by the UI specs) is not contaminated
// by the 100 session creates, and so the global MAX_SESSIONS=25 cap doesn't
// mask the per-IP rate limit.

import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';

const SIDE_PORT = 4011;
const BASE = `http://localhost:${SIDE_PORT}`;
const SUFFIX = `${Date.now()}@tagteam.test`;
const email = `abuse-${SUFFIX}`;
const PASSWORD = 'Tagteam123!';

// Per-run unique XFF IP. The server's `clientIp` trusts `x-forwarded-for`
// (server/auth/local.js:51). Pinning all 100 requests under one XFF IP makes
// them share a single `ip:session` bucket → the per-IP limit triggers at 10.
const ts = Date.now();
const XFF_IP = `10.${(ts >> 16) & 255}.${(ts >> 8) & 255}.${ts & 255}`;

/** Spawn the TagTeam server on SIDE_PORT with an in-memory DB. */
function startSideServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server/index.js'], {
      env: {
        ...process.env,
        MOCK_CLAUDE: '1',
        PORT: String(SIDE_PORT),
        TAGTEAM_DB_PATH: ':memory:',
        // No BASE_URL → invite URLs fall back to localhost:<port>; irrelevant here.
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    const onLine = (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.includes(`running at http://localhost:${SIDE_PORT}`)) {
          child.stdout.off('data', onLine);
          resolve(child);
          return;
        }
      }
    };
    child.stdout.on('data', onLine);
    child.stderr.on('data', (c) => process.stderr.write(c));
    child.on('error', reject);
    setTimeout(() => reject(new Error('side server boot timeout')), 20000);
  });
}

function stopSideServer(child) {
  try { child.kill('SIGTERM'); } catch { /* ignore */ }
}

/** Tiny cookie jar for fetch (Node 20+ global fetch, no cookie impl built in). */
function cookieJar() {
  const store = new Map();
  return {
    capture(res) {
      const sc = res.headers.getSetCookie?.() ?? [];
      for (const c of sc) {
        const eq = c.indexOf('=');
        if (eq < 0) continue;
        store.set(c.slice(0, eq).trim(), c.slice(eq + 1).split(';')[0].trim());
      }
    },
    header() {
      return [...store.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    get(name) { return store.get(name); },
  };
}

async function ready(child) {
  // Resolve(true) once /healthz returns 200; reject on death/timeout.
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('side server exited early');
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('side server never became healthy');
}

test('abuse guard: 10 session-creates/min per IP then 429 + Retry-After', async () => {
  const child = await startSideServer();
  try {
    await ready(child);
    const jar = cookieJar();

    // 1. GET / → mint a CSRF cookie (ensureCsrfCookie sets tt_csrf on GET).
    const getRes = await fetch(BASE, { headers: { 'X-Forwarded-For': XFF_IP } });
    jar.capture(getRes);
    const csrf = jar.get('tt_csrf');
    expect(csrf).toBeTruthy();

    // 2. Register an account (same shape as the web client's apiPost).
    const regRes = await fetch(`${BASE}/api/auth/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrf,
        'X-Forwarded-For': XFF_IP,
        Cookie: jar.header(),
      },
      body: JSON.stringify({ email, password: PASSWORD, name: 'Abuser' }),
    });
    jar.capture(regRes);
    expect(regRes.status).toBe(201);
    const authedCsrf = jar.get('tt_csrf') || csrf;
    expect(jar.get('tt_sid')).toBeTruthy();

    // 3. Fire 100 POST /api/sessions from the same XFF IP.
    const statuses = [];
    let sawRetryAfter = false;
    for (let i = 0; i < 100; i++) {
      const res = await fetch(`${BASE}/api/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': authedCsrf,
          'X-Forwarded-For': XFF_IP,
          Cookie: jar.header(),
        },
        body: '{}',
      });
      statuses.push(res.status);
      if (res.status === 429) {
        const ra = res.headers.get('retry-after');
        if (ra && Number(ra) > 0) sawRetryAfter = true;
        if (!sawRetryAfter) {
          try {
            const body = await res.json();
            if (body && body.retryAfter && body.retryAfter > 0) sawRetryAfter = true;
          } catch { /* ignore */ }
        }
      }
    }

    // The guard allows 10 creates per 60s window; the 11th onward must be 429.
    const created = statuses.filter((s) => s === 201).length;
    const limited = statuses.filter((s) => s === 429).length;
    expect(created).toBe(10);
    expect(limited).toBe(90);
    expect(sawRetryAfter).toBe(true);
  } finally {
    stopSideServer(child);
  }
});
