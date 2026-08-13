// Local-account auth provider — OIDC-shaped interface so Entra/Google can drop
// in later without touching call sites. M1: bcrypt + cookie sessions + rate
// limit / lockout. No email verification (no SMTP); documented gap in
// docs/design/security.md §8.
//
// Interface (docs/design/security.md §3):
//   register({email, password, name}) -> { user, sid }
//   login({email, password})          -> { user, sid }
//   logout(req)                        -> void          (clears auth_sessions row)
//   currentUser(req)                   -> User | null   (reads tt_sid cookie)
//
// The HTTP handler (server/index.js) sets / clears the `tt_sid` cookie using
// the returned `sid`; the provider itself never touches res. This keeps the
// provider reusable outside HTTP (e.g. WS-driven flows) and matches the
// OIDC provider shape we will swap in for Entra.

import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { stmts as dbStmts, tx } from '../db.js';

const BCRYPT_ROUNDS = 12;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days (cookie max-age=604800)
const LOGIN_FAIL_MAX = 10;
const LOGIN_FAIL_WINDOW_MS = 10 * 60 * 1000;   // 10-min sliding window
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;       // 15-min lockout on hit
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Failed-login tracker: ip -> { count, firstAt, lockedUntil }.
 * Swept every 5 min (evict entries outside the lockout window). M2 moves this
 * to SQLite/Redis if we go multi-process.
 * @type {Map<string, {count: number, firstAt: number, lockedUntil: number|null}>}
 */
const loginFails = new Map();
let sweepTimer = null;

function ensureSweep() {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [ip, rec] of loginFails) {
      const windowEnd = rec.firstAt + LOGIN_FAIL_WINDOW_MS;
      const lockEnd = rec.lockedUntil ?? 0;
      if (windowEnd < now && lockEnd < now) loginFails.delete(ip);
    }
  }, SWEEP_INTERVAL_MS);
  if (sweepTimer.unref) sweepTimer.unref();
}

/** Read client IP from x-forwarded-for (first hop) or the raw socket. */
export function clientIp(req) {
  const xff = req?.headers?.['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    return xff.split(',')[0].trim();
  }
  return req?.socket?.remoteAddress || req?.connection?.remoteAddress || 'unknown';
}

/** True if `ip` is currently in a failed-login lockout window. */
export function isLoginLocked(ip) {
  const rec = loginFails.get(ip);
  if (!rec) return false;
  return rec.lockedUntil != null && rec.lockedUntil > Date.now();
}

/** Record a failed login attempt; triggers a 15-min lockout at 10 fails. */
function noteFail(ip) {
  ensureSweep();
  const now = Date.now();
  let rec = loginFails.get(ip);
  if (!rec) {
    rec = { count: 0, firstAt: now, lockedUntil: null };
    loginFails.set(ip, rec);
  }
  // Reset the window if the prior window has fully elapsed.
  if (rec.firstAt + LOGIN_FAIL_WINDOW_MS < now) {
    rec.count = 0;
    rec.firstAt = now;
    rec.lockedUntil = null;
  }
  rec.count += 1;
  if (rec.count >= LOGIN_FAIL_MAX && rec.lockedUntil == null) {
    rec.lockedUntil = now + LOGIN_LOCKOUT_MS;
  }
}

/** Clear failed-login state for `ip` on a successful login. */
function clearFails(ip) {
  loginFails.delete(ip);
}

/** Test-only: reset the entire failed-login map. */
export function __resetLockout() {
  loginFails.clear();
}

// ---------------------------------------------------------------------------
// Cookie helpers (the HTTP handler owns the actual Set-Cookie header; these
// build the cookie string + parse inbound cookies).

export const COOKIE_NAME = 'tt_sid';
export const COOKIE_MAX_AGE = 604800;

function baseUrlHttps() {
  return String(process.env.BASE_URL || '').startsWith('https');
}

/** Build the Set-Cookie value for a session id. */
export function sessionCookieValue(sid) {
  const parts = [
    `${COOKIE_NAME}=${sid}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${COOKIE_MAX_AGE}`,
  ];
  if (baseUrlHttps()) parts.push('Secure');
  return parts.join('; ');
}

/** Build a Set-Cookie value that clears the session cookie. */
export function clearCookieValue() {
  const parts = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (baseUrlHttps()) parts.push('Secure');
  return parts.join('; ');
}

/**
 * Parse the Cookie header into a plain object. Returns {} when absent.
 * @param {import('node:http').IncomingMessage} req
 */
export function readCookies(req) {
  const header = req?.headers?.cookie;
  if (!header) return {};
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Password policy + validation

/**
 * Password policy (security §3): >=10 chars, >=1 letter, >=1 digit. No max
 * (passphrase-friendly).
 * @param {string} pw
 */
export function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return false;
  if (!/[A-Za-z]/.test(pw)) return false;
  if (!/[0-9]/.test(pw)) return false;
  return true;
}

