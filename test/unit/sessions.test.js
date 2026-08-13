import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  sessions, inviteIndex,
  sanitizeName, createSession, touch, canCreateSession,
  createParticipant, hostParticipant, activeGuestCount, sessionIsFull,
  createInvite, checkInvite,
  appendMessage, appendSystemMessage,
  serializeParticipant, serializeMessage, buildSnapshot,
  sendToParticipant, destroySession, startSweeper,
} from '../../server/sessions.js';
import { resetDb } from '../../server/db.js';
import { INVITE_TTL_MINUTES_MAX, MAX_GUESTS, MAX_SESSIONS, BASE_URL } from '../../server/config.js';

beforeEach(() => {
  resetDb();
  sessions.clear();
  inviteIndex.clear();
});

describe('sanitizeName', () => {
  it('strips control characters', () => {
    expect(sanitizeName('a\u0001b\u007fc')).toBe('abc');
  });
  it('strips square brackets', () => {
    expect(sanitizeName('[Name]')).toBe('Name');
  });
  it('trims whitespace', () => {
    expect(sanitizeName('  Sam  ')).toBe('Sam');
  });
  it('clamps to 40 chars', () => {
    const long = 'x'.repeat(50);
    expect(sanitizeName(long)).toHaveLength(40);
  });
  it('returns null for empty string', () => {
    expect(sanitizeName('')).toBe(null);
  });
  it('returns null for non-string', () => {
    expect(sanitizeName(null)).toBe(null);
    expect(sanitizeName(undefined)).toBe(null);
    expect(sanitizeName(42)).toBe(null);
    expect(sanitizeName({})).toBe(null);
  });
  it('returns null when only brackets/controls remain', () => {
    expect(sanitizeName('[]')).toBe(null);
    expect(sanitizeName('\u0000')).toBe(null);
  });
});

