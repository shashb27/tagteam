// MOCK Claude provider — last-resort backend so the multiplayer demo always
// runs with zero credentials. Streams a plausible canned response word by
// word. Clearly labeled: the assistant is named "Claude (mock)" and every
// response starts with a "[mock ...]" marker in the transcript.

const CANNED = [
  `Based on the shortlist we discussed, the three viable TPU options are the v5e reserved pods, the on-demand v5p slices, and the partner-resale route. The v5e reservation is the cheapest per chip-hour but needs a 12-month commit, while v5p on-demand gives the most flexibility for benchmarking spikes.`,
  `From an IT standpoint the main blockers are the vendor portal firewall exception and the procurement approval chain. The portal needs outbound 443 to the vendor's allowlisted domains, and quota increases have to be filed before the purchase order, not after.`,
  `Good question. The budget line covers the pilot cluster only, so anything beyond eight accelerators needs a separate approval. I'd suggest locking the pilot config first, then sizing the follow-on order from the benchmark numbers.`,
];

function lastSpeaker(userText) {
  const matches = [...String(userText ?? '').matchAll(/\[([^\]]+)\]:/g)];
  return matches.length > 0 ? matches[matches.length - 1][1] : null;
}

class MockAgentSession {
  constructor() {
    this.turn = 0;
  }

  async run({ userText, onEvent, signal }) {
    const name = lastSpeaker(userText);
    const body = CANNED[this.turn % CANNED.length];
    this.turn += 1;
    const greeting = name ? `${name}, here's my take. ` : '';
    const text =
      `[mock response — no Claude credentials configured, streaming canned text] ` +
      `${greeting}${body}`;

    const words = text.split(/(\s+)/).filter((w) => w.length > 0);
    let emitted = '';
    for (const word of words) {
      if (signal?.aborted) {
        return { text: emitted, stopReason: 'aborted' };
      }
      onEvent({ type: 'text_delta', text: word });
      emitted += word;
      // ~25ms per token keeps the streaming UI demo-visible.
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return { text, stopReason: 'end_turn' };
  }

  dispose() {
    // Nothing to clean up; safe to call twice.
  }
}

export function mockBackend() {
  return {
    name: 'mock',
    assistantName: 'Claude (mock)',
    hasTools: false,
    createAgentSession() {
      return new MockAgentSession();
    },
  };
}
