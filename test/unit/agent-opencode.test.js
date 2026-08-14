import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stub the @opencode-ai/sdk module BEFORE importing the adapter. The adapter
// uses dynamic `await import('@opencode-ai/sdk')`, which vitest's mock system
// intercepts. Each test configures the stub via `setSdkStub()`.

let _stub = null;

function makeEvent(type, properties) {
  return { id: 'evt_' + Math.random().toString(36).slice(2), type, properties };
}

/** Build a fake SDK whose event.stream yields the provided events. */
function fakeSdk(events, opts = {}) {
  const session = {
    create: vi.fn(async () => ({ data: { id: opts.sessionId ?? 'ses_fake' } })),
    prompt: vi.fn(async () => ({ data: { id: 'msg_fake' } })),
    abort: vi.fn(async () => ({ data: true })),
    delete: vi.fn(async () => ({ data: true })),
  };
  const event = {
    subscribe: vi.fn(async () => {
      const stream = (async function* () {
        for (const e of events) yield e;
      })();
      return { stream };
    }),
  };
  const client = { session, event };
  const server = { close: vi.fn() };
  const createOpencode = vi.fn(async () => ({ client, server }));
  const createOpencodeClient = vi.fn(() => client);
  return { createOpencode, createOpencodeClient, client, server };
}

function setSdkStub(stub) {
  _stub = stub;
}

vi.mock('@opencode-ai/sdk', () => ({
  createOpencode: (...args) => _stub.createOpencode(...args),
  createOpencodeClient: (...args) => _stub.createOpencodeClient(...args),
}));

// Import the module under test after the mock is in place. We reset modules
// per test so the adapter's cached `_shared` client is fresh.
let opencodeRunner;
beforeEach(async () => {
  vi.resetModules();
  opencodeRunner = await import('../../server/agent/opencodeRunner.js');
});

