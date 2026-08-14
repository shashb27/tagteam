// In-memory session store: sessions, participants, invites, transcript,
// broadcast. State shape follows docs/design/architecture.md §5 exactly.

import { randomUUID } from 'node:crypto';
import {
  MAX_GUESTS, MAX_SESSIONS, PORT, BASE_URL,
  INVITE_TTL_MINUTES_DEFAULT, INVITE_TTL_MINUTES_MAX,
  SESSION_GC_IDLE_MS, SESSION_SWEEP_INTERVAL_MS,
} from './config.js';
import { V, sendFrame } from './protocol.js';
import { getDb, stmts as dbStmts, tx } from './db.js';
import { redactForGuest, applyHiddenRanges } from './redact.js';

/** @type {Map<string, Session>} sessionId -> Session */
export const sessions = new Map();

/** Invite token -> sessionId (so a WS join can find the session by token). */
export const inviteIndex = new Map();

/**
 * Per-session last DB write of `last_activity_at`, for the debounced touch.
 * @type {Map<string, number>}
 */
const lastTouchWriteAt = new Map();

/** Only persist `touch` at most once per 5s per session (avoid a DB write/frame). */
const TOUCH_DB_WRITE_INTERVAL_MS = 5000;

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
 * @property {string|null} userId
 * @property {Array} hiddenRanges
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
 * @property {string|null} hostUserId
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
 * @param {string|null} [hostUserId] - M1: the authenticated user who owns the session.
 * @returns {Session}
 */
