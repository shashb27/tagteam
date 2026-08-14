// Abuse guards (security §6): per-IP token bucket, origin allowlist, CSRF
// double-submit, and caps. Pure in-memory (M2: shared store if multi-process).

import { randomUUID } from 'node:crypto';
import { isLoginLocked } from './auth/local.js';
import { MAX_SESSIONS } from './config.js';

// ---------------------------------------------------------------------------
// Origin allowlist

const DEFAULT_ORIGINS = 'localhost,127.0.0.1,192.168.0.0/16,10.0.0.0/8';
const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || DEFAULT_ORIGINS)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function ipToInt(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const o = Number(p);
    if (!Number.isInteger(o) || o < 0 || o > 255) return null;
    n = (n << 8) + o;
  }
  return n >>> 0;
}

function ipInCidr(ip, cidr) {
  const slash = cidr.indexOf('/');
  const base = slash >= 0 ? cidr.slice(0, slash) : cidr;
  const bits = slash >= 0 ? Number(cidr.slice(slash + 1)) : 32;
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const baseInt = ipToInt(base);
  const ipInt = ipToInt(ip);
  if (baseInt == null || ipInt == null) return false;
  const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

/**
 * Check the request Origin header against the allowlist. True when origin is
 * absent (same-origin / non-browser) or matches an entry (hostname, CIDR, or
 * `*.example.com` wildcard). False otherwise → caller responds 403.
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
export function checkOrigin(req) {
  const origin = req?.headers?.origin;
  if (!origin) return true;
  let host;
  try {
    host = new URL(origin).hostname;
  } catch {
    return false;
  }
  if (!host) return false;
  for (const allowed of ALLOWED_ORIGINS) {
    if (allowed === host) return true;
    if (allowed.includes('/')) {
      if (ipInCidr(host, allowed)) return true;
      continue;
    }
    if (allowed.startsWith('*.')) {
      if (host.endsWith(allowed.slice(1))) return true;
      continue;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Per-IP token bucket

/** @type {Map<string, {tokens: number, last: number}>} ip:bucket -> state */
const buckets = new Map();
let bucketSweepTimer = null;

function ensureBucketSweep() {
  if (bucketSweepTimer) return;
  bucketSweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, b] of buckets) {
      if (now - b.last > 5 * 60 * 1000) buckets.delete(key);
    }
  }, 5 * 60 * 1000);
  if (bucketSweepTimer.unref) bucketSweepTimer.unref();
}

/**
 * Token-bucket rate limit. Refills continuously up to `max` tokens per
 * `windowMs`. Returns `{ok, retryAfter}` (retryAfter in seconds, 0 when ok).
 *
 * @param {string} ip
 * @param {string} bucket — logical bucket name (e.g. 'session', 'msg')
 * @param {number} max — tokens per window
 * @param {number} windowMs — window length in ms
 * @returns {{ok: true, retryAfter: 0} | {ok: false, retryAfter: number}}
 */
export function rateLimit(ip, bucket, max, windowMs) {
  ensureBucketSweep();
  const key = `${ip}:${bucket}`;
  const now = Date.now();
  let b = buckets.get(key);
  if (!b) {
    b = { tokens: max, last: now };
    buckets.set(key, b);
  }
  const refill = ((now - b.last) / windowMs) * max;
  b.tokens = Math.min(max, b.tokens + refill);
  b.last = now;
  if (b.tokens < 1) {
    const need = 1 - b.tokens;
    const retryAfterMs = Math.ceil((need / max) * windowMs);
    return { ok: false, retryAfter: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
  }
  b.tokens -= 1;
  return { ok: true, retryAfter: 0 };
}

// ---------------------------------------------------------------------------
// CSRF (double-submit cookie)

export const CSRF_COOKIE_NAME = 'tt_csrf';
export const CSRF_HEADER = 'x-csrf-token';
const CSRF_MAX_AGE = 7 * 24 * 60 * 60;

function baseUrlHttps() {
  return String(process.env.BASE_URL || '').startsWith('https');
}

function readCookies(req) {
  const header = req?.headers?.cookie;
  if (!header) return {};
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

/** Build the Set-Cookie value for the CSRF token. */
export function csrfCookieValue(token) {
  const parts = [
    `${CSRF_COOKIE_NAME}=${token}`,
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${CSRF_MAX_AGE}`,
    // NOT HttpOnly: the browser JS must read it to send the X-CSRF-Token header.
  ];
  if (baseUrlHttps()) parts.push('Secure');
  return parts.join('; ');
}

/**
 * Ensure the response sets a `tt_csrf` cookie if the request lacks one.
 * Returns the token (existing or newly minted). Idempotent per-request.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {string}
 */
export function ensureCsrfCookie(req, res) {
  const cookies = readCookies(req);
  if (cookies[CSRF_COOKIE_NAME]) return cookies[CSRF_COOKIE_NAME];
  const token = randomUUID();
  res.setHeader('Set-Cookie', csrfCookieValue(token));
  return token;
}

/**
 * Verify the double-submit CSRF token on a state-changing request. True
 * only when the `tt_csrf` cookie equals the `X-CSRF-Token` header.
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
export function checkCsrf(req) {
  const cookies = readCookies(req);
  const cookieToken = cookies[CSRF_COOKIE_NAME];
  const headerToken = req.headers[CSRF_HEADER];
  if (!cookieToken || !headerToken) return false;
  return cookieToken === headerToken;
}

// ---------------------------------------------------------------------------
// Caps

/**
 * Enforce HTTP-level caps on a state-changing request. The per-session caps
 * (2 guests/session) are enforced at the WS join layer (sessionIsFull); this
 * helper covers the request-level caps: total sessions, login lockout.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {{ sessionsCount?: number }} [ctx]
 * @returns {{ ok: true, code: null } | { ok: false, code: string, retryAfter?: number }}
 */
export function enforceCaps(req, ctx = {}) {
  const ip = req?.headers?.['x-forwarded-for']?.toString().split(',')[0].trim()
    || req?.socket?.remoteAddress || 'unknown';
  if (isLoginLocked(ip)) {
    return { ok: false, code: 'LOGIN_LOCKED', retryAfter: 900 };
  }
  if (typeof ctx.sessionsCount === 'number' && ctx.sessionsCount >= MAX_SESSIONS) {
    return { ok: false, code: 'TOO_MANY_SESSIONS' };
  }
  return { ok: true, code: null };
}
