import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mockBackend } from '../../server/agent/mockRunner.js';

const origEnv = { ...process.env };

beforeEach(() => {
  delete process.env.MOCK_CLAUDE;
});

afterEach(() => {
  process.env = { ...origEnv };
});

describe('mockBackend', () => {
  it('returns the expected static shape', () => {
    const b = mockBackend();
    expect(b).toMatchObject({
      name: 'mock', assistantName: 'Assistant (mock)', hasTools: false,
    });
    expect(typeof b.createAgentSession).toBe('function');
  });
});

describe('MockAgentSession.run (via mockBackend().createAgentSession())', () => {
  // The mock streams ~25ms per word; canned responses are ~100 words (~2.5s).
  const SLOW = { timeout: 20_000 };

  it('streams canned text word-by-word via text_delta', SLOW, async () => {
    const agent = mockBackend().createAgentSession();
    const events = [];
    const res = await agent.run({
      userText: '[Sam]: hi',
      onEvent: (e) => events.push(e),
      signal: undefined,
    });
    expect(events.every((e) => e.type === 'text_delta')).toBe(true);
    expect(events.map((e) => e.text).join('')).toBe(res.text);
    expect(res.stopReason).toBe('end_turn');
  });

  it('canned text includes the [mock response] prefix', SLOW, async () => {
    const agent = mockBackend().createAgentSession();
    const res = await agent.run({ userText: '[Sam]: hi', onEvent() {} });
    expect(res.text).toMatch(/\[mock response/);
  });

  it('derives the [Name] greeting from the last [Name]: in userText', SLOW, async () => {
    const agent = mockBackend().createAgentSession();
    const res = await agent.run({
      userText: '[Alice]: q1\n\n[Bob]: q2',
      onEvent() {},
    });
    expect(res.text).toMatch(/Bob, here's my take\./);
    expect(res.text).not.toMatch(/Alice, here's my take\./);
  });

  it('omits the greeting when no [Name]: is present', SLOW, async () => {
    const agent = mockBackend().createAgentSession();
    const res = await agent.run({ userText: 'plain text', onEvent() {} });
    expect(res.text).not.toMatch(/here's my take\./);
  });

  it('advances canned text across turns', SLOW, async () => {
    const agent = mockBackend().createAgentSession();
    const a = await agent.run({ userText: '[Sam]: 1', onEvent() {} });
    const b = await agent.run({ userText: '[Sam]: 2', onEvent() {} });
    expect(a.text).not.toBe(b.text);
  });

  it('respects an aborted signal', SLOW, async () => {
    const agent = mockBackend().createAgentSession();
    const controller = new AbortController();
    const events = [];
    const res = await agent.run({
      userText: '[Sam]: hi',
      onEvent: (e) => {
        events.push(e);
        controller.abort();
      },
      signal: controller.signal,
    });
    expect(res.stopReason).toBe('aborted');
    expect(events.length).toBeLessThan(50);
  });

  it('dispose is a no-op and safe to call twice', () => {
    const agent = mockBackend().createAgentSession();
    expect(() => { agent.dispose(); agent.dispose(); }).not.toThrow();
  });
});

describe('createAgentBackend (MOCK_CLAUDE=1 path)', () => {
  it('returns the mock backend when MOCK_CLAUDE=1', async () => {
    process.env.MOCK_CLAUDE = '1';
    vi.resetModules();
    const { createAgentBackend } = await import('../../server/agent/index.js');
    const b = await createAgentBackend();
    expect(b.name).toBe('mock');
    expect(b.assistantName).toBe('Assistant (mock)');
    expect(b.hasTools).toBe(false);
  });

  it('falls back to mock when the opencode backend throws', async () => {
    delete process.env.MOCK_CLAUDE;
    vi.resetModules();
    vi.doMock('../../server/agent/opencodeRunner.js', () => ({
      opencodeBackend: async () => { throw new Error('sdk unavailable'); },
    }));
    const { createAgentBackend } = await import('../../server/agent/index.js');
    const b = await createAgentBackend();
    expect(b.name).toBe('mock');
    vi.doUnmock('../../server/agent/opencodeRunner.js');
    vi.resetModules();
  });
});
