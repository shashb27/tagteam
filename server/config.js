// TagTeam server configuration — env parsing + constants.
// No secret ever leaves this process; ANTHROPIC_API_KEY is only read by the
// Anthropic SDK inside server/agent/*.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PORT = Number.parseInt(process.env.PORT ?? '3000', 10) || 3000;

// Origin used to build invite URLs. Priority: BASE_URL env > Host header
// captured at session creation > http://localhost:<port>.
export const BASE_URL = process.env.BASE_URL || null;

// Agent backend selection. "sdk" | "api" | "mock" | unset (auto-probe).
export const TAGTEAM_AGENT = process.env.TAGTEAM_AGENT || null;
export const MOCK_CLAUDE = process.env.MOCK_CLAUDE === '1';

// Model for the Messages API backend (and passed to the Agent SDK when set
// explicitly). Verified current Sonnet id at build time: claude-sonnet-5.
export const MODEL = process.env.TAGTEAM_MODEL || 'claude-sonnet-5';
// Whether TAGTEAM_MODEL was explicitly provided (the Agent SDK otherwise uses
// the local Claude Code default model, which is the safer choice there).
export const MODEL_EXPLICIT = Boolean(process.env.TAGTEAM_MODEL);

export const WEB_ROOT = path.resolve(__dirname, '..', 'web');
export const DEMO_WORKSPACE_DIR = path.resolve(__dirname, 'demo-workspace');

// ---- Limits & timings (architecture doc §5, §7, §9, §10) ----
export const MAX_SESSIONS = 25;
export const MAX_GUESTS = 2;                       // non-kicked guests per session
export const MAX_MESSAGE_CHARS = 8000;             // user message text
export const MAX_PENDING_MESSAGES = 10;            // pendingUserMessages cap
export const INVITE_TTL_MINUTES_DEFAULT = 30;
export const INVITE_TTL_MINUTES_MAX = 120;
export const RUN_TIMEOUT_MS = 120_000;             // wall clock per Claude run
export const DELTA_FLUSH_BYTES = 256;              // coalescer flush threshold
export const DELTA_FLUSH_MS = 60;                  // coalescer flush timer
export const SESSION_GC_IDLE_MS = 2 * 60 * 60 * 1000; // 2h after last activity
export const SESSION_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
export const WS_MAX_PAYLOAD = 64 * 1024;           // inbound frame cap (8000 chars can be >16KB in UTF-8)
export const WS_PING_INTERVAL_MS = 30_000;         // protocol-level ping
export const WS_PING_MAX_MISSES = 2;
export const FLOOD_WINDOW_MS = 10_000;             // per-connection flood guard
export const FLOOD_MAX_MSGS = 10;

export const SDK_SMOKE_TIMEOUT_MS = 20_000;
