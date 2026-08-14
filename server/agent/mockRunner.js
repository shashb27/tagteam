// MOCK backend — last-resort provider so the multiplayer demo always runs
// with zero credentials. Streams a plausible canned response word by word.
// Clearly labeled: the assistant is named "Assistant (mock)" and every
// response starts with a "[mock ...]" marker in the transcript.

const CANNED = [
  `I compared the five kernels in kernel-profile.md against the AXB-200 numbers in board-specs.md. Four look healthy: gemm_fp16 hits 2,720 GB/s (85% of the 3,200 GB/s peak), attention_qkv reaches 2,460 GB/s, and layernorm and softmax_scale are fine for elementwise work. The clear outlier is kv_cache_gather: 704 GB/s — just 22% of peak — at 31% occupancy and 2.85 ms latency versus a ~0.65 ms roofline estimate. The dma_unaligned_fallback counter fires on 97% of its reads, and board-specs.md says unaligned DMA reads silently drop to a slow scalar path. Per hw-constraints.md, anything touching DMA alignment needs a hardware architect's sign-off — this is the one that needs hardware input.`,
  `Yes, this matches errata E7 in hw-constraints.md exactly. The KV cache moved to a 160-byte per-token stride in the 2026-07-30 build, and the AXB-200 DMA engine requires 256-byte-aligned source addresses; misaligned reads split into 32-byte scalar transactions, which explains the 3-4x bandwidth loss down to 704 GB/s. Two options: pad each KV entry from 160 to 256 bytes, which restores the fast DMA path but grows that region's HBM footprint by about 60% within the 96 GB budget, or enable the experimental gather-scatter DMA mode — but hw-constraints.md lists that mode as unvalidated silicon that requires your sign-off, with known interaction risks against E7.`,
  `Given those constraints, I'd start with the 256-byte padding: it's a pure software change, it's the documented E7 workaround, and at the batch-32 / 4K-sequence config the extra KV footprint still fits in the 96 GB of HBM. Hold the gather-scatter DMA mode as a follow-up experiment once hardware validates it — hw-constraints.md requires architect sign-off before it can ship. A quick A/B on kv_cache_gather with padded entries should show latency dropping from 2.85 ms back toward the ~0.65 ms roofline estimate, and the dma_unaligned_fallback counter should go quiet.`,
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
      `[mock response — no opencode provider configured, streaming canned text] ` +
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
    assistantName: 'Assistant (mock)',
    hasTools: false,
    createAgentSession() {
      return new MockAgentSession();
    },
  };
}
