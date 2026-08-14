import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  resetDb, migrate, getDb, tx,
  stmts as dbStmts,
} from '../../server/db.js';
import {
  createSession, createParticipant, createInvite,
  appendMessage, loadFromDisk, sessions, inviteIndex,
  markInviteUsed, revokeInvite, destroySession,
} from '../../server/sessions.js';

beforeEach(() => {
  resetDb();
  sessions.clear();
  inviteIndex.clear();
});

describe('db.js', () => {
  it('migrate() is idempotent (run twice, no error)', () => {
    migrate();
    migrate();
    const tables = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => r.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        'users', 'sessions', 'participants', 'invites',
        'messages', 'audit_events', 'auth_sessions',
      ]),
    );
  });

  it('creates all seven tables from architecture §8', () => {
    migrate();
    const tables = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name);
    expect(tables).toHaveLength(7);
  });
});

describe('write-through round-trips', () => {
  it('createSession → getSession round-trip persists the row', () => {
    const s = createSession('host:1');
    const row = dbStmts.getSession.get(s.id);
    expect(row).toBeDefined();
    expect(row.id).toBe(s.id);
    expect(row.host_key).toBe(s.hostKey);
    expect(row.created_at).toBe(s.createdAt);
    expect(row.last_activity_at).toBe(s.lastActivityAt);
  });

  it('appendMessage persists a messages row with the correct seq', () => {
    const s = createSession();
    const p = createParticipant(s, { name: 'H', role: 'host' });
    const m1 = appendMessage(s, {
      role: 'user', authorId: p.id, authorName: 'H', text: 'first',
    });
    const m2 = appendMessage(s, {
      role: 'assistant', authorId: 'assistant', authorName: 'A', text: 'second',
    });
    expect(m1.seq).toBe(1);
    expect(m2.seq).toBe(2);

    const rows = dbStmts.loadMessages.all(s.id);
    expect(rows).toHaveLength(2);
    expect(rows[0].seq).toBe(1);
    expect(rows[0].text).toBe('first');
    expect(rows[1].seq).toBe(2);
    expect(rows[1].text).toBe('second');
    // tool_events_json round-trips as JSON
    expect(JSON.parse(rows[0].tool_events_json)).toEqual([]);
  });

  it('appendMessage stores toolEvents as JSON', () => {
    const s = createSession();
    const m = appendMessage(s, {
      role: 'assistant', authorId: 'a', authorName: 'A', text: '',
      toolEvents: [{ type: 'tool_activity', phase: 'start', name: 'Read' }],
    });
    const rows = dbStmts.loadMessages.all(s.id);
    expect(rows[0].id).toBe(m.id);
    expect(JSON.parse(rows[0].tool_events_json)).toEqual([
      { type: 'tool_activity', phase: 'start', name: 'Read' },
    ]);
  });

  it('createParticipant + createInvite persist rows', () => {
    const s = createSession();
    const p = createParticipant(s, { name: 'H', role: 'host' });
    const inv = createInvite(s, 5);

    const pRows = dbStmts.loadParticipants.all(s.id);
    expect(pRows).toHaveLength(1);
    expect(pRows[0].id).toBe(p.id);
    expect(pRows[0].role).toBe('host');
    expect(pRows[0].can_send).toBe(1);

    const iRows = dbStmts.loadInvites.all(s.id);
    expect(iRows).toHaveLength(1);
    expect(iRows[0].token).toBe(inv.token);
    expect(iRows[0].revoked).toBe(0);
    expect(iRows[0].used_by).toBeNull();
  });

  it('markInviteUsed / revokeInvite persist invite state', () => {
    const s = createSession();
    const inv = createInvite(s, 5);
    markInviteUsed(inv, 'guest-1');
    expect(dbStmts.loadInvites.all(s.id)[0].used_by).toBe('guest-1');

    const inv2 = createInvite(s, 5);
    revokeInvite(inv2);
    expect(dbStmts.loadInvites.all(s.id).find((r) => r.token === inv2.token).revoked)
      .toBe(1);
  });

  it('destroySession cascades participants, invites, messages', () => {
    const s = createSession();
    createParticipant(s, { name: 'H', role: 'host' });
    createInvite(s, 5);
    appendMessage(s, { role: 'user', authorId: 'a', authorName: 'A', text: 'hi' });

    expect(dbStmts.loadParticipants.all(s.id)).toHaveLength(1);
    expect(dbStmts.loadInvites.all(s.id)).toHaveLength(1);
    expect(dbStmts.loadMessages.all(s.id)).toHaveLength(1);

    destroySession(s, 'test');

    expect(dbStmts.getSession.get(s.id)).toBeUndefined();
    expect(dbStmts.loadParticipants.all(s.id)).toHaveLength(0);
    expect(dbStmts.loadInvites.all(s.id)).toHaveLength(0);
    expect(dbStmts.loadMessages.all(s.id)).toHaveLength(0);
  });
});

