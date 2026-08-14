import { describe, it, expect, beforeEach } from 'vitest';
import {
  AuthProvider, validatePassword, validateEmail,
  readCookies, sessionCookieValue, clearCookieValue, COOKIE_NAME,
  isLoginLocked, __resetLockout,
} from '../../server/auth/local.js';
import { resetDb, stmts as dbStmts } from '../../server/db.js';

beforeEach(() => {
  resetDb();
  __resetLockout();
});

describe('validatePassword', () => {
  it('accepts a 10+ char string with a letter and a digit', () => {
    expect(validatePassword('abcdefghij1')).toBe(true);
    expect(validatePassword('Password123')).toBe(true);
  });
  it('rejects <10 chars', () => {
    expect(validatePassword('Ab1')).toBe(false);
    expect(validatePassword('Ab1Ab1Ab9')).toBe(false); // 9 chars
  });
  it('rejects without a letter', () => {
    expect(validatePassword('1234567890')).toBe(false);
  });
  it('rejects without a digit', () => {
    expect(validatePassword('abcdefghij')).toBe(false);
  });
  it('rejects non-strings', () => {
    expect(validatePassword(null)).toBe(false);
    expect(validatePassword(undefined)).toBe(false);
    expect(validatePassword(1234567890)).toBe(false);
  });
});

describe('validateEmail', () => {
  it('accepts a normal email', () => {
    expect(validateEmail('a@b.co')).toBe(true);
    expect(validateEmail('sam@example.com')).toBe(true);
  });
  it('rejects missing @, domain, or TLD', () => {
    expect(validateEmail('noat.com')).toBe(false);
    expect(validateEmail('a@b')).toBe(false);
    expect(validateEmail('a@.com')).toBe(false);
  });
});

