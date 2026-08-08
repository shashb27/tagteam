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
import {
  canCreateSession, createSession, getSession, touch,
  sanitizeName, createParticipant, hostParticipant, checkInvite, createInvite,
  appendMessage, appendSystemMessage,
  serializeParticipant, serializeMessage, buildSnapshot,
  broadcast, sendToParticipant, startSweeper,
} from './sessions.js';
import {
  setBackend, backendInfo, flushDeltas, enqueueUserMessage, pendingIsFull,
  noteRosterChange,
} from './turns.js';
import { createAgentBackend } from './agent/index.js';

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

function handleHttp(req, res) {
  const url = new URL(req.url, 'http://internal');
  const { pathname } = url;

  if (req.method === 'POST' && pathname === '/api/sessions') {
    // Body is deliberately ignored.
    req.resume();
    if (!canCreateSession()) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'too_many_sessions' }));
      return;
    }
    const session = createSession(req.headers.host);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sessionId: session.id, hostKey: session.hostKey, wsPath: '/ws' }));
    return;
  }

  if (req.method === 'GET' && pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, agentImpl: backendInfo().name }));
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
// { sessionId, participantId, floodTimestamps: number[] }
const socketState = new WeakMap();

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
  socketState.set(socket, {
    sessionId: session.id,
    participantId: participant.id,
    floodTimestamps: [],
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
    session: buildSnapshot(session),
  });
  return { wasConnected };
}

function handleJoin(socket, frame) {
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
      return undefined;
    }
    const name = sanitizeName(frame.name);
    if (!name) return sendError(socket, 'BAD_NAME', { fatal: true });
    host = createParticipant(session, { name, role: 'host' });
    attachAndReply(socket, session, host);
    const systemMessage = appendSystemMessage(session, `${name} joined the session.`);
    broadcast(session, {
      type: 'participant_joined',
      participant: serializeParticipant(host),
      systemMessage: serializeMessage(systemMessage),
    }, { excludeSocket: socket });
    return undefined;
  }

  if (frame.as === 'guest') {
    const name = sanitizeName(frame.name);
    if (!name) return sendError(socket, 'BAD_NAME', { fatal: true });
    const check = checkInvite(frame.inviteToken);
    if (!check.ok) return sendError(socket, check.code, { fatal: true });
    const { session, invite } = check;
    const guest = createParticipant(session, { name, role: 'guest' });
    invite.usedBy = guest.id; // burn — single use, before anything async
    attachAndReply(socket, session, guest);
    const systemMessage = appendSystemMessage(session, `${name} joined the session.`);
    noteRosterChange(session, `${name} joined the session.`);
    broadcast(session, {
      type: 'participant_joined',
      participant: serializeParticipant(guest),
      systemMessage: serializeMessage(systemMessage),
    }, { excludeSocket: socket });
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

  // Per-connection flood guard (security design §9): sliding window.
  const state = socketState.get(socket);
  const now = Date.now();
  state.floodTimestamps = state.floodTimestamps.filter((t) => now - t < FLOOD_WINDOW_MS);
  if (state.floodTimestamps.length >= FLOOD_MAX_MSGS) {
    return sendError(socket, 'RATE_LIMITED', {
      clientMsgId, message: 'Slow down — too many messages in a short time.',
    });
  }
  state.floodTimestamps.push(now);

  const message = appendMessage(session, {
    role: 'user',
    authorId: participant.id,
    authorName: participant.name,
    text,
  });
  touch(session);

  const echo = { type: 'user_message', message: serializeMessage(message) };
  if (clientMsgId !== undefined) echo.clientMsgId = clientMsgId;
  broadcast(session, echo);

  enqueueUserMessage(session, message);
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
  invite.revoked = true;
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
    target.status = 'kicked';
    target.canSend = false;
    const systemMessage = appendSystemMessage(session, `${target.name} was removed by the host.`);
    noteRosterChange(session, `${target.name} left the session.`);
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
    target.canSend = canSend;
    const systemMessage = appendSystemMessage(
      session,
      canSend
        ? `${target.name} can send messages again.`
        : `${target.name} was made read-only by the host.`,
    );
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

  const server = http.createServer(handleHttp);
  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD });

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://internal');
    if (pathname !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    ws.pingMisses = 0;
    ws.on('pong', () => { ws.pingMisses = 0; });
    ws.on('message', (data) => {
      try {
        handleFrame(ws, data);
      } catch (err) {
        console.error('[ws] frame handler error:', err);
        sendError(ws, 'INTERNAL');
      }
    });
    ws.on('close', () => handleDisconnect(ws));
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
