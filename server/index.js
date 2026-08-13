// TagTeam server entry point: HTTP (static web/ + /api/sessions + /healthz)
// and the WebSocket endpoint at /ws. Wire protocol:
// docs/design/architecture.md §6 (the contract).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import {
  PORT, WEB_ROOT, WS_MAX_PAYLOAD, WS_PING_INTERVAL_MS, WS_PING_MAX_MISSES,
  MAX_MESSAGE_CHARS, FLOOD_WINDOW_MS, FLOOD_MAX_MSGS,
} from './config.js';
import { sendError, sendFrame, V } from './protocol.js';
import { floodCheck } from './flood.js';
import {
  canCreateSession, createSession, getSession, touch,
  sanitizeName, createParticipant, hostParticipant, checkInvite, createInvite,
  appendMessage, appendSystemMessage,
  serializeParticipant, serializeMessage, buildSnapshot,
  broadcast, sendToParticipant, startSweeper,
  markInviteUsed, revokeInvite,
  setParticipantStatus, setParticipantCanSend,
  loadFromDisk, sessions as sessionsMap,
} from './sessions.js';
import {
  setBackend, backendInfo, flushDeltas, enqueueUserMessage, pendingIsFull,
  noteRosterChange,
} from './turns.js';
import { createAgentBackend } from './agent/index.js';
import { migrate } from './db.js';
import { AuthProvider, clientIp, sessionCookieValue, clearCookieValue } from './auth/index.js';
import {
  checkOrigin, rateLimit, ensureCsrfCookie, checkCsrf, enforceCaps,
  CSRF_COOKIE_NAME,
} from './guard.js';
import { audit, log, noteMessage, noteError, noteConnection, noteRunMs, getMetrics } from './observe.js';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Static files

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES[ext] ?? 'application/octet-stream' });
    res.end(data);
  });
}

/** Resolve a request path inside web/, rejecting traversal. */
function safeWebPath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const resolved = path.normalize(path.join(WEB_ROOT, decoded));
  if (resolved !== WEB_ROOT && !resolved.startsWith(WEB_ROOT + path.sep)) return null;
  return resolved;
}

function serveIndex(res) {
  const indexPath = path.join(WEB_ROOT, 'index.html');
  fs.access(indexPath, (err) => {
    if (err) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>TagTeam</title><p>TagTeam server is running, but <code>web/index.html</code> is not built yet.</p>');
      return;
    }
    serveFile(res, indexPath);
  });
}

// ---------------------------------------------------------------------------
// HTTP surface (architecture doc §3)

// ---------------------------------------------------------------------------
// HTTP surface (architecture doc §3)

/** Read + parse a JSON body, capped at 64 KB. Resolves null on parse error. */
function readJsonBody(req) {
  return new Promise((resolve) => {
    let data = '';
    let aborted = false;
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 65536) { aborted = true; req.destroy(); }
    });
    req.on('end', () => {
      if (aborted) return resolve(null);
      if (data.length === 0) return resolve({});
      try { resolve(JSON.parse(data)); } catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

function sendJson(res, status, obj, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders });
  res.end(JSON.stringify(obj));
}

/** Verify CSRF + origin on state-changing POST /api/*. Returns true on pass. */
function guardPostApi(req, res) {
  if (!checkOrigin(req)) {
    sendJson(res, 403, { error: 'origin_not_allowed' });
    return false;
  }
  if (!checkCsrf(req)) {
    sendJson(res, 403, { error: 'csrf_token_invalid' });
    return false;
  }
  return true;
}

