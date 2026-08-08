// Messages API backend (@anthropic-ai/sdk, streaming). Used when the Agent
// SDK is unavailable and ANTHROPIC_API_KEY is set. No tools — pure chat
// behind the same internal interface (architecture doc §8.4).

import Anthropic from '@anthropic-ai/sdk';
import { MODEL } from '../config.js';

class ApiAgentSession {
  constructor(client) {
    this.client = client;
    this.history = []; // [{role: "user"|"assistant", content: string}]
    this.disposed = false;
  }

  async run({ userText, systemPrompt, onEvent, signal }) {
    this.history.push({ role: 'user', content: userText });

    const stream = this.client.messages.stream(
      {
        model: MODEL,
        max_tokens: 4096, // demo-sane cap (architecture §8.4)
        system: systemPrompt,
        messages: this.history,
      },
      { signal },
    );
    stream.on('text', (t) => onEvent({ type: 'text_delta', text: t }));

    const final = await stream.finalMessage();

    if (final.stop_reason === 'refusal') {
      // Keep the user turn in history (consecutive user turns are merged by
      // the API on the next run) and surface a clean failure.
      const err = new Error('Claude declined to answer that request.');
      err.userMessage = 'Claude declined to answer that request.';
      throw err;
    }

    const text = final.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
    this.history.push({ role: 'assistant', content: text });
    return {
      text,
      stopReason: final.stop_reason === 'max_tokens' ? 'max_tokens' : 'end_turn',
    };
  }

  dispose() {
    this.disposed = true;
    this.history = [];
  }
}

export function apiBackend() {
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment
  return {
    name: 'api',
    assistantName: 'Claude',
    hasTools: false,
    createAgentSession() {
      return new ApiAgentSession(client);
    },
  };
}
