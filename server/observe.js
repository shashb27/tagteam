// Observability + audit (security §7): pino logger, audit_events inserts,
// and the /metricsz counters endpoint.
//
// - pino -> logs/tagteam.log (append) + stdout. No pino-roll in M1; rotation
//   is a daily note for ops (a size/time-based rotation can be added later).
// - audit(kind, {sessionId, userId, detail}) inserts into audit_events.
// - /metricsz returns non-authenticated counters only (no per-user data).

import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { stmts as dbStmts, tx } from './db.js';

const LOG_DIR = path.resolve(process.cwd(), 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_PATH = path.join(LOG_DIR, 'tagteam.log');

// pino to file (append) + stdout via multistream. M1: no pino-roll; a daily
// rotation note is left to ops (the file is appended, never truncated here).
const fileStream = fs.createWriteStream(LOG_PATH, { flags: 'a' });
export const log = pino(
  {
    level: process.env.LOG_LEVEL || 'info',
    redact: ['req.headers.authorization', 'req.headers.cookie', '*.passhash'],
  },
  pino.multistream([
    { level: 'info', stream: fileStream },
    { level: 'info', stream: process.stdout },
  ]),
);

// ---------------------------------------------------------------------------
// Audit events

/**
 * Insert an audit_events row + emit an info log. Never throws — a failed
 * audit insert must not break the request path.
 *
 * @param {string} kind — one of: session_create, join, revoke, kick,
 *   login_success, login_fail, error, redaction_triggered, rate_limited.
 * @param {{sessionId?: string, userId?: string, detail?: object}} [ctx]
 */
export function audit(kind, ctx = {}) {
  const { sessionId, userId, detail } = ctx;
  try {
    tx(() => dbStmts.insertAuditEvent.run({
      id: randomUUID(),
      ts: Date.now(),
      session_id: sessionId ?? null,
      user_id: userId ?? null,
      kind,
      detail_json: detail ? JSON.stringify(detail) : null,
    }));
  } catch (err) {
    log.error({ err, kind }, 'audit insert failed');
  }
  log.info({ sessionId, userId, kind, detail: detail ?? undefined }, 'audit');
}

// ---------------------------------------------------------------------------
// /metricsz counters (in-memory; non-authenticated, counters only)

const counters = {
  messagesTotal: 0,
  errorsTotal: 0,
  activeConnections: 0,
  /** @type {Array<{t: number, ms: number}>} trailing 1-min samples */
  runMsSamples: [],
};
const RUN_MS_WINDOW_MS = 60 * 1000;

/** Increment the messagesTotal counter (called on every user_message). */
export function noteMessage() {
  counters.messagesTotal += 1;
}

/** Increment the errorsTotal counter (called on every assistant_error / 500). */
export function noteError() {
  counters.errorsTotal += 1;
}

/** Adjust the active-connections counter (+1 on WS open, -1 on close). */
export function noteConnection(delta) {
  counters.activeConnections += delta;
  if (counters.activeConnections < 0) counters.activeConnections = 0;
}

/** Record a user_message handler duration for the trailing 1-min avgRunMs. */
export function noteRunMs(ms) {
  const now = Date.now();
  counters.runMsSamples.push({ t: now, ms });
  trimRunMs(now);
}

function trimRunMs(now) {
  const cutoff = now - RUN_MS_WINDOW_MS;
  while (counters.runMsSamples.length > 0 && counters.runMsSamples[0].t < cutoff) {
    counters.runMsSamples.shift();
  }
}

/**
 * Build the /metricsz payload. `sessionsCount` is supplied by the caller
 * (the handler reads the live sessions Map size).
 * @param {number} sessionsCount
 */
export function getMetrics(sessionsCount) {
  const now = Date.now();
  trimRunMs(now);
  const samples = counters.runMsSamples;
  const avgRunMs = samples.length === 0
    ? 0
    : Math.round(samples.reduce((s, x) => s + x.ms, 0) / samples.length);
  return {
    sessions: sessionsCount ?? 0,
    activeConnections: counters.activeConnections,
    messagesTotal: counters.messagesTotal,
    errorsTotal: counters.errorsTotal,
    avgRunMs,
  };
}