describe('transaction rollback', () => {
  it('a throw inside tx() rolls back the DB write', () => {
    const id = randomUUID();
    expect(() => tx(() => {
      dbStmts.insertSession.run({
        id, host_user_id: null, host_key: 'k',
        created_at: 1, last_activity_at: 1, title: null,
      });
      throw new Error('boom');
    })).toThrow('boom');
    expect(dbStmts.getSession.get(id)).toBeUndefined();
  });

  it('DB-first ordering prevents memory corruption on a failed write', () => {
    // Pre-seed a row with id 'fixed' directly into the DB.
    dbStmts.insertSession.run({
      id: 'fixed', host_user_id: null, host_key: 'k',
      created_at: 1, last_activity_at: 1, title: null,
    });
    const before = sessions.size;

    // Mimic the sessions.js write-through pattern: DB write first, then the
    // in-memory mutation. A duplicate-PK insert throws, so sessions.set never
    // runs and the in-memory Map is not corrupted.
    expect(() => tx(() => {
      dbStmts.insertSession.run({
        id: 'fixed', host_user_id: null, host_key: 'k2',
        created_at: 2, last_activity_at: 2, title: null,
      });
      sessions.set('fixed', { id: 'fixed', stale: true });
    })).toThrow();
    expect(sessions.has('fixed')).toBe(false);
    expect(sessions.size).toBe(before);
    // The original row is untouched.
    expect(dbStmts.getSession.get('fixed').host_key).toBe('k');
  });
});

describe('loadFromDisk', () => {
  it('rebuilds sessions, participants, invites, transcript from SQLite', () => {
    const s = createSession();
    const host = createParticipant(s, { name: 'H', role: 'host' });
    const guest = createParticipant(s, { name: 'G', role: 'guest' });
    const inv = createInvite(s, 5);
    markInviteUsed(inv, guest.id);
    appendMessage(s, { role: 'user', authorId: host.id, authorName: 'H', text: 'hi' });
    appendMessage(s, { role: 'assistant', authorId: 'a', authorName: 'A', text: 'yo' });

    // Wipe memory as if the process had crashed.
    sessions.clear();
    inviteIndex.clear();
    expect(sessions.size).toBe(0);

    const restored = loadFromDisk();
    expect(restored.sessions).toBe(1);
    expect(restored.participants).toBe(2);
    expect(restored.invites).toBe(1);
    expect(restored.messages).toBe(2);

    const loaded = sessions.get(s.id);
    expect(loaded).toBeDefined();
    expect(loaded.hostKey).toBe(s.hostKey);
    expect(loaded.participants.size).toBe(2);
    expect(loaded.participants.get(host.id).name).toBe('H');
    expect(loaded.participants.get(guest.id).role).toBe('guest');
    expect(loaded.invites.get(inv.token).usedBy).toBe(guest.id);
    expect(inviteIndex.get(inv.token)).toBe(s.id);
    expect(loaded.transcript).toHaveLength(2);
    expect(loaded.transcript[0].text).toBe('hi');
    expect(loaded.transcript[1].text).toBe('yo');
    expect(loaded.transcript[1].toolEvents).toEqual([]);
    // nextSeq continues past the restored transcript.
    expect(loaded.nextSeq).toBe(3);
    // Transient runtime fields are reset.
    expect(loaded.activeRun).toBeNull();
    expect(loaded.agent).toBeNull();
    expect(loaded.pendingUserMessages).toEqual([]);
    // No live sockets on reload.
    for (const p of loaded.participants.values()) {
      expect(p.connected).toBe(false);
      expect(p.sockets.size).toBe(0);
    }
  });

  it('skips sessions idle past SESSION_GC_IDLE_MS', () => {
    const s = createSession();
    // Push last_activity_at far into the past in both memory and DB.
    const old = Date.now() - (3 * 60 * 60 * 1000);
    s.lastActivityAt = old;
    dbStmts.updateSessionActivity.run(old, s.id);

    sessions.clear();
    inviteIndex.clear();
    const restored = loadFromDisk();
    expect(restored.sessions).toBe(0);
    expect(sessions.has(s.id)).toBe(false);
    // The stale row remains in the DB (not loaded, not deleted).
    expect(dbStmts.getSession.get(s.id)).toBeDefined();
  });
});
