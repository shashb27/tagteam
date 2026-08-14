// opencode SDK backend (@opencode-ai/sdk). Primary path: spins up an
// in-process opencode server (or talks to an external one) and streams
// session.prompt events into TagTeam's onEvent interface.
//
// Event mapping per docs/implementation/spike-opencode-sse.md §7:
//   message.part.delta  (field:"text")     → text_delta
//   message.part.updated part.type:"tool"
//     state.status:"pending"               → tool_start (summary '')
//     state.status:"running"               → tool_start (summary = JSON(input))
//     state.status:"completed"             → tool_end   (ok:true)
//     state.status:"error"                 → tool_end   (ok:false)
//   message.updated info.role:"assistant"
//     info.finish:"stop"                   → resolve run (end_turn)
//     info.finish:"tool-calls"             → continue (another step follows)
//
// Critical SDK gotchas (spike §0, §9):
//   - createOpencode({ port: 0 }) returns { client, server }. Use client for
//     calls; keep server for teardown.
//   - Every SDK call returns { data, request, response }. Use .data.id,
//     .data.at(-1), etc. — NOT bare .id.
//   - message.part.delta is a runtime event type NOT in the SDK TS union;
//     switch on ev.type === 'message.part.delta' at runtime.
//   - session.abort() returns { data: boolean }; the in-flight prompt()
//     rejects with MessageAbortedError — swallow it.

import {
  OPENCODE_PORT, OPENCODE_BASE_URL, OPENCODE_MODEL, OPENCODE_PROVIDER,
} from '../config.js';

// opencode enforces the tool allowlist server-side. The value is a map of
// tool name → bool (per SessionPromptData.body.tools in the SDK types).
const ALLOWED_TOOLS = { Read: true, Grep: true, Glob: true };

// Shared opencode client + (optional) in-process server. Created once on
// first use and reused across TagTeam sessions (spike §9.8: one opencode
// session per TagTeam session, but one server for the process).
let _shared = null;
let _sharedPromise = null;

async function getOpencodeClient() {
  if (_shared) return _shared;
  if (!_sharedPromise) _sharedPromise = _createShared();
  _shared = await _sharedPromise;
  return _shared;
}

async function _createShared() {
  if (OPENCODE_BASE_URL) {
    // External server — just build a client.
    const { createOpencodeClient } = await import('@opencode-ai/sdk');
    const client = createOpencodeClient({ baseUrl: OPENCODE_BASE_URL });
    return { client, server: null, ownsServer: false };
  }
  // In-process server on a random free port.
  const { createOpencode } = await import('@opencode-ai/sdk');
  const { client, server } = await createOpencode({ port: OPENCODE_PORT || 0 });
  // Best-effort teardown on process exit.
  const close = () => { try { server.close(); } catch { /* ignore */ } };
  process.once('exit', close);
  process.once('SIGINT', () => { close(); process.exit(0); });
  process.once('SIGTERM', () => { close(); process.exit(0); });
  return { client, server, ownsServer: true };
}

// Event types we care about; everything else is ignored (spike §6/§8).
const ALLOWED_EVENT_TYPES = new Set([
  'message.part.delta',
  'message.part.updated',
  'message.updated',
  'session.status',
  'session.error',
]);

class OpencodeAgentSession {
  constructor() {
    this.client = null;
    this.opencodeSessionId = null;
    this.eventsStream = null;
    this.disposed = false;

    this._onEvent = null;
    this._resolveRun = null;
    this._rejectRun = null;
    this._accumulated = '';
    this._done = false;
    this._aborted = false;
    this._promptP = null;
  }