describe('AuthProvider.register', () => {
  it('creates a user + auth_session and returns {user, sid}', async () => {
    const { user, sid } = await AuthProvider.register({
      email: 'ava@example.com', password: 'Password123', name: 'Ava',
    });
    expect(user.email).toBe('ava@example.com');
    expect(user.name).toBe('Ava');
    expect(user.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(sid).toMatch(/^[0-9a-f-]{36}$/);
    expect(user).not.toHaveProperty('passhash');

    const row = dbStmts.findUserByEmail.get('ava@example.com');
    expect(row).toBeDefined();
    expect(row.passhash).toMatch(/^\$2[aby]?\$/); // bcrypt
    expect(row.passhash).not.toBe('Password123');

    const sessionRow = dbStmts.findAuthSession.get(sid);
    expect(sessionRow).toBeDefined();
    expect(sessionRow.user_id).toBe(user.id);
    expect(sessionRow.expires_at).toBeGreaterThan(Date.now());
  });

  it('throws EMAIL_TAKEN on a duplicate email', async () => {
    await AuthProvider.register({ email: 'dup@example.com', password: 'Password123' });
    await expect(AuthProvider.register({ email: 'dup@example.com', password: 'Password123' }))
      .rejects.toMatchObject({ code: 'EMAIL_TAKEN' });
  });

  it('throws WEAK_PASSWORD on a short password', async () => {
    await expect(AuthProvider.register({ email: 'w@example.com', password: 'Ab1' }))
      .rejects.toMatchObject({ code: 'WEAK_PASSWORD' });
  });

  it('throws WEAK_PASSWORD when no digit', async () => {
    await expect(AuthProvider.register({ email: 'w@example.com', password: 'NoDigitsHere' }))
      .rejects.toMatchObject({ code: 'WEAK_PASSWORD' });
  });

  it('throws BAD_EMAIL on a malformed email', async () => {
    await expect(AuthProvider.register({ email: 'not-an-email', password: 'Password123' }))
      .rejects.toMatchObject({ code: 'BAD_EMAIL' });
  });
});

describe('AuthProvider.login', () => {
  it('returns {user, sid} on good credentials', async () => {
    await AuthProvider.register({ email: 'sam@example.com', password: 'Password123', name: 'Sam' });
    const { user, sid } = await AuthProvider.login(
      { email: 'sam@example.com', password: 'Password123' },
      { ip: '10.0.0.1' },
    );
    expect(user.email).toBe('sam@example.com');
    expect(sid).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('throws BAD_CREDENTIALS on a wrong password', async () => {
    await AuthProvider.register({ email: 'sam@example.com', password: 'Password123' });
    await expect(AuthProvider.login({ email: 'sam@example.com', password: 'wrong' }, { ip: '10.0.0.2' }))
      .rejects.toMatchObject({ code: 'BAD_CREDENTIALS' });
  });

  it('throws BAD_CREDENTIALS on an unknown email', async () => {
    await expect(AuthProvider.login({ email: 'ghost@example.com', password: 'Password123' }, { ip: '10.0.0.3' }))
      .rejects.toMatchObject({ code: 'BAD_CREDENTIALS' });
  });

  it('locks out after 10 failed attempts from the same IP', async () => {
    await AuthProvider.register({ email: 'lock@example.com', password: 'Password123' });
    const ip = '192.168.1.50';
    for (let i = 0; i < 10; i++) {
      await expect(AuthProvider.login({ email: 'lock@example.com', password: 'bad' }, { ip }))
        .rejects.toMatchObject({ code: 'BAD_CREDENTIALS' });
    }
    expect(isLoginLocked(ip)).toBe(true);
    // 11th attempt — even with correct creds — is rejected while locked.
    await expect(AuthProvider.login({ email: 'lock@example.com', password: 'Password123' }, { ip }))
      .rejects.toMatchObject({ code: 'LOGIN_LOCKED' });
  });

  it('clears the failed-login counter on a successful login', async () => {
    await AuthProvider.register({ email: 'clr@example.com', password: 'Password123' });
    const ip = '192.168.1.51';
    for (let i = 0; i < 5; i++) {
      await expect(AuthProvider.login({ email: 'clr@example.com', password: 'bad' }, { ip }))
        .rejects.toMatchObject({ code: 'BAD_CREDENTIALS' });
    }
    await AuthProvider.login({ email: 'clr@example.com', password: 'Password123' }, { ip });
    // 5 more fails should NOT lock (counter was reset, need 10).
    for (let i = 0; i < 5; i++) {
      await expect(AuthProvider.login({ email: 'clr@example.com', password: 'bad' }, { ip }))
        .rejects.toMatchObject({ code: 'BAD_CREDENTIALS' });
    }
    expect(isLoginLocked(ip)).toBe(false);
  });
});

describe('AuthProvider.currentUser', () => {
  it('returns the user when a valid tt_sid cookie is present', async () => {
    const { user, sid } = await AuthProvider.register({ email: 'u@example.com', password: 'Password123' });
    const req = { headers: { cookie: `${COOKIE_NAME}=${sid}` } };
    expect(AuthProvider.currentUser(req)).toMatchObject({ id: user.id, email: 'u@example.com' });
  });

  it('returns null when no cookie is present', async () => {
    expect(AuthProvider.currentUser({ headers: {} })).toBeNull();
  });

  it('returns null for an unknown sid', async () => {
    const req = { headers: { cookie: `${COOKIE_NAME}=not-a-real-sid` } };
    expect(AuthProvider.currentUser(req)).toBeNull();
  });
});

describe('AuthProvider.logout', () => {
  it('deletes the auth_sessions row for the cookie sid', async () => {
    const { sid } = await AuthProvider.register({ email: 'lo@example.com', password: 'Password123' });
    const req = { headers: { cookie: `${COOKIE_NAME}=${sid}` } };
    expect(dbStmts.findAuthSession.get(sid)).toBeDefined();
    expect(AuthProvider.logout(req)).toBe(true);
    expect(dbStmts.findAuthSession.get(sid)).toBeUndefined();
    expect(AuthProvider.currentUser(req)).toBeNull();
  });

  it('returns false when there is no cookie', () => {
    expect(AuthProvider.logout({ headers: {} })).toBe(false);
  });
});

describe('cookie helpers', () => {
  it('readCookies parses a Cookie header', () => {
    expect(readCookies({ headers: { cookie: 'a=1; b=2' } })).toEqual({ a: '1', b: '2' });
  });
  it('readCookies returns {} when absent', () => {
    expect(readCookies({ headers: {} })).toEqual({});
  });
  it('sessionCookieValue is httpOnly + SameSite=Lax + 7d, not Secure by default', () => {
    const v = sessionCookieValue('abc');
    expect(v).toContain('tt_sid=abc');
    expect(v).toContain('HttpOnly');
    expect(v).toContain('SameSite=Lax');
    expect(v).toContain('Max-Age=604800');
    expect(v).not.toContain('Secure');
  });
  it('clearCookieValue zeros Max-Age', () => {
    expect(clearCookieValue()).toContain('Max-Age=0');
  });
});