/** Validate an email shape (loose — no SMTP verification in M1). */
export function validateEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Build a typed auth error carrying a `code` the HTTP handler maps to a
 * status. Using Object.assign gives the error a `code: string` type so tsc
 * can narrow on it in the catch block without `any` casts.
 * @param {string} message
 * @param {string} code
 * @returns {Error & { code: string }}
 */
function authError(message, code) {
  return Object.assign(new Error(message), { code });
}

// ---------------------------------------------------------------------------
// Provider

/**
 * @typedef {Object} User
 * @property {string} id
 * @property {string} email
 * @property {string} name
 */

/**
 * Local bcrypt-backed auth provider. OIDC-shaped: register/login return the
 * user + a session id (`sid`); the HTTP handler sets the `tt_sid` cookie.
 */
export const AuthProvider = {
  /**
   * Register a new local account.
   * @param {{email: string, password: string, name?: string}} creds
   * @returns {Promise<{ user: User, sid: string }>}
   * @throws {Error} on duplicate email, weak password, bad email, or lockout.
   */
  async register({ email, password, name }) {
    // Lockout is a login-failure mechanism; register is rate-limited by the
    // guard layer (POST /api/auth/register shares the auth bucket).
    if (!validateEmail(email)) {
      throw authError('A valid email is required.', 'BAD_EMAIL');
    }
    if (!validatePassword(password)) {
      throw authError('Password must be at least 10 characters with a letter and a digit.', 'WEAK_PASSWORD');
    }
    const passhash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const id = randomUUID();
    const userRow = { id, email, name: name || null, passhash, created_at: Date.now() };
    try {
      tx(() => dbStmts.insertUser.run(userRow));
    } catch (err) {
      if (String(err?.message || '').includes('UNIQUE')) {
        throw authError('An account with that email already exists.', 'EMAIL_TAKEN');
      }
      throw err;
    }
    const sid = await issueSession(id);
    return { user: publicUser(userRow), sid };
  },

  /**
   * Log in with email + password.
   * @param {{email: string, password: string}} creds
   * @param {{ ip?: string }} [ctx]
   * @returns {Promise<{ user: User, sid: string }>}
   * @throws {Error} on bad credentials or lockout.
   */
  async login({ email, password }, ctx = {}) {
    const ip = ctx.ip || 'login';
    if (isLoginLocked(ip)) {
      throw authError('Too many failed login attempts. Try again in 15 minutes.', 'LOGIN_LOCKED');
    }
    const row = dbStmts.findUserByEmail.get(email);
    if (!row || !(await bcrypt.compare(password, row.passhash))) {
      noteFail(ip);
      throw authError('Invalid email or password.', 'BAD_CREDENTIALS');
    }
    clearFails(ip);
    const sid = await issueSession(row.id);
    return { user: publicUser(row), sid };
  },

  /**
   * Log out: delete the auth_sessions row for the `tt_sid` cookie on req.
   * No-op (returns false) when there is no session.
   * @param {import('node:http').IncomingMessage} req
   * @returns {boolean}
   */
  logout(req) {
    const sid = readCookies(req)?.[COOKIE_NAME];
    if (!sid) return false;
    try {
      tx(() => dbStmts.deleteAuthSession.run(sid));
    } catch { /* non-fatal */ }
    return true;
  },

  /**
   * Resolve the authenticated user for an inbound request, or null.
   * @param {import('node:http').IncomingMessage} req
   * @returns {User | null}
   */
  currentUser(req) {
    const sid = readCookies(req)?.[COOKIE_NAME];
    if (!sid) return null;
    let sessionRow;
    try {
      sessionRow = dbStmts.findAuthSession.get(sid);
    } catch { return null; }
    if (!sessionRow) return null;
    if (sessionRow.expires_at && sessionRow.expires_at < Date.now()) return null;
    const userRow = dbStmts.findUserById.get(sessionRow.user_id);
    if (!userRow) return null;
    return publicUser(userRow);
  },
};

// ---------------------------------------------------------------------------
// Internals

/** Create an auth_sessions row + return its sid. */
async function issueSession(userId) {
  // Rotate on login: any pre-existing sid for this user is left to expire; a
  // fresh sid is minted each call. Cookie max-age is short-circuited by the
  // row's expires_at.
  const sid = randomUUID();
  const now = Date.now();
  tx(() => dbStmts.insertAuthSession.run({
    sid, user_id: userId, created_at: now, expires_at: now + SESSION_TTL_MS,
  }));
  return sid;
}

/** Strip the passhash before returning a user to the caller. */
function publicUser(row) {
  return { id: row.id, email: row.email, name: row.name };
}
