import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  setBackend, buildSystemPrompt, composeUserTurn, noteRosterChange,
  enqueueUserMessage, pendingIsFull, flushDeltas,
} from '../../server/turns.js';
import {
  sessions, createSession, createParticipant, appendMessage,
} from '../../server/sessions.js';
import { MAX_PENDING_MESSAGES } from '../../server/config.js';
import { V } from '../../server/protocol.js';

beforeEach(() => {
  sessions.clear();
  setBackend(null);
});

function mockSocket() {
  const frames = [];
  return {
    readyState: 1,
    frames,
    send: (data) => frames.push(JSON.parse(data)),
    close() { this.readyState = 3; },
    terminate() { this.readyState = 3; },
  };
}

function fakeSessionWithSocket() {
  const session = createSession();
  const host = createParticipant(session, { name: 'Host', role: 'host' });
  const socket = mockSocket();
  host.sockets.add(socket);
  host.connected = true;
  return { session, host, socket };
}

describe('buildSystemPrompt', () => {
  it('includes roster names + roles', () => {
    const s = createSession();
    createParticipant(s, { name: 'Alice', role: 'host' });
    createParticipant(s, { name: 'Bob', role: 'guest' });
    const p = buildSystemPrompt(s);
    expect(p).toContain('Alice (host)');
    expect(p).toContain('Bob (guest)');
  });
  it('says "opencode agent" not "Claude"', () => {
    const s = createSession();
    const p = buildSystemPrompt(s);
    expect(p).toMatch(/opencode agent/i);
    expect(p).not.toMatch(/\bClaude\b/);
  });
  it('mentions read-only tools when backend.hasTools is true', () => {
    const s = createSession();
    setBackend({ name: 'opencode', assistantName: 'Assistant', hasTools: true });
    const p = buildSystemPrompt(s);
    expect(p).toMatch(/read-only tools/i);
  });
  it('omits read-only tools when backend.hasTools is false', () => {
    const s = createSession();
    setBackend({ name: 'mock', assistantName: 'Assistant (mock)', hasTools: false });
    const p = buildSystemPrompt(s);
    expect(p).not.toMatch(/read-only tools/i);
  });
  it('excludes kicked participants from roster', () => {
    const s = createSession();
    createParticipant(s, { name: 'Alice', role: 'host' });
    const g = createParticipant(s, { name: 'Bob', role: 'guest' });
    g.status = 'kicked';
    const p = buildSystemPrompt(s);
    expect(p).toContain('Alice (host)');
    expect(p).not.toContain('Bob (guest)');
  });
});

describe('composeUserTurn', () => {
  it('prefixes each message with [Name]:', () => {
    const s = createSession();
    const m1 = appendMessage(s, { role: 'user', authorId: 'a', authorName: 'Alice', text: 'hello' });
    const m2 = appendMessage(s, { role: 'user', authorId: 'b', authorName: 'Bob', text: 'world' });
    const out = composeUserTurn(s, [m1, m2]);
    expect(out).toBe('[Alice]: hello\n\n[Bob]: world');
  });
  it('consumes roster notes (prepends them, clears the list)', () => {
    const s = createSession();
    noteRosterChange(s, 'Bob joined the session.');
    const m = appendMessage(s, { role: 'user', authorId: 'a', authorName: 'Alice', text: 'hi' });
    const out = composeUserTurn(s, [m]);
    expect(out).toContain('(Note: Bob joined the session.)');
    expect(out).toContain('[Alice]: hi');
    expect(s.rosterNotes).toEqual([]);
  });
});

describe('noteRosterChange', () => {
  it('accumulates notes', () => {
    const s = createSession();
    noteRosterChange(s, 'a');
    noteRosterChange(s, 'b');
    expect(s.rosterNotes).toEqual(['a', 'b']);
  });
});

describe('enqueueUserMessage + pendingIsFull', () => {
  it('pendingIsFull caps at MAX_PENDING_MESSAGES', () => {
    const s = createSession();
    for (let i = 0; i < MAX_PENDING_MESSAGES; i++) s.pendingUserMessages.push({});
    expect(pendingIsFull(s)).toBe(true);
  });
  it('enqueueUserMessage queues and starts a run when idle', async () => {
    const { session, socket } = fakeSessionWithSocket();
    let created = 0;
    let runCalls = 0;
    setBackend({
      name: 'stub', assistantName: 'Stub', hasTools: false,
      createAgentSession() {
        created++;
        return {
          async run({ onEvent }) {
            runCalls++;
            onEvent({ type: 'text_delta', text: 'hi' });
            return { text: 'hi', stopReason: 'end_turn' };
          },
          dispose() {},
        };
      },
    });
    const msg = appendMessage(session, { role: 'user', authorId: 'h', authorName: 'Host', text: 'q' });
    enqueueUserMessage(session, msg);
    expect(session.pendingUserMessages).toHaveLength(0); // spliced into the run
    // let the async run settle
    await new Promise((r) => setTimeout(r, 10));
    expect(created).toBe(1);
    expect(runCalls).toBe(1);
    expect(session.activeRun).toBe(null);
    // assistant_start + assistant_delta + assistant_complete broadcast
    const types = socket.frames.map((f) => f.type);
    expect(types).toContain('assistant_start');
    expect(types).toContain('assistant_delta');
    expect(types).toContain('assistant_complete');
  });
  it('does NOT start a second run when one is active', () => {
    const s = createSession();
    s.activeRun = { messageId: 'm1', abortController: new AbortController() };
    const msg = appendMessage(s, { role: 'user', authorId: 'h', authorName: 'H', text: 'q' });
    const before = s.pendingUserMessages.length;
    enqueueUserMessage(s, msg);
    expect(s.pendingUserMessages.length).toBe(before + 1);
    expect(s.activeRun).not.toBe(null);
    s.activeRun = null; // cleanup
  });
});