  async run({ userText, systemPrompt, onEvent, signal }) {
    if (this.disposed) throw new Error('OpencodeAgentSession disposed');
    this._onEvent = onEvent;
    this._accumulated = '';
    this._done = false;
    this._aborted = false;

    if (!this.opencodeSessionId) {
      await this._initSession();
    }

    // Abort wiring.
    const onAbort = () => {
      if (this._done) return;
      this._aborted = true;
      // Best-effort abort on the opencode session; swallow errors.
      this.client?.session
        ?.abort({ path: { id: this.opencodeSessionId } })
        ?.catch(() => {});
      this._finish({ stopReason: 'aborted' });
    };
    if (signal) {
      if (signal.aborted) { onAbort(); return { text: '', stopReason: 'aborted' }; }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    // Drive the run to completion via the pump; the prompt promise is a
    // backstop. The pump resolves `_finish` on `finish:"stop"`.
    const runDone = new Promise((res, rej) => {
      this._resolveRun = res;
      this._rejectRun = rej;
    });

    // Kick off the prompt. Swallow the abort rejection; surface other errors.
    this._promptP = this.client.session
      .prompt({
        path: { id: this.opencodeSessionId },
        body: {
          system: systemPrompt,
          parts: [{ type: 'text', text: userText }],
          tools: ALLOWED_TOOLS,
          ...(this._modelBody()),
        },
        // M0: opencode needs a real project workspace; M1 will confine to a sandboxed demo project.
        query: { directory: process.env.OPENCODE_CWD || process.cwd() },
      })
      .catch((err) => {
        if (this._aborted || this._done) return; // swallow abort
        this._finishWithError(err);
      });

    try {
      return await runDone;
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  _modelBody() {
    if (OPENCODE_MODEL && OPENCODE_PROVIDER) {
      return { model: { providerID: OPENCODE_PROVIDER, modelID: OPENCODE_MODEL } };
    }
    return {};
  }

  async _initSession() {
    const { client } = await getOpencodeClient();
    this.client = client;
    // M0: opencode needs a real project workspace; M1 will confine to a sandboxed demo project.
    const workspaceCwd = process.env.OPENCODE_CWD || process.cwd();
    const created = await client.session.create({
      body: { title: 'tagteam' },
      query: { directory: workspaceCwd },
    });
    // SDK wraps responses as { data, request, response } — use .data.id.
    this.opencodeSessionId = created?.data?.id ?? created?.id;
    if (!this.opencodeSessionId) {
      throw new Error('opencode session.create returned no session id');
    }
    const sub = await client.event.subscribe();
    this.eventsStream = sub.stream;
    // Background pump; errors propagate via _rejectRun.
    this._pumpLoop().catch((err) => {
      if (!this._done) this._finishWithError(err);
    });
  }

  async _pumpLoop() {
    for await (const ev of this.eventsStream) {
      if (this.disposed || this._done) break;
      if (!ALLOWED_EVENT_TYPES.has(ev.type)) continue;
      const props = ev.properties || {};
      // Global event stream: ignore events for other opencode sessions.
      if (props.sessionID && this.opencodeSessionId &&
          props.sessionID !== this.opencodeSessionId) continue;
      this._handleEvent(ev, props);
      if (this._done) break;
    }
  }

  _handleEvent(ev, props) {
    const onEvent = this._onEvent;
    if (!onEvent) return;

    if (ev.type === 'message.part.delta') {
      if (props.field === 'text' && typeof props.delta === 'string') {
        this._accumulated += props.delta;
        onEvent({ type: 'text_delta', text: props.delta });
      }
      return;
    }

    if (ev.type === 'message.part.updated') {
      const part = props.part;
      if (!part || part.type !== 'tool') return;
      const status = part.state?.status;
      if (status === 'pending') {
        onEvent({ type: 'tool_start', tool: part.tool, summary: '' });
      } else if (status === 'running') {
        // Optional: surface the tool input as the summary.
        try {
          onEvent({ type: 'tool_start', tool: part.tool, summary: JSON.stringify(part.state.input) });
        } catch {
          onEvent({ type: 'tool_start', tool: part.tool, summary: '' });
        }
      } else if (status === 'completed') {
        onEvent({ type: 'tool_end', tool: part.tool, summary: part.state?.title || '', ok: true });
      } else if (status === 'error') {
        onEvent({ type: 'tool_end', tool: part.tool, summary: part.state?.error || '', ok: false });
      }
      return;
    }

    if (ev.type === 'message.updated') {
      const info = props.info;
      if (info?.role === 'assistant') {
        if (info.finish === 'stop') {
          this._finish({ stopReason: 'end_turn' });
        } else if (info.finish === 'tool-calls') {
          // Another step follows — keep the pump running.
        }
      }
      return;
    }

    if (ev.type === 'session.status') {
      // Transient provider retry — log, do not throw (spike §9.6).
      if (props.status?.type === 'retry') {
        console.warn('[opencode] provider retry:', props.status.message ?? '');
      }
      return;
    }

    if (ev.type === 'session.error') {
      this._finishWithError(new Error(props.error?.message || 'opencode session error'));
      return;
    }
  }

  _finish({ stopReason }) {
    if (this._done) return;
    this._done = true;
    const text = this._accumulated;
    this._onEvent = null;
    this._resolveRun?.({ text, stopReason });
  }

  _finishWithError(err) {
    if (this._done) return;
    this._done = true;
    this._onEvent = null;
    this._rejectRun?.(err);
  }

  dispose() {
    // Best-effort: delete the opencode session. Safe to call twice.
    this.disposed = true;
    const id = this.opencodeSessionId;
    const client = this.client;
    if (client && id) {
      try {
        client.session.delete?.({ path: { id } })?.catch(() => {});
      } catch { /* ignore */ }
    }
    this.opencodeSessionId = null;
    this._onEvent = null;
  }
}

export function opencodeBackend() {
  return {
    name: 'opencode',
    assistantName: OPENCODE_MODEL || 'Assistant',
    hasTools: true,
    createAgentSession() {
      return new OpencodeAgentSession();
    },
  };
}