describe('createSession', () => {
  it('sets id, hostKey, createdAt, empty maps, transcript, nextSeq', () => {
    const s = createSession('host:1');
    expect(s.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(s.hostKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof s.createdAt).toBe('number');
    expect(s.participants).toBeInstanceOf(Map);
    expect(s.invites).toBeInstanceOf(Map);
    expect(s.transcript).toEqual([]);
    expect(s.nextSeq).toBe(1);
    expect(s.pendingUserMessages).toEqual([]);
    expect(s.activeRun).toBe(null);
    expect(s.agent).toBe(null);
    expect(s.rosterNotes).toEqual([]);
  });
  it('uses baseUrl from host header when BASE_URL unset', () => {
    const s = createSession('example.com');
    if (BASE_URL) {
      expect(s.baseUrl).toBe(BASE_URL);
    } else {
      expect(s.baseUrl).toContain('example.com');
    }
  });
  it('falls back to http://localhost:<port> when no host header and BASE_URL unset', () => {
    const s = createSession(null);
    if (BASE_URL) {
      expect(s.baseUrl).toBe(BASE_URL);
    } else {
      expect(s.baseUrl).toMatch(/^http:\/\/localhost:\d+$/);
    }
  });
});

describe('participants', () => {
  it('createParticipant sets fields', () => {
    const s = createSession();
    const p = createParticipant(s, { name: 'Sam', role: 'guest' });
    expect(p.name).toBe('Sam');
    expect(p.role).toBe('guest');
    expect(p.status).toBe('active');
    expect(p.connected).toBe(false);
    expect(p.sockets).toBeInstanceOf(Set);
    expect(s.participants.get(p.id)).toBe(p);
  });
  it('hostParticipant returns the host', () => {
    const s = createSession();
    const h = createParticipant(s, { name: 'H', role: 'host' });
    createParticipant(s, { name: 'G', role: 'guest' });
    expect(hostParticipant(s)).toBe(h);
  });
  it('activeGuestCount excludes kicked guests', () => {
    const s = createSession();
    createParticipant(s, { name: 'H', role: 'host' });
    const g1 = createParticipant(s, { name: 'G1', role: 'guest' });
    createParticipant(s, { name: 'G2', role: 'guest' });
    expect(activeGuestCount(s)).toBe(2);
    g1.status = 'kicked';
    expect(activeGuestCount(s)).toBe(1);
  });
  it('sessionIsFull at MAX_GUESTS', () => {
    const s = createSession();
    createParticipant(s, { name: 'H', role: 'host' });
    for (let i = 0; i < MAX_GUESTS; i++) {
      createParticipant(s, { name: `G${i}`, role: 'guest' });
    }
    expect(sessionIsFull(s)).toBe(true);
  });
});

describe('invites', () => {
  it('createInvite clamps TTL to [1, INVITE_TTL_MINUTES_MAX]', () => {
    const s = createSession();
    const a = createInvite(s, 0);
    expect(a.expiresAt - a.createdAt).toBe(60_000);
    const b = createInvite(s, 99999);
    expect(b.expiresAt - b.createdAt).toBe(INVITE_TTL_MINUTES_MAX * 60_000);
    const c = createInvite(s, 5);
    expect(c.expiresAt - c.createdAt).toBe(5 * 60_000);
  });
  it('createInvite defaults non-finite ttl', () => {
    const s = createSession();
    const a = createInvite(s, 'notanumber');
    expect(a.expiresAt).toBeGreaterThan(a.createdAt);
  });
  it('checkInvite: invalid token', () => {
    expect(checkInvite('nope').code).toBe('INVALID_TOKEN');
    expect(checkInvite('').code).toBe('INVALID_TOKEN');
    expect(checkInvite(null).code).toBe('INVALID_TOKEN');
  });
  it('checkInvite: expired → TOKEN_EXPIRED', () => {
    const s = createSession();
    const inv = createInvite(s, 1);
    inv.expiresAt = Date.now() - 1000;
    const r = checkInvite(inv.token);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('TOKEN_EXPIRED');
  });
  it('checkInvite: used → TOKEN_USED', () => {
    const s = createSession();
    const inv = createInvite(s, 5);
    inv.usedBy = 'someone';
    expect(checkInvite(inv.token).code).toBe('TOKEN_USED');
  });
  it('checkInvite: revoked → TOKEN_REVOKED', () => {
    const s = createSession();
    const inv = createInvite(s, 5);
    inv.revoked = true;
    expect(checkInvite(inv.token).code).toBe('TOKEN_REVOKED');
  });
  it('checkInvite: full → SESSION_FULL', () => {
    const s = createSession();
    createParticipant(s, { name: 'H', role: 'host' });
    for (let i = 0; i < MAX_GUESTS; i++) {
      createParticipant(s, { name: `G${i}`, role: 'guest' });
    }
    const inv = createInvite(s, 5);
    expect(checkInvite(inv.token).code).toBe('SESSION_FULL');
  });
  it('checkInvite: valid → ok with session + invite', () => {
    const s = createSession();
    const inv = createInvite(s, 5);
    const r = checkInvite(inv.token);
    expect(r.ok).toBe(true);
    expect(r.session).toBe(s);
    expect(r.invite).toBe(inv);
  });
});

describe('transcript', () => {
  it('appendMessage increments seq', () => {
    const s = createSession();
    const m1 = appendMessage(s, { role: 'user', authorId: 'a', authorName: 'A', text: 'hi' });
    const m2 = appendMessage(s, { role: 'user', authorId: 'a', authorName: 'A', text: 'yo' });
    expect(m1.seq).toBe(1);
    expect(m2.seq).toBe(2);
    expect(s.nextSeq).toBe(3);
    expect(s.transcript).toHaveLength(2);
  });
  it('appendSystemMessage sets role system', () => {
    const s = createSession();
    const m = appendSystemMessage(s, 'someone joined');
    expect(m.role).toBe('system');
    expect(m.authorName).toBe('System');
    expect(m.text).toBe('someone joined');
  });
});

describe('serialization', () => {
  it('serializeParticipant strips server-only fields', () => {
    const s = createSession();
    const p = createParticipant(s, { name: 'Sam', role: 'guest' });
    const o = serializeParticipant(p);
    expect(o).toEqual({
      id: p.id, name: 'Sam', role: 'guest',
      canSend: true, connected: false, status: 'active',
    });
    expect(o).not.toHaveProperty('sockets');
    expect(o).not.toHaveProperty('resumeKey');
  });
  it('serializeMessage strips server-only fields', () => {
    const s = createSession();
    const m = appendMessage(s, { role: 'user', authorId: 'a', authorName: 'A', text: 'hi' });
    const o = serializeMessage(m);
    expect(o.id).toBe(m.id);
    expect(o.seq).toBe(m.seq);
    expect(o.text).toBe('hi');
    expect(o).not.toHaveProperty('ts_raw');
  });
  it('buildSnapshot serializes participants + transcript', () => {
    const s = createSession();
    const p = createParticipant(s, { name: 'Sam', role: 'host' });
    appendMessage(s, { role: 'user', authorId: p.id, authorName: 'Sam', text: 'hi' });
    const snap = buildSnapshot(s);
    expect(snap.id).toBe(s.id);
    expect(snap.participants).toHaveLength(1);
    expect(snap.participants[0].name).toBe('Sam');
    expect(snap.transcript).toHaveLength(1);
    expect(snap.transcript[0].text).toBe('hi');
  });
});

describe('touch', () => {
  it('updates lastActivityAt', () => {
    const s = createSession();
    const old = s.lastActivityAt;
    touch(s);
    expect(s.lastActivityAt).toBeGreaterThanOrEqual(old);
  });
});

describe('canCreateSession', () => {
  it('returns true below MAX_SESSIONS and false at/above the cap', () => {
    sessions.clear();
    for (let i = 0; i < MAX_SESSIONS; i++) createSession();
    expect(canCreateSession()).toBe(false);
    sessions.clear();
    createSession();
    expect(canCreateSession()).toBe(true);
  });
});

describe('hostParticipant', () => {
  it('returns null when there is no host', () => {
    const s = createSession();
    createParticipant(s, { name: 'G', role: 'guest' });
    expect(hostParticipant(s)).toBe(null);
  });
});

describe('sendToParticipant', () => {
  it('sends a frame to every socket of the participant', () => {
    const s = createSession();
    const p = createParticipant(s, { name: 'H', role: 'host' });
    const frames = [];
    const mk = () => ({
      readyState: 1,
      send: (d) => frames.push(JSON.parse(d)),
      close() { this.readyState = 3; },
      terminate() { this.readyState = 3; },
    });
    const a = mk(), b = mk();
    p.sockets.add(a); p.sockets.add(b);
    sendToParticipant(p, { type: 'ping' });
    expect(frames).toHaveLength(2);
    expect(frames[0].type).toBe('ping');
    expect(frames[0].v).toBe(1);
  });
});

describe('destroySession', () => {
  it('closes sockets, clears invites + sessions map, aborts run, disposes agent', () => {
    const s = createSession();
    const p = createParticipant(s, { name: 'H', role: 'host' });
    let closed = 0;
    const socket = {
      readyState: 1,
      send() {}, close() { closed++; this.readyState = 3; },
      terminate() { this.readyState = 3; },
    };
    p.sockets.add(socket);
    p.connected = true;
    const inv = createInvite(s, 5);
    let aborted = false, disposed = false;
    s.activeRun = { abortController: { abort: () => { aborted = true; } } };
    s.agent = { dispose: () => { disposed = true; } };
    destroySession(s, 'test');
    expect(aborted).toBe(true);
    expect(disposed).toBe(true);
    expect(s.agent).toBe(null);
    expect(closed).toBe(1);
    expect(sessions.has(s.id)).toBe(false);
    expect(inviteIndex.has(inv.token)).toBe(false);
    expect(p.connected).toBe(false);
    expect(p.sockets.size).toBe(0);
  });
});

describe('startSweeper', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('drops expired unused invites on sweep', () => {
    sessions.clear();
    inviteIndex.clear();
    const s = createSession();
    const inv = createInvite(s, 1);
    inv.expiresAt = Date.now() - 1000; // expired
    const timer = startSweeper();
    vi.advanceTimersByTime(6 * 60 * 1000);
    expect(s.invites.has(inv.token)).toBe(false);
    expect(inviteIndex.has(inv.token)).toBe(false);
    clearInterval(timer);
  });

  it('destroys idle sessions with no connected sockets past GC idle', async () => {
    sessions.clear();
    inviteIndex.clear();
    vi.useRealTimers(); // need real timers for Date.now consistency
    const s = createSession();
    // make it look long-idle with no sockets
    s.lastActivityAt = Date.now() - (3 * 60 * 60 * 1000);
    expect(sessions.has(s.id)).toBe(true);
    vi.useFakeTimers();
    const timer = startSweeper();
    vi.advanceTimersByTime(6 * 60 * 1000);
    expect(sessions.has(s.id)).toBe(false);
    clearInterval(timer);
    vi.useRealTimers();
  });
});
