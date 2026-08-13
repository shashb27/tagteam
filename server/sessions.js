// In-memory session store: sessions, participants, invites, transcript,
// broadcast. State shape follows docs/design/architecture.md §5 exactly.

import { randomUUID } from 'node:crypto';
import {
  MAX_GUESTS, MAX_SESSIONS, PORT, BASE_URL,
  INVITE_TTL_MINUTES_DEFAULT, INVITE_TTL_MINUTES_MAX,
  SESSION_GC_IDLE_MS, SESSION_SWEEP_INTERVAL_MS,
} from './config.js';
import { V, sendFrame } from './protocol.js';

/** @type {Map<string, Session>} sessionId -> Session */
export const sessions = new Map();

/** Invite token -> sessionId (so a WS join can find the session by token). */
export const inviteIndex = new Map();

/**
 * @typedef {Object} Participant
 * @property {string} id
 * @property {string} name
 * @property {'host'|'guest'} role
 * @property {boolean} canSend
 * @property {'active'|'kicked'} status
 * @property {boolean} connected
 * @property {Set<any>} sockets
 * @property {string} resumeKey
 * @property {number} joinedAt
 */

/**
 * @typedef {Object} Invite
 * @property {string} token
 * @property {number} createdAt
 * @property {number} expiresAt
 * @property {string|null} usedBy
 * @property {boolean} revoked
 */

/**
 * @typedef {Object} Session
 * @property {string} id
 * @property {string} hostKey
 * @property {number} createdAt
 * @property {number} lastActivityAt
 * @property {string} baseUrl
 * @property {Map<string, Participant>} participants
 * @property {Map<string, Invite>} invites
 * @property {any[]} transcript
 * @property {number} nextSeq
 * @property {any[]} pendingUserMessages
 * @property {any|null} activeRun
 * @property {any} agent
 * @property {string[]} rosterNotes
 */

// ---------------------------------------------------------------------------
// Creation

export function canCreateSession() {
  return sessions.size < MAX_SESSIONS;
}

/**
 * @param {string} hostHeader
 * @returns {Session}
 */
export function createSession(hostHeader) {
  const id = randomUUID();
  const session = {
    id,
    hostKey: randomUUID(),
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    baseUrl: BASE_URL || (hostHeader ? `http://${hostHeader}` : `http://localhost:${PORT}`),

    participants: new Map(),   // participantId -> Participant
    invites: new Map(),        // inviteToken   -> Invite

    transcript: [],            // Message[], append-only, ordered by seq
    nextSeq: 1,

    // Turn engine (see turns.js)
    pendingUserMessages: [],
    activeRun: null,

    agent: null,               // AgentSession, created lazily on first run
    rosterNotes: [],           // strings consumed by composeUserTurn (§8.5)
  };
  sessions.set(id, session);
  return session;
}

/**
 * @param {string} id
 * @returns {Session | undefined}
 */
export function getSession(id) {
  return sessions.get(id);
}

/**
 * @param {Session} session
 */
export function touch(session) {
  session.lastActivityAt = Date.now();
}

// ---------------------------------------------------------------------------
// Participants

/**
 * Sanitize a display name: trim, strip control chars, strip square brackets
 * (so a name can never spoof the "[Name]:" attribution format the assistant sees),
 * clamp to 40 chars. Returns null when invalid.
 */
