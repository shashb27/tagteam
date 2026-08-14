import { describe, it, expect, beforeEach } from 'vitest';
import {
  sessions, createSession, createParticipant, appendMessage,
  serializeMessage, broadcast,
} from '../../server/sessions.js';
import { resetDb } from '../../server/db.js';

beforeEach(() => {
  resetDb();
  sessions.clear();
});

function mockSocket() {
  return {
    readyState: 1,
    frames: [],
    send(data) { this.frames.push(JSON.parse(data)); },
    close() { this.readyState = 3; },
    terminate() { this.readyState = 3; },
  };
}

describe('broadcast — per-recipient redaction (M1 security §5)', () => {
  it('host receives raw text, guest receives [redacted]', () => {
    const s = createSession();
    const host = createParticipant(s, { name: 'Host', role: 'host', userId: 'u1' });
    const guest = createParticipant(s, { name: 'Guest', role: 'guest', userId: 'u2' });
    const hostSock = mockSocket();
    const guestSock = mockSocket();
    host.sockets.add(hostSock);
    guest.sockets.add(guestSock);

    const msg = appendMessage(s, {
      role: 'user', authorId: host.id, authorName: 'Host',
      text: 'my key is sk-ant-api03-secret-abc-123',
    });
    broadcast(s, { type: 'user_message', message: serializeMessage(msg) });

    const hostFrame = hostSock.frames[0];
    const guestFrame = guestSock.frames[0];
    expect(hostFrame.message.text).toBe('my key is sk-ant-api03-secret-abc-123');
    expect(guestFrame.message.text).toBe('my key is [redacted]');
  });

  it('assistant_delta is redacted for guests, raw for hosts', () => {
    const s = createSession();
    const host = createParticipant(s, { name: 'Host', role: 'host', userId: 'u1' });
    const guest = createParticipant(s, { name: 'Guest', role: 'guest', userId: 'u2' });
    const hostSock = mockSocket();
    const guestSock = mockSocket();
    host.sockets.add(hostSock);
    guest.sockets.add(guestSock);

    broadcast(s, { type: 'assistant_delta', messageId: 'm1', index: 0, delta: 'path /Users/shash/secret' });

    expect(hostSock.frames[0].delta).toBe('path /Users/shash/secret');
    expect(guestSock.frames[0].delta).toBe('path [redacted]');
  });

  it('assistant_complete text is redacted for guests', () => {
    const s = createSession();
    const host = createParticipant(s, { name: 'Host', role: 'host', userId: 'u1' });
    const guest = createParticipant(s, { name: 'Guest', role: 'guest', userId: 'u2' });
    const hostSock = mockSocket();
    const guestSock = mockSocket();
    host.sockets.add(hostSock);
    guest.sockets.add(guestSock);

    broadcast(s, { type: 'assistant_complete', messageId: 'm1', text: 'email me at sam@example.com', stopReason: 'end_turn' });

    expect(hostSock.frames[0].text).toBe('email me at sam@example.com');
    expect(guestSock.frames[0].text).toBe('email me at [email redacted]');
  });

  it('frames without text are delivered verbatim to both roles', () => {
    const s = createSession();
    const host = createParticipant(s, { name: 'Host', role: 'host', userId: 'u1' });
    const guest = createParticipant(s, { name: 'Guest', role: 'guest', userId: 'u2' });
    const hostSock = mockSocket();
    const guestSock = mockSocket();
    host.sockets.add(hostSock);
    guest.sockets.add(guestSock);

    broadcast(s, { type: 'participant_updated', participantId: guest.id, patch: { connected: true } });

    expect(hostSock.frames[0]).toEqual(guestSock.frames[0]);
    expect(hostSock.frames[0].type).toBe('participant_updated');
  });

  it('host-hidden ranges are applied for guests (by messageId)', () => {
    const s = createSession();
    const host = createParticipant(s, { name: 'Host', role: 'host', userId: 'u1' });
    const guest = createParticipant(s, { name: 'Guest', role: 'guest', userId: 'u2' });
    // Host marked chars 5..10 of message 'm1' (the word "WORLD") hidden from this guest.
    guest.hiddenRanges = [{ messageId: 'm1', start: 5, end: 10 }];
    const hostSock = mockSocket();
    const guestSock = mockSocket();
    host.sockets.add(hostSock);
    guest.sockets.add(guestSock);

    broadcast(s, {
      type: 'user_message',
      message: { id: 'm1', seq: 1, role: 'user', authorId: 'h', authorName: 'Host', text: 'hide WORLD please', ts: 1, streaming: false, toolEvents: [] },
    });

    expect(hostSock.frames[0].message.text).toBe('hide WORLD please');
    expect(guestSock.frames[0].message.text).toBe('hide [hidden by host] please');
  });

  it('excludeSocket skips only that socket', () => {
    const s = createSession();
    const host = createParticipant(s, { name: 'Host', role: 'host', userId: 'u1' });
    const a = mockSocket();
    const b = mockSocket();
    host.sockets.add(a);
    host.sockets.add(b);

    broadcast(s, { type: 'ping' }, { excludeSocket: a });
    expect(a.frames).toHaveLength(0);
    expect(b.frames).toHaveLength(1);
    expect(b.frames[0].type).toBe('ping');
  });
});