describe('OpencodeAgentSession.run (stubbed SDK)', () => {
  it('maps a text-delta → finish:stop sequence into TagTeam events and resolves', async () => {
    const events = [
      makeEvent('message.part.delta', { field: 'text', delta: 'Hello' }),
      makeEvent('message.part.delta', { field: 'text', delta: ' world' }),
      makeEvent('message.updated', { info: { role: 'assistant', finish: 'stop' } }),
    ];
    setSdkStub(fakeSdk(events));
    const { opencodeBackend } = opencodeRunner;
    const backend = opencodeBackend();
    const agent = backend.createAgentSession();

    const onEvent = vi.fn();
    const res = await agent.run({
      userText: '[Sam]: hi', systemPrompt: 'sys', onEvent, signal: undefined,
    });

    const deltas = onEvent.mock.calls
      .map((c) => c[0])
      .filter((e) => e.type === 'text_delta');
    expect(deltas).toEqual([
      { type: 'text_delta', text: 'Hello' },
      { type: 'text_delta', text: ' world' },
    ]);
    expect(res.text).toBe('Hello world');
    expect(res.stopReason).toBe('end_turn');
  });

  it('maps tool pending/completed into tool_start/tool_end', async () => {
    const events = [
      makeEvent('message.part.updated', {
        part: { type: 'tool', tool: 'Read', state: { status: 'pending' } },
      }),
      makeEvent('message.part.updated', {
        part: { type: 'tool', tool: 'Read', state: { status: 'completed', title: 'read x' } },
      }),
      makeEvent('message.updated', { info: { role: 'assistant', finish: 'stop' } }),
    ];
    setSdkStub(fakeSdk(events));
    const agent = opencodeRunner.opencodeBackend().createAgentSession();
    const onEvent = vi.fn();
    await agent.run({ userText: 'q', systemPrompt: 's', onEvent });

    const toolEvents = onEvent.mock.calls.map((c) => c[0]).filter((e) => /tool/.test(e.type));
    expect(toolEvents).toEqual([
      { type: 'tool_start', tool: 'Read', summary: '' },
      { type: 'tool_end', tool: 'Read', summary: 'read x', ok: true },
    ]);
  });

  it('maps tool error status into tool_end ok:false', async () => {
    const events = [
      makeEvent('message.part.updated', {
        part: { type: 'tool', tool: 'Grep', state: { status: 'error', error: 'boom' } },
      }),
      makeEvent('message.updated', { info: { role: 'assistant', finish: 'stop' } }),
    ];
    setSdkStub(fakeSdk(events));
    const agent = opencodeRunner.opencodeBackend().createAgentSession();
    const onEvent = vi.fn();
    await agent.run({ userText: 'q', systemPrompt: 's', onEvent });
    const end = onEvent.mock.calls.map((c) => c[0]).find((e) => e.type === 'tool_end');
    expect(end).toEqual({ type: 'tool_end', tool: 'Grep', summary: 'boom', ok: false });
  });

  it('abort: signal.abort() triggers client.session.abort and run resolves with aborted', async () => {
    // Long stream; abort mid-flight.
    const events = [
      makeEvent('message.part.delta', { field: 'text', delta: 'partial' }),
      // intentionally no finish:stop — abort must end the run
    ];
    const stub = fakeSdk(events);
    setSdkStub(stub);
    const agent = opencodeRunner.opencodeBackend().createAgentSession();
    const controller = new AbortController();
    const onEvent = vi.fn();

    const runP = agent.run({
      userText: 'q', systemPrompt: 's', onEvent, signal: controller.signal,
    });
    // give the pump a tick to consume the delta, then abort
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    const res = await runP;

    expect(stub.client.session.abort).toHaveBeenCalled();
    expect(res.stopReason).toBe('aborted');
    expect(res.text).toBe('partial');
  });

  it('pump ignores plugin.added / catalog.updated / session.idle noise events', async () => {
    const events = [
      makeEvent('plugin.added', {}),
      makeEvent('catalog.updated', {}),
      makeEvent('session.idle', {}),
      makeEvent('message.part.delta', { field: 'text', delta: 'ok' }),
      makeEvent('message.updated', { info: { role: 'assistant', finish: 'stop' } }),
    ];
    setSdkStub(fakeSdk(events));
    const agent = opencodeRunner.opencodeBackend().createAgentSession();
    const onEvent = vi.fn();
    const res = await agent.run({ userText: 'q', systemPrompt: 's', onEvent });
    const types = onEvent.mock.calls.map((c) => c[0].type);
    expect(types).toEqual(['text_delta']);
    expect(res.text).toBe('ok');
  });

  it('finish:"tool-calls" does NOT stop the pump (only finish:"stop" does)', async () => {
    const events = [
      makeEvent('message.part.delta', { field: 'text', delta: 'before' }),
      makeEvent('message.updated', { info: { role: 'assistant', finish: 'tool-calls' } }),
      makeEvent('message.part.delta', { field: 'text', delta: ' after' }),
      makeEvent('message.updated', { info: { role: 'assistant', finish: 'stop' } }),
    ];
    setSdkStub(fakeSdk(events));
    const agent = opencodeRunner.opencodeBackend().createAgentSession();
    const onEvent = vi.fn();
    const res = await agent.run({ userText: 'q', systemPrompt: 's', onEvent });
    const deltas = onEvent.mock.calls.map((c) => c[0]).filter((e) => e.type === 'text_delta');
    expect(deltas).toEqual([
      { type: 'text_delta', text: 'before' },
      { type: 'text_delta', text: ' after' },
    ]);
    expect(res.text).toBe('before after');
    expect(res.stopReason).toBe('end_turn');
  });

  it('ignores events for other opencode sessions (sessionID mismatch)', async () => {
    const events = [
      makeEvent('message.part.delta', {
        sessionID: 'ses_OTHER', field: 'text', delta: 'x',
      }),
      makeEvent('message.part.delta', {
        sessionID: 'ses_fake', field: 'text', delta: 'y',
      }),
      makeEvent('message.updated', {
        sessionID: 'ses_fake', info: { role: 'assistant', finish: 'stop' },
      }),
    ];
    setSdkStub(fakeSdk(events));
    const agent = opencodeRunner.opencodeBackend().createAgentSession();
    const onEvent = vi.fn();
    const res = await agent.run({ userText: 'q', systemPrompt: 's', onEvent });
    expect(res.text).toBe('y');
  });

  it('session.error event rejects the run', async () => {
    const events = [
      makeEvent('session.error', { error: { message: 'provider down' } }),
    ];
    setSdkStub(fakeSdk(events));
    const agent = opencodeRunner.opencodeBackend().createAgentSession();
    const onEvent = vi.fn();
    await expect(
      agent.run({ userText: 'q', systemPrompt: 's', onEvent }),
    ).rejects.toThrow(/provider down/);
  });

  it('disposes by calling session.delete', async () => {
    const events = [
      makeEvent('message.part.delta', { field: 'text', delta: 'hi' }),
      makeEvent('message.updated', { info: { role: 'assistant', finish: 'stop' } }),
    ];
    const stub = fakeSdk(events);
    setSdkStub(stub);
    const agent = opencodeRunner.opencodeBackend().createAgentSession();
    await agent.run({ userText: 'q', systemPrompt: 's', onEvent: () => {} });
    agent.dispose();
    expect(stub.client.session.delete).toHaveBeenCalled();
  });
});