export function sanitizeName(raw) {
  if (typeof raw !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  let name = raw.replace(/[\u0000-\u001f\u007f]/g, '').replace(/[[\]]/g, '').trim();
  if (name.length === 0) return null;
  if (name.length > 40) name = name.slice(0, 40).trim();
  return name.length > 0 ? name : null;
}

export function createParticipant(session, { name, role }) {
  const participant = {
    id: randomUUID(),
    name,
    role,                       // "host" | "guest"
    canSend: true,
    status: 'active',           // "active" | "kicked"
    connected: false,
    sockets: new Set(),
    resumeKey: randomUUID(),
    joinedAt: Date.now(),
  };
  session.participants.set(participant.id, participant);
  return participant;
}

export function hostParticipant(session) {
  for (const p of session.participants.values()) {
    if (p.role === 'host') return p;
  }
  return null;
}

export function activeGuestCount(session) {
  let n = 0;
  for (const p of session.participants.values()) {
    if (p.role === 'guest' && p.status !== 'kicked') n += 1;
  }
  return n;
}

export function sessionIsFull(session) {
  return activeGuestCount(session) >= MAX_GUESTS;
}

// ---------------------------------------------------------------------------
// Invites

export function createInvite(session, ttlMinutesRaw) {
  let ttl = Number(ttlMinutesRaw);
  if (!Number.isFinite(ttl)) ttl = INVITE_TTL_MINUTES_DEFAULT;
  ttl = Math.max(1, Math.min(INVITE_TTL_MINUTES_MAX, Math.floor(ttl)));
  const now = Date.now();
  const invite = {
    token: randomUUID(),
    createdAt: now,
    expiresAt: now + ttl * 60_000,
    usedBy: null,
    revoked: false,
  };
  session.invites.set(invite.token, invite);
  inviteIndex.set(invite.token, session.id);
  return invite;
}

/**
 * Validate an invite token for joining. Does NOT burn the token (caller burns
 * it after the participant is created, still synchronously — no await between
 * validation and burn). Returns { ok, code?, session?, invite? }.
 */
export function checkInvite(token) {
  if (typeof token !== 'string' || token.length === 0) return { ok: false, code: 'INVALID_TOKEN' };
  const sessionId = inviteIndex.get(token);
  const session = sessionId ? sessions.get(sessionId) : undefined;
  const invite = session ? session.invites.get(token) : undefined;
  if (!session || !invite) return { ok: false, code: 'INVALID_TOKEN' };
  if (invite.revoked) return { ok: false, code: 'TOKEN_REVOKED' };
  if (invite.usedBy !== null) return { ok: false, code: 'TOKEN_USED' };
  if (Date.now() >= invite.expiresAt) return { ok: false, code: 'TOKEN_EXPIRED' };
  if (sessionIsFull(session)) return { ok: false, code: 'SESSION_FULL' };
  return { ok: true, session, invite };
}

// ---------------------------------------------------------------------------
// Transcript

export function appendMessage(session, partial) {
  const message = {
    id: randomUUID(),
    seq: session.nextSeq++,
    role: partial.role,
    authorId: partial.authorId,
    authorName: partial.authorName,
    text: partial.text ?? '',
    ts: Date.now(),
    streaming: partial.streaming ?? false,
    toolEvents: partial.toolEvents ?? [],
  };
  session.transcript.push(message);
  return message;
}

export function appendSystemMessage(session, text) {
  return appendMessage(session, {
    role: 'system', authorId: 'system', authorName: 'System', text,
  });
}

// ---------------------------------------------------------------------------
// Serialization (strip server-only fields)

export function serializeParticipant(p) {
  return {
    id: p.id,
    name: p.name,
    role: p.role,
    canSend: p.canSend,
    connected: p.connected,
    status: p.status,
  };
}

export function serializeMessage(m) {
  return {
    id: m.id,
    seq: m.seq,
    role: m.role,
    authorId: m.authorId,
    authorName: m.authorName,
    text: m.text,
    ts: m.ts,
    streaming: m.streaming,
    toolEvents: m.toolEvents,
  };
}

export function buildSnapshot(session) {
  return {
    id: session.id,
    participants: [...session.participants.values()].map(serializeParticipant),
    transcript: session.transcript.map(serializeMessage),
  };
}

// ---------------------------------------------------------------------------
// Fanout

/** Broadcast a frame to every socket in the session (optionally excluding). */
export function broadcast(session, frame, { excludeSocket = null, excludeParticipantId = null } = {}) {
  const json = JSON.stringify({ v: V, ...frame });
  for (const p of session.participants.values()) {
    if (excludeParticipantId && p.id === excludeParticipantId) continue;
    for (const socket of p.sockets) {
      if (socket === excludeSocket) continue;
      if (socket.readyState === 1) {
        try { socket.send(json); } catch { try { socket.terminate(); } catch { /* */ } }
      }
    }
  }
}

/** Send a frame to every socket of one participant. */
export function sendToParticipant(participant, frame) {
  for (const socket of participant.sockets) {
    sendFrame(socket, { v: V, ...frame });
  }
}

// ---------------------------------------------------------------------------
// Garbage collection

function anySocketConnected(session) {
  for (const p of session.participants.values()) {
    if (p.sockets.size > 0) return true;
  }
  return false;
}

export function destroySession(session, reason = 'expired') {
  // Abort any in-flight assistant run.
  if (session.activeRun?.abortController) {
    try { session.activeRun.abortController.abort(); } catch { /* */ }
  }
  if (session.agent) {
    try { session.agent.dispose(); } catch { /* */ }
    session.agent = null;
  }
  broadcast(session, { type: 'session_closed', reason });
  for (const p of session.participants.values()) {
    for (const socket of p.sockets) {
      try { socket.close(4000); } catch { /* */ }
    }
    p.sockets.clear();
    p.connected = false;
  }
  for (const token of session.invites.keys()) inviteIndex.delete(token);
  sessions.delete(session.id);
}

export function startSweeper() {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const session of [...sessions.values()]) {
      // Drop expired, unused invites to bound memory.
      for (const [token, inv] of session.invites) {
        if (inv.usedBy === null && now >= inv.expiresAt) {
          session.invites.delete(token);
          inviteIndex.delete(token);
        }
      }
      if (!anySocketConnected(session) && now - session.lastActivityAt > SESSION_GC_IDLE_MS) {
        console.log(`[gc] destroying idle session ${session.id}`);
        destroySession(session, 'expired');
      }
    }
  }, SESSION_SWEEP_INTERVAL_MS);
  timer.unref();
  return timer;
}