/** Mint a fresh CSRF cookie value (for post-login rotation). */
function freshCsrfCookieValue() {
  const token = randomUUID();
  const secure = String(process.env.BASE_URL || '').startsWith('https');
  const parts = [`${CSRF_COOKIE_NAME}=${token}`, 'Path=/', 'SameSite=Lax', `Max-Age=${7 * 24 * 60 * 60}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

async function handleAuthRoute(req, res, url) {
  const { pathname } = url;
  const ip = clientIp(req);

  if (req.method === 'POST' && pathname === '/api/auth/register') {
    if (!guardPostApi(req, res)) return;
    const body = await readJsonBody(req);
    if (!body || typeof body !== 'object') return sendJson(res, 400, { error: 'bad_body' });
    try {
      const { user, sid } = await AuthProvider.register({
        email: body.email, password: body.password, name: body.name,
      });
      audit('login_success', { userId: user.id, detail: { kind: 'register' } });
      // Rotate CSRF token on login (security §6).
      res.setHeader('Set-Cookie', [sessionCookieValue(sid), freshCsrfCookieValue()]);
      sendJson(res, 201, { user });
    } catch (err) {
      audit('login_fail', { detail: { ip, reason: err.code || 'register_error' } });
      const status = err.code === 'EMAIL_TAKEN' ? 409 : 400;
      sendJson(res, status, { error: err.code || 'register_failed', message: err.message });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/api/auth/login') {
    if (!guardPostApi(req, res)) return;
    const body = await readJsonBody(req);
    if (!body || typeof body !== 'object') return sendJson(res, 400, { error: 'bad_body' });
    try {
      const { user, sid } = await AuthProvider.login(
        { email: body.email, password: body.password },
        { ip },
      );
      audit('login_success', { userId: user.id });
      res.setHeader('Set-Cookie', [sessionCookieValue(sid), freshCsrfCookieValue()]);
      sendJson(res, 200, { user });
    } catch (err) {
      audit('login_fail', { detail: { ip, reason: err.code || 'login_error' } });
      const status = err.code === 'LOGIN_LOCKED' ? 429 : 401;
      const headers = err.code === 'LOGIN_LOCKED' ? { 'Retry-After': '900' } : {};
      sendJson(res, status, { error: err.code || 'login_failed', message: err.message }, headers);
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/api/auth/logout') {
    if (!guardPostApi(req, res)) return;
    req.resume();
    const user = AuthProvider.currentUser(req);
    AuthProvider.logout(req);
    if (user) audit('login_success', { userId: user.id, detail: { kind: 'logout' } });
    res.setHeader('Set-Cookie', clearCookieValue());
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/auth/me') {
    const user = AuthProvider.currentUser(req);
    if (!user) return sendJson(res, 401, { error: 'not_authenticated' });
    sendJson(res, 200, { user });
    return;
  }
}

function handleHttp(req, res) {
  const url = new URL(req.url, 'http://internal');
  const { pathname } = url;

  // Every GET sets the CSRF cookie if absent (so the browser JS can read it
  // and echo it back as X-CSRF-Token on the next POST /api/*).
  if (req.method === 'GET' || req.method === 'HEAD') {
    ensureCsrfCookie(req, res);
  }

  // /metricsz — non-authenticated counters only (security §7).
  if (req.method === 'GET' && pathname === '/metricsz') {
    sendJson(res, 200, getMetrics(sessionsMap.size));
    return;
  }

  if (req.method === 'GET' && pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, agentImpl: backendInfo().name }));
    return;
  }

  if (req.method === 'GET' && pathname === '/api/config') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ modelName: backendInfo().assistantName }));
    return;
  }

  if (req.method === 'GET' && pathname === '/api/sessions') {
    // M1: authenticated, read-only list scoped to the current user. Does
    // not expose host keys or transcript text; never leaks other users'
    // session ids, names, or participant lists.
    const user = AuthProvider.currentUser(req);
    if (!user) return sendJson(res, 401, { error: 'not_authenticated' });
    const list = [];
    for (const s of sessionsMap.values()) {
      const isHost = s.hostUserId === user.id;
      const isParticipant = [...s.participants.values()].some((p) => p.userId === user.id);
      if (!isHost && !isParticipant) continue;
      list.push({
        sessionId: s.id,
        createdAt: s.createdAt,
        lastActivityAt: s.lastActivityAt,
        participants: [...s.participants.values()].map(serializeParticipant),
      });
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ sessions: list, count: list.length }));
    return;
  }

  // Auth routes (register / login / logout / me). These handle their own
  // body parsing + CSRF + origin via guardPostApi.
  if (pathname.startsWith('/api/auth/')) {
    handleAuthRoute(req, res, url);
    return;
  }

  if (req.method === 'POST' && pathname === '/api/sessions') {
    // CSRF + origin first.
    if (!guardPostApi(req, res)) return;
    req.resume();
    // M1: no anonymous sessions — the host must be authenticated.
    const user = AuthProvider.currentUser(req);
    if (!user) return sendJson(res, 401, { error: 'not_authenticated' });
    // Per-IP rate limit: 10 session creates / min.
    const ip = clientIp(req);
    const rl = rateLimit(ip, 'session', 10, 60_000);
    if (!rl.ok) {
      audit('rate_limited', { userId: user.id, detail: { ip, bucket: 'session' } });
      return sendJson(res, 429, { error: 'rate_limited', retryAfter: rl.retryAfter }, { 'Retry-After': String(rl.retryAfter) });
    }
    // Caps: total sessions + login lockout (guest cap is enforced at WS join).
    const caps = enforceCaps(req, { sessionsCount: sessionsMap.size });
    if (!caps.ok) return sendJson(res, 503, { error: caps.code });
    if (!canCreateSession()) return sendJson(res, 503, { error: 'too_many_sessions' });
    const session = createSession(req.headers.host, user.id);
    audit('session_create', { sessionId: session.id, userId: user.id });
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sessionId: session.id, hostKey: session.hostKey, wsPath: '/ws' }));
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    if (pathname === '/' || pathname === '/join' || pathname.startsWith('/join/')) {
      serveIndex(res);
      return;
    }
    // /web/* → strip the prefix; any other GET → try web/ directly (covers
    // /app.js, /style.css referenced from index.html).
    const rel = pathname.startsWith('/web/') ? pathname.slice('/web'.length) : pathname;
    const filePath = safeWebPath(rel);
    if (!filePath) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden' }));
      return;
    }
    serveFile(res, filePath);
    return;
  }


  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
}

// ---------------------------------------------------------------------------
// WebSocket connection layer

// Per-socket state, keyed by the socket object.
// { sessionId, participantId, floodTimestamps: number[], ip: string, authUser: User|null }
const socketState = new WeakMap();
// Pre-join metadata (authUser + ip captured at the WS upgrade handshake).
// Kept separate so `socketState.has(socket)` stays the "joined?" marker.
const wsMeta = new WeakMap();

function participantOf(socket) {
  const state = socketState.get(socket);
  if (!state) return { session: null, participant: null };
  const session = getSession(state.sessionId);
  const participant = session?.participants.get(state.participantId) ?? null;
  return { session, participant };
}

/** Attach a socket to a participant and send the `joined` snapshot. */
function attachAndReply(socket, session, participant) {
  const wasConnected = participant.connected;
  participant.sockets.add(socket);
  participant.connected = true;
  const meta = wsMeta.get(socket);
  socketState.set(socket, {
    sessionId: session.id,
    participantId: participant.id,
    floodTimestamps: [],
    ip: meta?.ip || '',
    authUser: meta?.authUser ?? null,
  });
  touch(session);

  // Flush any pending assistant deltas so the snapshot text exactly equals
  // everything already delivered to other sockets (§6.2 / §9 guarantee).
  flushDeltas(session);

  sendFrame(socket, {
    type: 'joined',
    v: V,
    self: {
      participantId: participant.id,
      resumeKey: participant.resumeKey,
      role: participant.role,
      name: participant.name,
      canSend: participant.canSend,
    },
    session: buildSnapshot(session, participant),
  });
  return { wasConnected };
}

function handleJoin(socket, frame) {
  const meta = wsMeta.get(socket);
  const authUser = meta?.authUser ?? null;

  if (frame.as === 'host') {
    const session = getSession(frame.sessionId);
    if (!session) return sendError(socket, 'SESSION_NOT_FOUND', { fatal: true });
    if (typeof frame.hostKey !== 'string' || frame.hostKey !== session.hostKey) {
      return sendError(socket, 'BAD_HOST_KEY', { fatal: true });
    }
    let host = hostParticipant(session);
    if (host) {
      // Host rejoining with hostKey (covers cleared sessionStorage) — attach
      // to the existing host participant, like resume.
      const { wasConnected } = attachAndReply(socket, session, host);
      if (!wasConnected) {
        broadcast(session, {
          type: 'participant_updated',
          participantId: host.id,
          patch: { connected: true },
        }, { excludeSocket: socket });
      }
      audit('join', { sessionId: session.id, userId: host.userId, detail: { role: 'host', rejoin: true } });
      return undefined;
    }
    const name = sanitizeName(frame.name);
    if (!name) return sendError(socket, 'BAD_NAME', { fatal: true });
    host = createParticipant(session, { name, role: 'host', userId: authUser?.id ?? session.hostUserId ?? null });
    attachAndReply(socket, session, host);
    const systemMessage = appendSystemMessage(session, `${name} joined the session.`);
    broadcast(session, {
      type: 'participant_joined',
      participant: serializeParticipant(host),
      systemMessage: serializeMessage(systemMessage),
    }, { excludeSocket: socket });
    audit('join', { sessionId: session.id, userId: host.userId, detail: { role: 'host' } });
    return undefined;
  }

  if (frame.as === 'guest') {
    // M1: the guest must be logged in (no anonymous guests).
    if (!authUser) return sendError(socket, 'NOT_JOINED', { fatal: true, message: 'Authentication required to join.' });
    const name = sanitizeName(frame.name);
    if (!name) return sendError(socket, 'BAD_NAME', { fatal: true });
    const check = checkInvite(frame.inviteToken);
    if (!check.ok) return sendError(socket, check.code, { fatal: true });
    const { session, invite } = check;
    const guest = createParticipant(session, { name, role: 'guest', userId: authUser.id });
    markInviteUsed(invite, guest.id); // burn — single use, before anything async
    attachAndReply(socket, session, guest);
    const systemMessage = appendSystemMessage(session, `${name} joined the session.`);
    noteRosterChange(session, `${name} joined the session.`);
    broadcast(session, {
      type: 'participant_joined',
      participant: serializeParticipant(guest),
      systemMessage: serializeMessage(systemMessage),
    }, { excludeSocket: socket });
    audit('join', { sessionId: session.id, userId: guest.userId, detail: { role: 'guest' } });
    return undefined;
  }

  if (frame.as === 'resume') {
    const session = getSession(frame.sessionId);
    if (!session) return sendError(socket, 'SESSION_NOT_FOUND', { fatal: true });
    const participant = session.participants.get(frame.participantId);
    if (!participant || typeof frame.resumeKey !== 'string'
      || frame.resumeKey !== participant.resumeKey) {
      return sendError(socket, 'BAD_RESUME', { fatal: true });
    }
    if (participant.status === 'kicked') {
      return sendError(socket, 'REVOKED', { fatal: true, closeCode: 4001 });
    }
    const { wasConnected } = attachAndReply(socket, session, participant);
    if (!wasConnected) {
      broadcast(session, {
        type: 'participant_updated',
        participantId: participant.id,
        patch: { connected: true },
      }, { excludeSocket: socket });
    }
    audit('join', { sessionId: session.id, userId: participant.userId, detail: { role: participant.role, resume: true } });
    return undefined;
  }

  return sendError(socket, 'BAD_FRAME', {
    fatal: true, message: 'join.as must be "host", "guest" or "resume".',
  });
}

function handleUserMessage(socket, frame) {
  const { session, participant } = participantOf(socket);
  if (!session || !participant) return;
  const clientMsgId = typeof frame.clientMsgId === 'string' ? frame.clientMsgId.slice(0, 64) : undefined;

  if (participant.status === 'kicked' || !participant.canSend) {
    return sendError(socket, 'READ_ONLY', { clientMsgId });
  }
  const text = typeof frame.text === 'string' ? frame.text.trim() : '';
  if (text.length === 0) return sendError(socket, 'EMPTY_MESSAGE', { clientMsgId });
  if (text.length > MAX_MESSAGE_CHARS) return sendError(socket, 'MESSAGE_TOO_LONG', { clientMsgId });
  if (pendingIsFull(session)) return sendError(socket, 'RATE_LIMITED', { clientMsgId });

  const state = socketState.get(socket);
  // Per-IP token bucket: 60 user_messages / min (security §6).
  const ip = state?.ip || 'unknown';
  const rl = rateLimit(ip, 'msg', 60, 60_000);
  if (!rl.ok) {
    audit('rate_limited', { sessionId: session.id, userId: participant.userId, detail: { ip, bucket: 'msg' } });
    return sendError(socket, 'RATE_LIMITED', {
      clientMsgId, message: 'Too many messages. Slow down.',
    });
  }
  // Per-connection flood guard (security design §9): sliding window.
  const now = Date.now();
  const { limited } = floodCheck(state, now, FLOOD_WINDOW_MS, FLOOD_MAX_MSGS);
  if (limited) {
    return sendError(socket, 'RATE_LIMITED', {
      clientMsgId, message: 'Slow down — too many messages in a short time.',
    });
  }

  const message = appendMessage(session, {
    role: 'user',
    authorId: participant.id,
    authorName: participant.name,
    text,
  });
  touch(session);
  noteMessage();

  const echo = { type: 'user_message', message: serializeMessage(message) };
  if (clientMsgId !== undefined) echo.clientMsgId = clientMsgId;
  broadcast(session, echo);

  const start = Date.now();
  enqueueUserMessage(session, message);
  // noteRunMs is recorded when the run finishes (turns.js would need a hook);
  // for M1 we measure the enqueue cost, which is near-zero. A proper per-run
  // sample is wired in M2 via a turns.js callback.
  noteRunMs(Date.now() - start);
  return undefined;
}

function handleCreateInvite(socket, frame) {
  const { session, participant } = participantOf(socket);
  if (!session || !participant) return;
  if (participant.role !== 'host') return sendError(socket, 'NOT_HOST');
  const invite = createInvite(session, frame.ttlMinutes);
  touch(session);
  sendToParticipant(participant, {
    type: 'invite_created',
    inviteToken: invite.token,
    url: `${session.baseUrl}/join/${invite.token}`,
    expiresAt: invite.expiresAt,
  });
  return undefined;
}

function handleRevokeInvite(socket, frame) {
  const { session, participant } = participantOf(socket);
  if (!session || !participant) return;
  if (participant.role !== 'host') return sendError(socket, 'NOT_HOST');
  const invite = session.invites.get(frame.inviteToken);
  if (!invite || invite.usedBy !== null) return sendError(socket, 'INVALID_TOKEN');
  revokeInvite(invite);
  touch(session);
  sendToParticipant(participant, { type: 'invite_revoked', inviteToken: invite.token });
  return undefined;
}

function handleRevokeGuest(socket, frame) {
  const { session, participant } = participantOf(socket);
  if (!session || !participant) return;
  if (participant.role !== 'host') return sendError(socket, 'NOT_HOST');
  const target = session.participants.get(frame.participantId);
  if (!target || target.status === 'kicked') return sendError(socket, 'PARTICIPANT_NOT_FOUND');
  if (target.role === 'host') return sendError(socket, 'CANNOT_REVOKE_HOST');

  const mode = frame.mode;
  touch(session);

  if (mode === 'kick') {
    setParticipantStatus(target, { status: 'kicked', canSend: false });
    const systemMessage = appendSystemMessage(session, `${target.name} was removed by the host.`);
    noteRosterChange(session, `${target.name} left the session.`);
    audit('kick', { sessionId: session.id, userId: participant.userId, detail: { target: target.id, targetUser: target.userId } });
    // Broadcast to all sockets (including the kicked guest's), THEN close.
    broadcast(session, {
      type: 'participant_left',
      participantId: target.id,
      reason: 'kicked',
      systemMessage: serializeMessage(systemMessage),
    });
    for (const s of target.sockets) {
      try { s.close(4001); } catch { /* ignore */ }
    }
    target.sockets.clear();
    target.connected = false;
    return undefined;
  }

  if (mode === 'read_only' || mode === 'restore') {
    const canSend = mode === 'restore';
    setParticipantCanSend(target, canSend);
    const systemMessage = appendSystemMessage(
      session,
      canSend
        ? `${target.name} can send messages again.`
        : `${target.name} was made read-only by the host.`,
    );
    audit('revoke', { sessionId: session.id, userId: participant.userId, detail: { target: target.id, mode } });
    broadcast(session, {
      type: 'participant_updated',
      participantId: target.id,
      patch: { canSend },
      systemMessage: serializeMessage(systemMessage),
    });
    return undefined;
  }

  return sendError(socket, 'BAD_FRAME', {
    message: 'revoke_guest.mode must be "kick", "read_only" or "restore".',
  });
}

function handleDisconnect(socket) {
  const { session, participant } = participantOf(socket);
  socketState.delete(socket);
  if (!session || !participant) return;
  participant.sockets.delete(socket);
  touch(session);
  if (participant.sockets.size === 0 && participant.connected) {
    participant.connected = false;
    if (participant.status !== 'kicked') {
      broadcast(session, {
        type: 'participant_updated',
        participantId: participant.id,
        patch: { connected: false },
      });
    }
  }
}

function handleFrame(socket, raw) {
  let frame;
  try {
    frame = JSON.parse(raw.toString('utf8'));
  } catch {
    if (!socketState.has(socket)) {
      return sendError(socket, 'NOT_JOINED', { fatal: true });
    }
    return sendError(socket, 'BAD_FRAME');
  }
  if (frame === null || typeof frame !== 'object' || typeof frame.type !== 'string') {
    if (!socketState.has(socket)) return sendError(socket, 'NOT_JOINED', { fatal: true });
    return sendError(socket, 'BAD_FRAME');
  }

  const joined = socketState.has(socket);

  if (!joined) {
    if (frame.type !== 'join') return sendError(socket, 'NOT_JOINED', { fatal: true });
    return handleJoin(socket, frame);
  }

  const { session } = participantOf(socket);
  if (session) touch(session);

  switch (frame.type) {
    case 'join':
      // Already joined on this socket — ignore politely.
      return sendError(socket, 'BAD_FRAME', { message: 'Already joined on this socket.' });
    case 'user_message':
      return handleUserMessage(socket, frame);
    case 'create_invite':
      return handleCreateInvite(socket, frame);
    case 'revoke_invite':
      return handleRevokeInvite(socket, frame);
    case 'revoke_guest':
      return handleRevokeGuest(socket, frame);
    case 'ping':
      return sendFrame(socket, { type: 'pong', v: V, t: frame.t });
    default:
      return sendError(socket, 'BAD_FRAME');
  }
}

// ---------------------------------------------------------------------------
// Startup

async function main() {
  const backend = await createAgentBackend();
  setBackend(backend);

  // Persistence: open + migrate SQLite, then rebuild the in-memory Maps from
  // disk so a restart resumes active sessions (restart-resume guarantee).
  migrate();
  const restored = loadFromDisk();
  console.log(
    `[persistence] restored ${restored.sessions} session(s), `
    + `${restored.participants} participant(s), ${restored.invites} invite(s), `
    + `${restored.messages} message(s)`,
  );

  const server = http.createServer(handleHttp);
  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD });

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://internal');
    if (pathname !== '/ws') {
      socket.destroy();
      return;
    }
    // Origin allowlist (security §6). Same-origin browsers send no Origin on
    // WS, which we allow; a mismatched Origin is rejected before upgrade.
    if (!checkOrigin(req)) {
      log.warn({ origin: req.headers.origin }, 'ws upgrade rejected: origin not allowed');
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws, req) => {
    ws.pingMisses = 0;
    // Capture the auth user (from the cookie on the upgrade request) + the
    // client IP up front, so handleJoin can bind participant.userId and the
    // rate limiter can bucket by IP without re-reading headers per frame.
    const authUser = AuthProvider.currentUser(req);
    const ip = clientIp(req);
    wsMeta.set(ws, { ip, authUser });
    noteConnection(1);
    log.info({ userId: authUser?.id, ip }, 'ws connected');
    ws.on('pong', () => { ws.pingMisses = 0; });
    ws.on('message', (data) => {
      try {
        handleFrame(ws, data);
      } catch (err) {
        log.error({ err }, 'ws frame handler error');
        noteError();
        sendError(ws, 'INTERNAL');
      }
    });
    ws.on('close', () => {
      handleDisconnect(ws);
      noteConnection(-1);
    });
    ws.on('error', () => { /* close handler does the cleanup */ });
  });

  // Protocol-level keepalive: ping every 30s, terminate after 2 misses.
  const pingTimer = setInterval(() => {
    for (const ws of wss.clients) {
      ws.pingMisses = (ws.pingMisses ?? 0) + 1;
      if (ws.pingMisses > WS_PING_MAX_MISSES) {
        ws.terminate();
        continue;
      }
      try { ws.ping(); } catch { /* ignore */ }
    }
  }, WS_PING_INTERVAL_MS);
  pingTimer.unref();

  startSweeper();

  server.listen(PORT, () => {
    console.log(`agent backend: ${backend.name}${backend.name === 'sdk' ? '' : backend.name === 'api' ? ' (fallback)' : ' (canned responses — no credentials needed)'}`);
    console.log(`TagTeam running at http://localhost:${PORT}`);
  });

  const shutdown = () => {
    console.log('\nshutting down…');
    clearInterval(pingTimer);
    try { wss.close(); } catch { /* ignore */ }
    server.close(() => process.exit(0));
    // No state to flush; force-exit if close hangs on open sockets.
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('fatal startup error:', err);
  process.exit(1);
});