describe('flushDeltas (delta coalescing)', () => {
  it('emits assistant_delta with index + delta and clears the buffer', () => {
    const { session, socket } = fakeSessionWithSocket();
    session.activeRun = {
      messageId: 'm1',
      deltaIndex: 0,
      flushTimer: null,
      buffer: 'hello',
      abortController: new AbortController(),
    };
    flushDeltas(session);
    const deltas = socket.frames.filter((f) => f.type === 'assistant_delta');
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toEqual({
      v: V, type: 'assistant_delta', messageId: 'm1', index: 0, delta: 'hello',
    });
    expect(session.activeRun.buffer).toBe('');
    expect(session.activeRun.deltaIndex).toBe(1);
  });
  it('no-ops when buffer is empty', () => {
    const { session, socket } = fakeSessionWithSocket();
    session.activeRun = {
      messageId: 'm1', deltaIndex: 0, flushTimer: null, buffer: '',
      abortController: new AbortController(),
    };
    flushDeltas(session);
    expect(socket.frames.filter((f) => f.type === 'assistant_delta')).toHaveLength(0);
  });
  it('no-ops when there is no activeRun', () => {
    const { session, socket } = fakeSessionWithSocket();
    flushDeltas(session);
    expect(socket.frames).toHaveLength(0);
  });
  it('clears a pending flush timer', () => {
    const { session } = fakeSessionWithSocket();
    const timer = setTimeout(() => {}, 1000);
    session.activeRun = {
      messageId: 'm1', deltaIndex: 0, flushTimer: timer, buffer: 'x',
      abortController: new AbortController(),
    };
    const clearSpy = vi.spyOn(global, 'clearTimeout');
    flushDeltas(session);
    expect(clearSpy).toHaveBeenCalledWith(timer);
    expect(session.activeRun.flushTimer).toBe(null);
    clearSpy.mockRestore();
    clearTimeout(timer);
  });
});

describe('run lifecycle (via enqueueUserMessage)', () => {
  it('emits assistant_start, streams text_delta, then assistant_complete', async () => {
    const { session, socket } = fakeSessionWithSocket();
    setBackend({
      name: 'stub', assistantName: 'Stub', hasTools: false,
      createAgentSession() {
        return {
          async run({ onEvent }) {
            onEvent({ type: 'text_delta', text: 'hi' });
            return { text: 'hi', stopReason: 'end_turn' };
          },
          dispose() {},
        };
      },
    });
    const msg = appendMessage(session, { role: 'user', authorId: 'h', authorName: 'Host', text: 'q' });
    enqueueUserMessage(session, msg);
    await new Promise((r) => setTimeout(r, 20));
    const types = socket.frames.map((f) => f.type);
    expect(types[0]).toBe('assistant_start');
    expect(types).toContain('assistant_delta');
    expect(types[types.length - 1]).toBe('assistant_complete');
    const complete = socket.frames.find((f) => f.type === 'assistant_complete');
    expect(complete.stopReason).toBe('end_turn');
    expect(complete.text).toBe('hi');
    expect(session.activeRun).toBe(null);
  });

  it('broadcasts tool_start + tool_end from tool events', async () => {
    const { session, socket } = fakeSessionWithSocket();
    setBackend({
      name: 'stub', assistantName: 'Stub', hasTools: true,
      createAgentSession() {
        return {
          async run({ onEvent }) {
            onEvent({ type: 'tool_start', tool: 'Read', summary: '' });
            onEvent({ type: 'tool_end', tool: 'Read', summary: 'read x', ok: true });
            return { text: 'done', stopReason: 'end_turn' };
          },
          dispose() {},
        };
      },
    });
    const msg = appendMessage(session, { role: 'user', authorId: 'h', authorName: 'Host', text: 'q' });
    enqueueUserMessage(session, msg);
    await new Promise((r) => setTimeout(r, 20));
    const activities = socket.frames.filter((f) => f.type === 'tool_activity');
    expect(activities).toHaveLength(2);
    expect(activities[0]).toMatchObject({ phase: 'start', tool: 'Read' });
    expect(activities[1]).toMatchObject({ phase: 'end', tool: 'Read', ok: true });
  });

  it('on error emits assistant_error then assistant_complete with stopReason error', async () => {
    const { session, socket } = fakeSessionWithSocket();
    setBackend({
      name: 'stub', assistantName: 'Stub', hasTools: false,
      createAgentSession() {
        return {
          async run() { throw new Error('boom'); },
          dispose() {},
        };
      },
    });
    const msg = appendMessage(session, { role: 'user', authorId: 'h', authorName: 'Host', text: 'q' });
    enqueueUserMessage(session, msg);
    await new Promise((r) => setTimeout(r, 20));
    const types = socket.frames.map((f) => f.type);
    expect(types).toContain('assistant_error');
    const complete = socket.frames.filter((f) => f.type === 'assistant_complete').pop();
    expect(complete.stopReason).toBe('error');
  });
});
