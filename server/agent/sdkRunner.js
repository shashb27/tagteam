// Claude Agent SDK backend (@anthropic-ai/claude-agent-sdk). Primary path:
// runs on the local Claude Code CLI credentials, so it can work with NO
// ANTHROPIC_API_KEY. Read-only tool allowlist; cwd pinned to demo-workspace.
// Mapping rules per architecture doc §8.3.

import path from 'node:path';
import { DEMO_WORKSPACE_DIR, MODEL, MODEL_EXPLICIT } from '../config.js';

// Security posture (security design §7.1, hardened): read-only tools only, no
// network egress tools (WebSearch/WebFetch would give a prompt-injected guest
// an exfiltration channel for anything Read managed to see). Grep over
// demo-workspace satisfies the brief's "search".
//
// IMPORTANT: ALLOWED_TOOLS is enforced ONLY inside makeCanUseTool(), never
// passed as the SDK `allowedTools` option. Listing a tool in `allowedTools`
// makes the Agent SDK auto-approve it BEFORE canUseTool is consulted, which
// would skip the demo-workspace path confinement entirely (verified against
// SDK 0.3.226). run() therefore passes allowedTools: [] so every tool call
// hits the canUseTool gate.
const ALLOWED_TOOLS = ['Read', 'Grep', 'Glob'];
const DISALLOWED_TOOLS = [
  'Write', 'Edit', 'Bash', 'NotebookEdit', 'TodoWrite', 'Task',
  'WebSearch', 'WebFetch',
];

/**
 * Permission gate: default-deny anything not in ALLOWED_TOOLS, and confine
 * Read/Grep/Glob to DEMO_WORKSPACE_DIR by resolving their path-like inputs.
 * This is the SOLE enforcement layer: with allowedTools: [] every tool call
 * reaches this gate, so both WHICH tools run and which PATHS they touch are
 * decided here.
 */
function makeCanUseTool() {
  const root = path.resolve(DEMO_WORKSPACE_DIR);
  const inside = (p) => {
    const resolved = path.resolve(root, String(p));
    return resolved === root || resolved.startsWith(root + path.sep);
  };
  return async (toolName, input) => {
    if (!ALLOWED_TOOLS.includes(toolName)) {
      return { behavior: 'deny', message: `Tool ${toolName} is not allowed in TagTeam.` };
    }
    // Path-like inputs across Read/Grep/Glob.
    for (const key of ['file_path', 'path', 'cwd']) {
      if (input?.[key] !== undefined && !inside(input[key])) {
        return {
          behavior: 'deny',
          message: 'Access outside the demo workspace is not allowed.',
        };
      }
    }
    return { behavior: 'allow', updatedInput: input };
  };
}

