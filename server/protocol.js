// Wire-protocol helpers — single source of truth for frame shapes on the
// server side. Frame contract: docs/design/architecture.md §6.

export const V = 1;

export const ERROR_CODES = new Set([
  'BAD_FRAME', 'NOT_JOINED', 'SESSION_NOT_FOUND', 'BAD_HOST_KEY',
  'INVALID_TOKEN', 'TOKEN_EXPIRED', 'TOKEN_USED', 'TOKEN_REVOKED',
  'SESSION_FULL', 'BAD_NAME', 'BAD_RESUME', 'REVOKED', 'READ_ONLY',
  'EMPTY_MESSAGE', 'MESSAGE_TOO_LONG', 'RATE_LIMITED', 'NOT_HOST',
  'PARTICIPANT_NOT_FOUND', 'CANNOT_REVOKE_HOST', 'INTERNAL',
]);

export const ERROR_MESSAGES = {
  BAD_FRAME: 'Malformed or unknown frame.',
  NOT_JOINED: 'The first frame on a connection must be "join".',
  SESSION_NOT_FOUND: 'This session has ended or does not exist.',
  BAD_HOST_KEY: 'Invalid host key for this session.',
  INVALID_TOKEN: "This invite link isn't valid.",
  TOKEN_EXPIRED: 'This invite link expired. Ask the host for a new one.',
  TOKEN_USED: 'This invite link was already used. Ask the host for a new one.',
  TOKEN_REVOKED: 'This invite link was revoked by the host.',
  SESSION_FULL: 'This session already has the maximum number of guests.',
  BAD_NAME: 'Please provide a display name (1-40 characters).',
  BAD_RESUME: 'Could not resume this session. Rejoin with a fresh link.',
  REVOKED: 'You were removed from this session by the host.',
  READ_ONLY: 'The host has made you read-only.',
  EMPTY_MESSAGE: 'Message text is empty.',
  MESSAGE_TOO_LONG: 'Message is too long (max 8000 characters).',
  RATE_LIMITED: 'Too many messages queued. Wait for Claude to catch up.',
  NOT_HOST: 'Only the host can do that.',
  PARTICIPANT_NOT_FOUND: 'No such participant in this session.',
  CANNOT_REVOKE_HOST: 'The host cannot be revoked.',
  INTERNAL: 'Internal server error.',
};

/** Build an `error` frame. */
export function errorFrame(code, { fatal = false, message, clientMsgId } = {}) {
  const frame = {
    type: 'error',
    v: V,
    code,
    message: message ?? ERROR_MESSAGES[code] ?? code,
    fatal,
  };
  if (clientMsgId !== undefined && clientMsgId !== null) frame.clientMsgId = clientMsgId;
  return frame;
}

/** Serialize + send a frame on a single socket, ignoring dead sockets. */
export function sendFrame(socket, frame) {
  if (!socket || socket.readyState !== 1 /* OPEN */) return;
  try {
    socket.send(JSON.stringify(frame));
  } catch {
    try { socket.terminate(); } catch { /* ignore */ }
  }
}

/**
 * Send a non-fatal or fatal error frame. Fatal errors close the socket with
 * WS close code 4000 (auth/validation) per the wire protocol.
 */
export function sendError(socket, code, opts = {}) {
  sendFrame(socket, errorFrame(code, opts));
  if (opts.fatal) {
    try { socket.close(opts.closeCode ?? 4000); } catch { /* ignore */ }
  }
}
