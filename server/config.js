// TagTeam server configuration — env parsing + constants.
// No secret ever leaves this process. The opencode SDK runs an in-process
// server (or talks to an external one via OPENCODE_BASE_URL); no API keys
// are handled here.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PORT = Number.parseInt(process.env.PORT ?? '3000', 10) || 3000;

// Origin used to build invite URLs. Priority: BASE_URL env > Host header
// captured at session creation > http://localhost:<port>.
export const BASE_URL = process.env.BASE_URL || null;

// Force the MOCK backend (canned responses, zero credentials). The demo
// always runs on mock; the real opencode backend is used when this is unset.
export const MOCK_CLAUDE = process.env.MOCK_CLAUDE === '1';

// opencode backend connection.
//   OPENCODE_BASE_URL = null  → spin up an in-process opencode server on a
//                              random free port (createOpencode({ port: 0 })).
//   OPENCODE_BASE_URL = url   → talk to an already-running opencode server.
export const OPENCODE_PORT = Number.parseInt(process.env.OPENCODE_PORT ?? '0', 10) || 0;
export const OPENCODE_BASE_URL = process.env.OPENCODE_BASE_URL || null;

// Model/provider selection. null = use the opencode default (which reads
// the local opencode config / CLI credentials). When OPENCODE_MODEL is set,
// OPENCODE_PROVIDER should also be set (the SDK requires both fields).
export const OPENCODE_MODEL = process.env.OPENCODE_MODEL || null;
export const OPENCODE_PROVIDER = process.env.OPENCODE_PROVIDER || null;

export const WEB_ROOT = path.resolve(__dirname, '..', 'web');
export const DEMO_WORKSPACE_DIR = path.resolve(__dirname, 'demo-workspace');

// ---- Limits & timings (architecture doc §5, §7, §9, §10) ----
export const MAX_SESSIONS = 25;
export const MAX_GUESTS = 2;                       // non-kicked guests per session
export const MAX_MESSAGE_CHARS = 8000;             // user message text
export const MAX_PENDING_MESSAGES = 10;            // pendingUserMessages cap
export const INVITE_TTL_MINUTES_DEFAULT = 30;
export const INVITE_TTL_MINUTES_MAX = 120;
export const RUN_TIMEOUT_MS = 120_000;             // wall clock per assistant run
export const DELTA_FLUSH_BYTES = 256;              // coalescer flush threshold
export const DELTA_FLUSH_MS = 60;                  // coalescer flush timer
export const SESSION_GC_IDLE_MS = 2 * 60 * 60 * 1000; // 2h after last activity
export const SESSION_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
export const WS_MAX_PAYLOAD = 64 * 1024;           // inbound frame cap (8000 chars can be >16KB in UTF-8)
export const WS_PING_INTERVAL_MS = 30_000;         // protocol-level ping
export const WS_PING_MAX_MISSES = 2;
export const FLOOD_WINDOW_MS = 10_000;             // per-connection flood guard
export const FLOOD_MAX_MSGS = 10;