function truncate(str, n = 80) {
  const s = String(str ?? '');
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function toolSummary(toolName, input) {
  const primary =
    input?.file_path ?? input?.pattern ?? input?.query ?? input?.url ?? input?.path ?? '';
  return primary ? `${toolName}: ${truncate(primary)}` : `${toolName}`;
}

class SdkAgentSession {
  constructor(sdk) {
    this.sdk = sdk;
    this.sdkSessionId = null;
    this.disposed = false;
  }

  async run({ userText, systemPrompt, onEvent, signal }) {
    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    if (signal) {
      if (signal.aborted) abortController.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    // Per-block tool_use tracking so tool_start/tool_end can be paired.
    const blocksByIndex = new Map(); // stream index -> {id, name, inputJson}
    const toolsById = new Map();     // tool_use_id -> {name, summary, started}
    let streamedText = '';
    let resultText = null;
    let resultSubtype = null;

    const emitToolStart = (id, name, input) => {
      const summary = toolSummary(name, input);
      const existing = toolsById.get(id);
      if (existing?.started) return;
      toolsById.set(id, { name, summary, started: true });
      onEvent({ type: 'tool_start', tool: name, summary });
    };

    try {
      const options = {
        systemPrompt,
        resume: this.sdkSessionId ?? undefined,
        // allowedTools MUST stay [] — a tool listed here is auto-approved by
        // the SDK before canUseTool runs, bypassing the path confinement.
        allowedTools: [],
        disallowedTools: DISALLOWED_TOOLS,
        // 'default' (not bypassPermissions) so permission checks stay active;
        // canUseTool answers them programmatically — default-deny + path
        // confinement to demo-workspace.
        permissionMode: 'default',
        canUseTool: makeCanUseTool(),
        cwd: DEMO_WORKSPACE_DIR,
        maxTurns: 8,
        includePartialMessages: true,        // required for token streaming
        abortController,
      };
      if (MODEL_EXPLICIT) options.model = MODEL;

      const q = this.sdk.query({ prompt: userText, options });

      for await (const msg of q) {
        if (msg.type === 'system' && msg.subtype === 'init') {
          this.sdkSessionId = msg.session_id ?? this.sdkSessionId;
          continue;
        }

        if (msg.type === 'stream_event') {
          const event = msg.event;
          if (!event) continue;
          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            streamedText += event.delta.text;
            onEvent({ type: 'text_delta', text: event.delta.text });
          } else if (
            event.type === 'content_block_start' &&
            event.content_block?.type === 'tool_use'
          ) {
            blocksByIndex.set(event.index, {
              id: event.content_block.id,
              name: event.content_block.name,
              inputJson: '',
            });
            if (!toolsById.has(event.content_block.id)) {
              toolsById.set(event.content_block.id, {
                name: event.content_block.name,
                summary: null,
                started: false,
              });
            }
          } else if (
            event.type === 'content_block_delta' &&
            event.delta?.type === 'input_json_delta'
          ) {
            const block = blocksByIndex.get(event.index);
            if (block) block.inputJson += event.delta.partial_json ?? '';
          } else if (event.type === 'content_block_stop') {
            const block = blocksByIndex.get(event.index);
            if (block) {
              blocksByIndex.delete(event.index);
              let input = {};
              try { input = JSON.parse(block.inputJson || '{}'); } catch { /* partial */ }
              emitToolStart(block.id, block.name, input);
            }
          }
          continue;
        }

        if (msg.type === 'assistant') {
          // Never emit text deltas here (already streamed via stream_event);
          // tool_use blocks are the authoritative tool_start fallback.
          const content = msg.message?.content ?? [];
          for (const block of content) {
            if (block.type === 'tool_use') emitToolStart(block.id, block.name, block.input);
          }
          continue;
        }

        if (msg.type === 'user') {
          // Tool results come back as user messages.
          const content = msg.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'tool_result') {
                const info = toolsById.get(block.tool_use_id);
                if (info) {
                  onEvent({
                    type: 'tool_end',
                    tool: info.name,
                    summary: info.summary ?? info.name,
                    ok: block.is_error !== true,
                  });
                }
              }
            }
          }
          continue;
        }

        if (msg.type === 'result') {
          resultSubtype = msg.subtype;
          if (typeof msg.result === 'string') resultText = msg.result;
        }
      }
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
    }

    if (abortController.signal.aborted) {
      return { text: streamedText, stopReason: 'aborted' };
    }
    if (resultSubtype && resultSubtype !== 'success') {
      const err = new Error(`Agent SDK run failed (${resultSubtype})`);
      err.userMessage =
        resultSubtype === 'error_max_turns'
          ? 'Claude hit its tool-use limit for this turn. Try a simpler question.'
          : 'Claude engine error on the server. Try again.';
      throw err;
    }
    // The final result string is authoritative for the complete text.
    return { text: resultText ?? streamedText, stopReason: 'end_turn' };
  }

  dispose() {
    // SDK sessions are files on disk managed by the SDK; nothing to clean
    // for a weekend POC beyond dropping the id. Safe to call twice.
    this.disposed = true;
    this.sdkSessionId = null;
  }
}

export function sdkBackend(sdk) {
  return {
    name: 'sdk',
    assistantName: 'Claude',
    hasTools: true,
    createAgentSession() {
      return new SdkAgentSession(sdk);
    },
  };
}

/**
 * One-shot smoke test: run a trivial query with a hard timeout. Any throw or
 * timeout means the SDK is unusable in this environment (no CLI, no creds…)
 * and the caller falls back.
 */
export async function smokeTest(sdk, timeoutMs) {
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeoutMs);
  try {
    const q = sdk.query({
      prompt: 'Reply with the single word OK.',
      options: {
        maxTurns: 1,
        allowedTools: [],
        disallowedTools: DISALLOWED_TOOLS,
        permissionMode: 'bypassPermissions',
        cwd: DEMO_WORKSPACE_DIR,
        abortController,
      },
    });
    for await (const msg of q) {
      if (msg.type === 'result') {
        if (msg.subtype === 'success') return true;
        throw new Error(`smoke test result: ${msg.subtype}`);
      }
    }
    throw new Error('smoke test ended without a result message');
  } finally {
    clearTimeout(timer);
  }
}
