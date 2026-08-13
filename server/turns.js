// Turn engine: one assistant run at a time per session, FIFO batching of user
// messages, delta coalescing, and the §8.5 prompt/context assembly.

import {
  DELTA_FLUSH_BYTES, DELTA_FLUSH_MS, RUN_TIMEOUT_MS, MAX_PENDING_MESSAGES,
} from './config.js';
import { appendMessage, broadcast, getSession, touch } from './sessions.js';
import { noteError } from './observe.js';

let backend = null;

export function setBackend(b) {
  backend = b;
}

export function backendInfo() {
  return backend
    ? { name: backend.name, assistantName: backend.assistantName }
    : { name: 'none', assistantName: 'Assistant' };
}

// ---------------------------------------------------------------------------
// Prompt assembly (architecture doc §8.5)

export function buildSystemPrompt(session) {
  const roster = [...session.participants.values()]
    .filter((p) => p.status !== 'kicked')
    .map((p) => `- ${p.name} (${p.role})`)
    .join('\n');

  let prompt = `You are the opencode agent inside TagTeam, a shared multiplayer session where several people
collaborate with you in one live conversation.

People currently in the room:
${roster}

Every human message is prefixed with the speaker's name in brackets, e.g. "[Sam]: ...".
Address people by name when you answer, especially when different people asked different
things. Never invent statements from participants. If a request needs input from a specific
person in the room, ask them directly by name.`;

  if (backend?.hasTools) {
    prompt += `\n
You may use read-only tools to consult files in your workspace. Never modify anything.`;
  }
  return prompt;
}

export function composeUserTurn(session, batch) {
  const parts = [];
  if (session.rosterNotes.length > 0) {
    for (const note of session.rosterNotes) parts.push(`(Note: ${note})`);
    session.rosterNotes = [];
  }
  for (const m of batch) {
    parts.push(`[${m.authorName}]: ${m.text}`);
  }
  return parts.join('\n\n');
}

export function noteRosterChange(session, note) {
  session.rosterNotes.push(note);
}

// ---------------------------------------------------------------------------
// Delta coalescing (architecture doc §9)

function scheduleFlush(session) {
  const run = session.activeRun;
  if (!run || run.flushTimer) return;
  run.flushTimer = setTimeout(() => {
    run.flushTimer = null;
    flushDeltas(session);
  }, DELTA_FLUSH_MS);
}

/**
 * Flush any buffered assistant text as one assistant_delta frame. Called by
 * the coalescer, at run completion, and synchronously before building a
 * `joined` snapshot (so a snapshot's partial text exactly equals all flushed
 * deltas and no text is ever double-delivered).
 */
export function flushDeltas(session) {
  const run = session.activeRun;
  if (!run || run.buffer.length === 0) return;
  const delta = run.buffer;
  run.buffer = '';
  if (run.flushTimer) {
    clearTimeout(run.flushTimer);
    run.flushTimer = null;
  }
  broadcast(session, {
    type: 'assistant_delta',
    messageId: run.messageId,
    index: run.deltaIndex++,
    delta,
  });
}

// ---------------------------------------------------------------------------
// Run lifecycle (architecture doc §7)

export function pendingIsFull(session) {
  return session.pendingUserMessages.length >= MAX_PENDING_MESSAGES;
}

/** Accepted user message → queue it and start a run if idle. */
export function enqueueUserMessage(session, message) {
  session.pendingUserMessages.push(message);
  if (session.activeRun === null) {
    startRun(session).catch((err) => {
      console.error(`[turns] startRun crashed for session ${session.id}:`, err);
    });
  }
}

function friendlyError(err) {
  if (err?.userMessage) return err.userMessage;
  const status = err?.status;
  if (status === 401 || status === 403) return 'The assistant API key is invalid on the server.';
  if (status === 429) return 'The assistant is rate-limited; wait a moment and resend.';
  if (typeof status === 'number' && status >= 500) {
    return 'The assistant is temporarily overloaded; resend your message.';
  }
  if (err?.name === 'AbortError' || /abort/i.test(String(err?.message ?? ''))) {
    return 'The assistant took too long and was stopped.';
  }
  if (/connection|network|fetch failed/i.test(String(err?.message ?? ''))) {
    return 'Connection to the assistant dropped mid-answer.';
  }
  return 'The assistant request failed. Try again.';
}

