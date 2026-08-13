import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  rateLimit, checkOrigin, checkCsrf, ensureCsrfCookie,
  enforceCaps, CSRF_COOKIE_NAME, CSRF_HEADER,
} from '../../server/guard.js';
import { AuthProvider, __resetLockout } from '../../server/auth/local.js';
import { resetDb } from '../../server/db.js';
import { MAX_SESSIONS } from '../../server/config.js';

beforeEach(() => {
  resetDb();
  __resetLockout();
});

describe('rateLimit (token bucket)', () => {
  it('allows up to `max` requests then blocks the next', () => {
    const ip = '1.1.1.1';
    for (let i = 0; i < 10; i++) {
      expect(rateLimit(ip, 't', 10, 60_000)).toEqual({ ok: true, retryAfter: 0 });
    }
    const r = rateLimit(ip, 't', 10, 60_000);
    expect(r.ok).toBe(false);
    expect(r.retryAfter).toBeGreaterThan(0);
  });

  it('isolates buckets by name', () => {
    const ip = '2.2.2.2';
    for (let i = 0; i < 5; i++) rateLimit(ip, 'a', 5, 60_000);
    expect(rateLimit(ip, 'a', 5, 60_000).ok).toBe(false);
    expect(rateLimit(ip, 'b', 5, 60_000).ok).toBe(true);
  });

  it('isolates buckets by ip', () => {
    for (let i = 0; i < 5; i++) rateLimit('3.3.3.3', 'x', 5, 60_000);
    expect(rateLimit('3.3.3.3', 'x', 5, 60_000).ok).toBe(false);
    expect(rateLimit('3.3.3.4', 'x', 5, 60_000).ok).toBe(true);
  });

  it('refills tokens after the window elapses', () => {
    vi.useFakeTimers();
    try {
      const ip = '4.4.4.4';
      for (let i = 0; i < 5; i++) rateLimit(ip, 'r', 5, 1000);
      expect(rateLimit(ip, 'r', 5, 1000).ok).toBe(false);
      // Full window refill → 5 tokens available again.
      vi.advanceTimersByTime(1000);
      expect(rateLimit(ip, 'r', 5, 1000).ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('checkOrigin', () => {
  it('allows absent Origin (same-origin / non-browser)', () => {
    expect(checkOrigin({ headers: {} })).toBe(true);
  });
  it('allows localhost', () => {
    expect(checkOrigin({ headers: { origin: 'http://localhost:3999' } })).toBe(true);
  });
  it('allows 127.0.0.1', () => {
    expect(checkOrigin({ headers: { origin: 'http://127.0.0.1:3999' } })).toBe(true);
  });
  it('allows 192.168.0.0/16 (CIDR match)', () => {
    expect(checkOrigin({ headers: { origin: 'http://192.168.1.50:3999' } })).toBe(true);
  });
  it('allows 10.0.0.0/8 (CIDR match)', () => {
    expect(checkOrigin({ headers: { origin: 'http://10.20.30.40:3999' } })).toBe(true);
  });
  it('rejects a foreign origin', () => {
    expect(checkOrigin({ headers: { origin: 'http://evil.example.com' } })).toBe(false);
  });
  it('rejects a malformed origin', () => {
    expect(checkOrigin({ headers: { origin: 'not-a-url' } })).toBe(false);
  });
});

describe('CSRF (double-submit)', () => {
  it('checkCsrf passes when cookie == header', () => {
    const req = {
      headers: {
        cookie: `${CSRF_COOKIE_NAME}=token-abc`,
        [CSRF_HEADER]: 'token-abc',
      },
    };
    expect(checkCsrf(req)).toBe(true);
  });
  it('fails on mismatch', () => {
    const req = {
      headers: {
        cookie: `${CSRF_COOKIE_NAME}=token-abc`,
        [CSRF_HEADER]: 'token-xyz',
      },
    };
    expect(checkCsrf(req)).toBe(false);
  });
  it('fails when the header is missing', () => {
    const req = { headers: { cookie: `${CSRF_COOKIE_NAME}=token-abc` } };
    expect(checkCsrf(req)).toBe(false);
  });
  it('fails when the cookie is missing', () => {
    const req = { headers: { [CSRF_HEADER]: 'token-abc' } };
    expect(checkCsrf(req)).toBe(false);
  });

  it('ensureCsrfCookie sets a fresh cookie when absent', () => {
    const res = { headers: {} };
    const setHeader = (k, v) => { res.headers[k] = v; };
    const token = ensureCsrfCookie({ headers: {} }, { setHeader });
    expect(token).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers['Set-Cookie']).toContain(`${CSRF_COOKIE_NAME}=${token}`);
    expect(res.headers['Set-Cookie']).not.toContain('HttpOnly');
  });
  it('ensureCsrfCookie returns the existing cookie without re-setting', () => {
    const res = { headers: {} };
    const setHeader = (k, v) => { res.headers[k] = v; };
    const existing = 'existing-token';
    const req = { headers: { cookie: `${CSRF_COOKIE_NAME}=${existing}` } };
    const token = ensureCsrfCookie(req, { setHeader });
    expect(token).toBe(existing);
    expect(res.headers['Set-Cookie']).toBeUndefined();
  });
});

describe('enforceCaps', () => {
  it('ok when below MAX_SESSIONS and not locked', () => {
    const req = { headers: {}, socket: { remoteAddress: '9.9.9.9' } };
    const r = enforceCaps(req, { sessionsCount: 0 });
    expect(r.ok).toBe(true);
  });
  it('TOO_MANY_SESSIONS at MAX_SESSIONS', () => {
    const req = { headers: {}, socket: { remoteAddress: '9.9.9.9' } };
    const r = enforceCaps(req, { sessionsCount: MAX_SESSIONS });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('TOO_MANY_SESSIONS');
  });
  it('LOGIN_LOCKED when the ip is in a failed-login lockout', async () => {
    await AuthProvider.register({ email: 'cap@example.com', password: 'Password123' });
    const ip = '8.8.8.8';
    for (let i = 0; i < 10; i++) {
      await expect(AuthProvider.login({ email: 'cap@example.com', password: 'bad' }, { ip }))
        .rejects.toMatchObject({ code: 'BAD_CREDENTIALS' });
    }
    const req = { headers: { 'x-forwarded-for': ip } };
    const r = enforceCaps(req, { sessionsCount: 0 });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('LOGIN_LOCKED');
  });
});
