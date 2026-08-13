import { describe, it, expect } from 'vitest';
import {
  V, ERROR_CODES, ERROR_MESSAGES, errorFrame, sendFrame, sendError,
} from '../../server/protocol.js';

function mockSocket() {
  const sent = [];
  const socket = {
    readyState: 1,
    sent,
    send: (data) => sent.push(data),
    closeCode: null,
    terminated: false,
    close(code) { this.closeCode = code; this.readyState = 3; },
    terminate() { this.terminated = true; this.readyState = 3; },
  };
  return socket;
}

describe('errorFrame', () => {
  it('sets v, code, message, fatal with defaults', () => {
    const f = errorFrame('BAD_FRAME');
    expect(f).toEqual({
      type: 'error', v: V, code: 'BAD_FRAME',
      message: ERROR_MESSAGES.BAD_FRAME, fatal: false,
    });
  });

  it('honors fatal and custom message', () => {
    const f = errorFrame('INTERNAL', { fatal: true, message: 'boom' });
    expect(f.fatal).toBe(true);
    expect(f.message).toBe('boom');
    expect(f.code).toBe('INTERNAL');
    expect(f.v).toBe(V);
  });

  it('includes clientMsgId when provided and omits it otherwise', () => {
    expect(errorFrame('BAD_FRAME', { clientMsgId: 'abc' }).clientMsgId).toBe('abc');
    expect(errorFrame('BAD_FRAME')).not.toHaveProperty('clientMsgId');
    expect(errorFrame('BAD_FRAME', { clientMsgId: null })).not.toHaveProperty('clientMsgId');
    expect(errorFrame('BAD_FRAME', { clientMsgId: undefined })).not.toHaveProperty('clientMsgId');
  });

  it('falls back to code as message when code is unknown', () => {
    const f = errorFrame('WEIRD_CODE');
    expect(f.message).toBe('WEIRD_CODE');
  });
});

describe('sendFrame', () => {
  it('serializes and sends on an open socket', () => {
    const s = mockSocket();
    sendFrame(s, { type: 'pong', v: V });
    expect(s.sent).toHaveLength(1);
    expect(JSON.parse(s.sent[0])).toEqual({ type: 'pong', v: V });
  });

  it('no-ops on a closed socket', () => {
    const s = mockSocket();
    s.readyState = 3;
    sendFrame(s, { type: 'pong', v: V });
    expect(s.sent).toHaveLength(0);
  });

  it('terminates the socket if send throws', () => {
    const s = mockSocket();
    s.send = () => { throw new Error('fail'); };
    sendFrame(s, { type: 'pong', v: V });
    expect(s.terminated).toBe(true);
  });
});

describe('sendError', () => {
  it('sends an error frame and does not close when non-fatal', () => {
    const s = mockSocket();
    sendError(s, 'BAD_NAME', { clientMsgId: 'x' });
    expect(s.sent).toHaveLength(1);
    expect(JSON.parse(s.sent[0]).code).toBe('BAD_NAME');
    expect(s.closeCode).toBe(null);
  });

  it('closes the socket with 4000 when fatal', () => {
    const s = mockSocket();
    sendError(s, 'BAD_HOST_KEY', { fatal: true });
    expect(s.closeCode).toBe(4000);
    expect(JSON.parse(s.sent[0]).fatal).toBe(true);
  });

  it('honors a custom closeCode', () => {
    const s = mockSocket();
    sendError(s, 'REVOKED', { fatal: true, closeCode: 4001 });
    expect(s.closeCode).toBe(4001);
  });
});

describe('ERROR_CODES / ERROR_MESSAGES', () => {
  it('every ERROR_CODES entry has a matching ERROR_MESSAGES entry', () => {
    for (const code of ERROR_CODES) {
      expect(ERROR_MESSAGES[code], `missing message for ${code}`).toBeTruthy();
    }
  });
});