async function startRun(session) {
  const batch = session.pendingUserMessages.splice(0);
  if (batch.length === 0) return;

  const assistantMessage = appendMessage(session, {
    role: 'assistant',
    authorId: 'assistant',
    authorName: backend?.assistantName ?? 'Assistant',
    text: '',
    streaming: true,
    toolEvents: [],
  });

  const abortController = new AbortController();
  session.activeRun = {
    messageId: assistantMessage.id,
    abortController,
    deltaIndex: 0,
    flushTimer: null,
    buffer: '',
  };

  broadcast(session, {
    type: 'assistant_start',
    message: {
      id: assistantMessage.id,
      seq: assistantMessage.seq,
      role: 'assistant',
      authorId: assistantMessage.authorId,
      authorName: assistantMessage.authorName,
      text: '',
      ts: assistantMessage.ts,
      streaming: true,
      toolEvents: [],
    },
    inReplyTo: batch.map((m) => m.id),
  });

  const systemPrompt = buildSystemPrompt(session);
  const userText = composeUserTurn(session, batch);
  const timeout = setTimeout(() => abortController.abort(), RUN_TIMEOUT_MS);

  const onEvent = (evt) => {
    // The session may have been GC'd mid-stream.
    const live = getSession(session.id);
    if (!live || live.activeRun?.messageId !== assistantMessage.id) return;
    if (evt.type === 'text_delta') {
      assistantMessage.text += evt.text;
      session.activeRun.buffer += evt.text;
      if (session.activeRun.buffer.length >= DELTA_FLUSH_BYTES) flushDeltas(session);
      else scheduleFlush(session);
    } else if (evt.type === 'tool_start') {
      broadcast(session, {
        type: 'tool_activity',
        messageId: assistantMessage.id,
        phase: 'start',
        tool: evt.tool,
        summary: evt.summary,
      });
    } else if (evt.type === 'tool_end') {
      assistantMessage.toolEvents.push({
        tool: evt.tool, summary: evt.summary, ok: evt.ok, ts: Date.now(),
      });
      broadcast(session, {
        type: 'tool_activity',
        messageId: assistantMessage.id,
        phase: 'end',
        tool: evt.tool,
        summary: evt.summary,
        ok: evt.ok,
      });
    }
  };

  try {
    if (session.agent === null) {
      session.agent = backend.createAgentSession({ sessionId: session.id });
    }
    const result = await session.agent.run({
      userText,
      systemPrompt,
      onEvent,
      signal: abortController.signal,
    });

    if (abortController.signal.aborted) {
      // Timeout path — treated as failure per §7.
      throw Object.assign(new Error('run timed out'), {
        userMessage: 'The assistant took too long and was stopped.',
      });
    }

    flushDeltas(session);
    assistantMessage.text = result.text ?? assistantMessage.text;
    assistantMessage.streaming = false;
    broadcast(session, {
      type: 'assistant_complete',
      messageId: assistantMessage.id,
      text: assistantMessage.text,
      stopReason: result.stopReason ?? 'end_turn',
    });
  } catch (err) {
    console.error(`[turns] run failed for session ${session.id}:`, err);
    noteError();
    flushDeltas(session);
    assistantMessage.streaming = false;
    broadcast(session, {
      type: 'assistant_error',
      messageId: assistantMessage.id,
      message: friendlyError(err),
    });
    // Every assistant_start is closed by exactly one assistant_complete; the
    // partial text stays in the transcript, the error text is not appended.
    broadcast(session, {
      type: 'assistant_complete',
      messageId: assistantMessage.id,
      text: assistantMessage.text,
      stopReason: 'error',
    });
  } finally {
    clearTimeout(timeout);
    if (session.activeRun?.flushTimer) clearTimeout(session.activeRun.flushTimer);
    session.activeRun = null;
    touch(session);
    // Drain messages queued during the run.
    if (getSession(session.id) && session.pendingUserMessages.length > 0) {
      startRun(session).catch((err2) => {
        console.error(`[turns] drain startRun crashed for session ${session.id}:`, err2);
      });
    }
  }
}