export function createSession(hostHeader, hostUserId = null) {
  const id = randomUUID();
  const session = {
    id,
    hostKey: randomUUID(),
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    baseUrl: BASE_URL || (hostHeader ? `http://${hostHeader}` : `http://localhost:${PORT}`),
    hostUserId,

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
  // Write-through: DB first, then memory. If the insert throws, the session
  // never enters the in-memory Map → no divergence.
  tx(() => {
    dbStmts.insertSession.run({
      id: session.id,
      host_user_id: hostUserId,
      host_key: session.hostKey,
      created_at: session.createdAt,
      last_activity_at: session.lastActivityAt,
      title: null,
    });
    sessions.set(id, session);
  });
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
  const now = session.lastActivityAt;
  const last = lastTouchWriteAt.get(session.id) ?? 0;
  if (now - last >= TOUCH_DB_WRITE_INTERVAL_MS) {
    lastTouchWriteAt.set(session.id, now);
    try {
      tx(() => {
        dbStmts.updateSessionActivity.run(now, session.id);
      });
    } catch { /* non-fatal: memory is still authoritative for the hot path */ }
  }
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

export function createParticipant(session, { name, role, userId = null }) {
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
    userId,                     // M1: bound auth identity (null only if anon, which M1 disallows)
    hiddenRanges: [],           // M1: host-marked guest-hidden transcript ranges
  };
  tx(() => {
    dbStmts.insertParticipant.run({
      id: participant.id,
      session_id: session.id,
      user_id: userId,
      name: participant.name,
      role: participant.role,
      can_send: participant.canSend ? 1 : 0,
      status: participant.status,
      joined_at: participant.joinedAt,
      resume_key: participant.resumeKey,
      hidden_ranges: null,
    });
    session.participants.set(participant.id, participant);
  });
  return participant;
}

/** Persist a participant status/canSend change (used by revoke_guest). */
export function setParticipantStatus(participant, { status, canSend }) {
  tx(() => {
    if (status !== undefined) participant.status = status;
    if (canSend !== undefined) participant.canSend = canSend;
    dbStmts.updateParticipantStatus.run(
      participant.status,
      participant.canSend ? 1 : 0,
      participant.id,
    );
  });
}

/** Persist a participant canSend-only change (used by revoke_guest read_only/restore). */
export function setParticipantCanSend(participant, canSend) {
  tx(() => {
    participant.canSend = canSend;
    dbStmts.updateParticipantCanSend.run(canSend ? 1 : 0, participant.id);
  });
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
  tx(() => {
    dbStmts.insertInvite.run({
      token: invite.token,
      session_id: session.id,
      created_at: invite.createdAt,
      expires_at: invite.expiresAt,
      used_by: null,
      revoked: 0,
    });
    session.invites.set(invite.token, invite);
    inviteIndex.set(invite.token, session.id);
  });
  return invite;
}

/** Burn an invite token — single use, before anything async. Persists used_by. */
export function markInviteUsed(invite, usedBy) {
  tx(() => {
    invite.usedBy = usedBy;
    dbStmts.updateInviteUsed.run(usedBy, invite.token);
  });
}

/** Revoke an invite. Persists the revoked flag. */
export function revokeInvite(invite) {
  tx(() => {
    invite.revoked = true;
    dbStmts.updateInviteRevoked.run(1, invite.token);
  });
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
  tx(() => {
    dbStmts.insertMessage.run({
      id: message.id,
      session_id: session.id,
      seq: message.seq,
      role: message.role,
      author_id: message.authorId,
      author_name: message.authorName,
      text: message.text,
      ts: message.ts,
      streaming: message.streaming ? 1 : 0,
      tool_events_json: JSON.stringify(message.toolEvents ?? []),
    });
    session.transcript.push(message);
  });
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

/**
 * Serialize a message for a specific recipient. Guests get auto-redacted
 * text + host-hidden ranges applied; hosts get the raw text. Used by
 * buildSnapshot (the `joined` payload) and by the per-recipient broadcast.
 *
 * @param {any} m
 * @param {Participant} participant
 * @returns {any}
 */
export function serializeMessageFor(m, participant) {
  const base = serializeMessage(m);
  if (!participant || participant.role !== 'guest') return base;
  const text = base.text ?? '';
  const ranges = (participant.hiddenRanges || []).filter((r) => r.messageId === m.id);
  return { ...base, text: applyHiddenRanges(redactForGuest(text), ranges) };
}

export function buildSnapshot(session, forParticipant = null) {
  const serialize = forParticipant
    ? (m) => serializeMessageFor(m, forParticipant)
    : serializeMessage;
  return {
    id: session.id,
    participants: [...session.participants.values()].map(serializeParticipant),
    transcript: session.transcript.map(serialize),
  };
}

// ---------------------------------------------------------------------------
// Fanout

/**
 * Redact a broadcast frame for a guest recipient: auto-redact any
 * guest-visible text and apply host-hidden ranges by messageId. Frames with
 * no text-bearing fields are returned unchanged. Hosts always get the raw
 * frame (the caller passes the original, not this function's output).
 *
 * This is the M1 redaction hook (security §5): the broadcast serializes
 * per-recipient so a host sees raw `sk-ant-...` while a guest sees
 * `[redacted]`.
 *
 * @param {any} frame
 * @param {Participant} participant
 * @returns {any}
 */
function redactFrameForGuest(frame, participant) {
  const msg = frame.message;
  const sys = frame.systemMessage;
  const hasText =
    (msg && typeof msg.text === 'string' && msg.text !== '') ||
    typeof frame.delta === 'string' ||
    typeof frame.text === 'string' ||
    (sys && typeof sys.text === 'string' && sys.text !== '') ||
    typeof frame.summary === 'string';
  if (!hasText) return frame;

  const f = { ...frame };
  const ranges = participant.hiddenRanges || [];

  if (f.message && typeof f.message.text === 'string') {
    const msgRanges = ranges.filter((r) => r.messageId === f.message.id);
    f.message = {
      ...f.message,
      text: applyHiddenRanges(redactForGuest(f.message.text), msgRanges),
    };
  }
  if (typeof f.text === 'string') {
    // assistant_complete carries `text` + `messageId`.
    const msgRanges = f.messageId
      ? ranges.filter((r) => r.messageId === f.messageId)
      : [];
    f.text = applyHiddenRanges(redactForGuest(f.text), msgRanges);
  }
  if (typeof f.delta === 'string') {
    // Partial delta — auto-redact only (hidden ranges can't apply to a slice).
    f.delta = redactForGuest(f.delta);
  }
  if (f.systemMessage && typeof f.systemMessage.text === 'string') {
    const msgRanges = f.systemMessage.id
      ? ranges.filter((r) => r.messageId === f.systemMessage.id)
      : [];
    f.systemMessage = {
      ...f.systemMessage,
      text: applyHiddenRanges(redactForGuest(f.systemMessage.text), msgRanges),
    };
  }
  if (typeof f.summary === 'string') {
    f.summary = redactForGuest(f.summary);
  }
  return f;
}

/**
 * Broadcast a frame to every socket in the session (optionally excluding).
 * Per-recipient (M1): guests receive auto-redacted + hidden-range-applied
 * text; hosts receive the raw frame. Frames without text are sent verbatim.
 */
export function broadcast(session, frame, { excludeSocket = null, excludeParticipantId = null } = {}) {
  for (const p of session.participants.values()) {
    if (excludeParticipantId && p.id === excludeParticipantId) continue;
    const perFrame = p.role === 'guest' ? redactFrameForGuest(frame, p) : frame;
    const json = JSON.stringify({ v: V, ...perFrame });
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
  lastTouchWriteAt.delete(session.id);
  // Persist the deletion. FK ON DELETE CASCADE removes participants, invites,
  // and messages for this session in the same transaction.
  try {
    tx(() => {
      dbStmts.deleteSession.run(session.id);
    });
  } catch { /* memory already cleared; DB row may linger until next sweep */ }
}

export function startSweeper() {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const session of [...sessions.values()]) {
      // Drop expired, unused invites to bound memory.
      for (const [token, inv] of session.invites) {
        if (inv.usedBy === null && now >= inv.expiresAt) {
          tx(() => {
            session.invites.delete(token);
            inviteIndex.delete(token);
            dbStmts.deleteInvite.run(token);
          });
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

// ---------------------------------------------------------------------------
// Restart-resume: rebuild the in-memory Maps from SQLite on boot.

/**
 * Rebuild the in-memory `sessions`, `inviteIndex` from SQLite. Active sessions
 * (last_activity_at within SESSION_GC_IDLE_MS) come back alive; older sessions
 * stay in the DB only. Transient fields (activeRun, agent, pendingUserMessages,
 * rosterNotes, socket sets, connected flags) are reset — a reconnecting
 * participant reattaches via the `resume` join flow.
 *
 * @returns {{ sessions: number, participants: number, invites: number, messages: number }}
 */
export function loadFromDisk() {
  // Ensure the DB is open + migrated before we read.
  getDb();
  const cutoff = Date.now() - SESSION_GC_IDLE_MS;
  const sessionRows = dbStmts.loadRecentSessions.all(cutoff);

  let nSessions = 0, nParticipants = 0, nInvites = 0, nMessages = 0;

  for (const sr of sessionRows) {
    const session = {
      id: sr.id,
      hostKey: sr.host_key,
      createdAt: sr.created_at,
      lastActivityAt: sr.last_activity_at,
      baseUrl: BASE_URL || `http://localhost:${PORT}`,
      hostUserId: sr.host_user_id,

      participants: new Map(),
      invites: new Map(),
      transcript: [],
      nextSeq: 1,

      pendingUserMessages: [],
      activeRun: null,
      agent: null,
      rosterNotes: [],
    };

    for (const pr of dbStmts.loadParticipants.all(sr.id)) {
      /** @type {Participant} */
      const p = {
        id: pr.id,
        name: pr.name,
        role: pr.role,
        canSend: !!pr.can_send,
        status: pr.status,
        connected: false,
        sockets: new Set(),
        resumeKey: pr.resume_key,
        joinedAt: pr.joined_at,
        userId: pr.user_id,
        hiddenRanges: pr.hidden_ranges ? safeParse(pr.hidden_ranges, []) : [],
      };
      session.participants.set(p.id, p);
      nParticipants++;
    }

    for (const ir of dbStmts.loadInvites.all(sr.id)) {
      const inv = {
        token: ir.token,
        createdAt: ir.created_at,
        expiresAt: ir.expires_at,
        usedBy: ir.used_by,
        revoked: !!ir.revoked,
      };
      session.invites.set(inv.token, inv);
      inviteIndex.set(inv.token, session.id);
      nInvites++;
    }

    let maxSeq = 0;
    for (const mr of dbStmts.loadMessages.all(sr.id)) {
      const m = {
        id: mr.id,
        seq: mr.seq,
        role: mr.role,
        authorId: mr.author_id,
        authorName: mr.author_name,
        text: mr.text,
        ts: mr.ts,
        streaming: !!mr.streaming,
        toolEvents: mr.tool_events_json ? safeParse(mr.tool_events_json, []) : [],
      };
      session.transcript.push(m);
      if (mr.seq > maxSeq) maxSeq = mr.seq;
      nMessages++;
    }
    session.nextSeq = maxSeq + 1;

    sessions.set(session.id, session);
    nSessions++;
  }

  return {
    sessions: nSessions,
    participants: nParticipants,
    invites: nInvites,
    messages: nMessages,
  };
}

/** JSON.parse with a fallback (corrupt rows must never crash boot). */
function safeParse(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}
