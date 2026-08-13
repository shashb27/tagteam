# Spike: opencode SDK SSE event shapes

**Task:** 0.8 — confirm exact event shapes emitted by `@opencode-ai/sdk` during a streaming `session.prompt`, so `server/agent/opencodeRunner.js` can map them to TagTeam's `onEvent({type:'text_delta'|'tool_start'|'tool_end'})` interface.

**Confidence:** Confirmed by running. Plan A (in-process `createOpencode({ port: 0 })`) worked end-to-end. Both a text-only prompt and a tool-using prompt were streamed to completion and captured in `scripts/spike-output.txt`.

**SDK version:** `@opencode-ai/sdk@1.18.18`, opencode CLI `v1.18.15`, provider `bigmodel/glm-5.2`.

**Plan that worked:** A (in-process). Plans B/C/D not needed.

---

## 0. Critical SDK gotcha (contradicts M0.md §3)

The SDK wraps every method response as `{ data, request, response }`. The real payload is in `.data`.

```js
const s = await client.session.create({ body: { title: 'tagteam' } });
s.id          // ❌ undefined
s.data.id     // ✅ "ses_..."
```

M0.md §3 shows `this.opencodeSessionId = s.id;` — that is **wrong** and must be `s.data.id` in the adapter. Same unwrapping applies to `session.messages()`, `session.abort()`, etc. **Architect should update M0.md §3.**

Also: `createOpencode({ port: 0 })` returns `{ client, server }` (not a bare `client`). Use `client` for SDK calls and `server.close()` to tear down.

---

## 1. Event stream plumbing

```js
const { client, server } = await createOpencode({ port: 0 });
const session = await client.session.create({ body: { title: 'tagteam' } });
const sessionId = session.data.id;
const events = await client.event.subscribe();      // global event stream
const promptP = client.session.prompt({
  path: { id: sessionId },
  body: { parts: [{ type: 'text', text: userText }] },
});
for await (const ev of events.stream) { /* ev = { id, type, properties } */ }
await promptP;
```

Every event has the shape `{ id: string, type: string, properties: {...} }`. `properties` always carries `sessionID` for session-scoped events.

---

## 2. Confirmed event shapes — text streaming

| opencode `event.type` | `event.properties` keys | TagTeam `onEvent` mapping | Sample JSON |
|---|---|---|---|
| `message.updated` (user msg) | `sessionID`, `info{role:"user",id,...}` | (ignore — echo of input) | `{"type":"message.updated","properties":{"sessionID":"ses_…","info":{"role":"user","id":"msg_…"}}}` |
| `message.part.updated` (text part open) | `sessionID`, `part{type:"text",text:"",time:{start}}` | (ignore — open marker) | `{"type":"message.part.updated","properties":{"sessionID":"ses_…","part":{"type":"text","text":"","time":{"start":…}}}}` |
| **`message.part.delta`** | `sessionID`, `messageID`, `partID`, `field:"text"`, `delta:"<chunk>"` | **`onEvent({type:'text_delta', text: delta})`** | `{"type":"message.part.delta","properties":{"sessionID":"ses_…","messageID":"msg_…","partID":"prt_…","field":"text","delta":"OK"}}` |
| `message.part.updated` (text part close) | `sessionID`, `part{type:"text",text:"<full>",time:{start,end}}` | (optional — full text snapshot) | `{"type":"message.part.updated","properties":{"part":{"type":"text","text":"OK","time":{...}}}}` |
| `message.part.updated` (`step-finish`) | `part{type:"step-finish",reason,tokens,cost}` | (ignore or use for cost accounting) | `{"part":{"type":"step-finish","reason":"stop","tokens":{...},"cost":0}}` |
| **`message.updated` (assistant, finish)** | `sessionID`, `info{role:"assistant",finish:"stop"\|"tool-calls",tokens,cost,...}` | **final/stop signal** | `{"info":{"role":"assistant","finish":"stop","tokens":{...}}}` |

### Reasoning parts (identical delta mechanism)

`message.part.updated` with `part.type:"reasoning"` opens a reasoning part, then `message.part.delta` events stream with `field:"text"`, then a closing `message.part.updated` with the full `part.text`. The adapter can route `reasoning` deltas to `text_delta` too, or drop them — TagTeam's UI doesn't currently surface reasoning separately.

---

## 3. Confirmed event shapes — tool calls

**There is NO separate `tool_start` / `tool_end` event type.** Tool lifecycle is delivered as `message.part.updated` events where `part.type === "tool"`. The `part.state.status` field transitions `pending → running → completed` (or `error`).

| opencode event | `part.state.status` | `part` keys | TagTeam `onEvent` mapping | Sample (abbreviated) |
|---|---|---|---|---|
| `message.part.updated` | `"pending"` | `type:"tool"`, `tool:"glob"`, `callID`, `state:{status:"pending",input:{},raw:""}` | **`onEvent({type:'tool_start', tool:'glob', summary:''})`** | `{"part":{"type":"tool","tool":"glob","callID":"chatcmpl-tool-…","state":{"status":"pending","input":{},"raw":""}}}` |
| `message.part.updated` | `"running"` | `state:{status:"running",input:{...},time:{start}}` | (optional — `tool_start` with input, or ignore) | `{"part":{"type":"tool","tool":"glob","state":{"status":"running","input":{"pattern":"*"},"time":{"start":…}}}}` |
| `message.part.updated` | `"completed"` | `state:{status:"completed",input:{...},output:"<string>",title,metadata,time:{start,end}}` | **`onEvent({type:'tool_end', tool:'glob', summary:title, ok:true})`** | `{"part":{"type":"tool","tool":"glob","state":{"status":"completed","input":{"pattern":"*"},"output":"…","title":"","metadata":{"count":100,"truncated":true},"time":{...}}}}` |
| `message.part.updated` | `"error"` | `state:{status:"error",error:"<msg>",time:{start,end}}` | **`onEvent({type:'tool_end', tool, summary:error, ok:false})`** | `{"part":{"type":"tool","state":{"status":"error","error":"…"}}}` |
| `message.updated` (assistant, finish) | — | `info.finish:"tool-calls"` | **turn continues** — another step follows | `{"info":{"finish":"tool-calls",...}}` |

After a `finish:"tool-calls"` message, opencode automatically starts a new step (`step-start` → text/reasoning/tool parts → `step-finish`) containing the model's reaction to the tool output. The event stream keeps going until a `message.updated` with `info.finish:"stop"` arrives.

---

## 4. Final / stop signal

The run is complete when an assistant `message.updated` event arrives with `properties.info.finish` set:

- `finish: "stop"` — model produced a final text answer; no more tool calls. **This is the stop signal.**
- `finish: "tool-calls"` — model requested tools; another step will follow. Do NOT stop the pump here.

```js
if (ev.type === 'message.updated'
    && ev.properties?.info?.role === 'assistant'
    && ev.properties?.info?.finish === 'stop') { /* done */ }
```

**Where the final text lives:** the `message.updated` `info` object does NOT contain the text parts. Two options for the adapter:

1. **Accumulate deltas** in the pump (concatenate every `message.part.delta` where `field:"text"` for the current assistant messageID) — lowest latency, matches `text_delta` stream.
2. **Fetch after stop:** `const msgs = await client.session.messages({ path: { id: sessionId } }); const last = msgs.data.at(-1); const text = last.parts.filter(p => p.type === 'text').map(p => p.text).join('');` — authoritative, use as a fallback/verification.

M0.md §3 uses option 2 (`session.messages()`). That works, but remember the `.data` unwrap: `msgs.data.at(-1)`, not `msgs.at(-1)`.

---

## 5. Abort (mid-stream cancel)

```js
await client.session.abort({ path: { id: sessionId } });
// returns { data: boolean }  — true if a running prompt was aborted
```

Signature: `session.abort({ path: { id: string }, query?: { directory?: string } })`. No body. Returns `SessionAbortResponse = boolean` (wrapped as `{ data: boolean }`).

On abort, the in-flight `session.prompt()` promise rejects with a `MessageAbortedError`; the event stream emits a final `message.updated` with `info.error` of type `MessageAbortedError` and `finish` unset. The adapter should `await session.prompt(...).catch(() => {})` to swallow the abort rejection.

---

## 6. Session-status events (informational)

| `event.type` | meaning | adapter action |
|---|---|---|
| `session.status` `status.type:"busy"` | provider call in flight | ignore |
| `session.status` `status.type:"retry"` `attempt`,`message`,`next` | transient provider error, retrying | optionally surface as a system note |
| `session.status` `status.type:"idle"` | session idle | ignore (not a stop signal) |
| `session.idle` | session went idle | ignore |
| `session.error` | fatal session error | map to error frame |
| `session.updated` | session metadata changed | ignore |
| `session.diff` | file diffs changed | ignore |
| `server.connected` / `server.heartbeat` | connection keepalive | ignore |
| `plugin.added` / `catalog.updated` / `reference.updated` / `integration.updated` | startup catalog noise (fires once per session create) | ignore — **filter these out by default**; they're ~80 events of noise at session start |

---

## 7. One-line event-mapping summary (for the adapter's `_pumpEvents`)

```
message.part.delta  (field:"text")           → onEvent({type:'text_delta', text: delta})
message.part.updated part.type:"tool"
  state.status:"pending"                      → onEvent({type:'tool_start', tool: part.tool, summary: ''})
  state.status:"completed"                    → onEvent({type:'tool_end',   tool: part.tool, summary: part.state.title || '', ok: true})
  state.status:"error"                        → onEvent({type:'tool_end',   tool: part.tool, summary: part.state.error,  ok: false})
message.updated  info.role:"assistant"
  info.finish:"stop"                          → final; stop pump
  info.finish:"tool-calls"                    → continue (another step follows)
```

`tool_input` is not a separate event — input arrives in the `running` update (`part.state.input`). If TagTeam needs to surface tool input, emit an extra `tool_start` (or a custom `tool_input`) when `state.status === "running"` and feed `JSON.stringify(part.state.input)`.

---

## 8. Discrepancy with SDK TypeScript types

`node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts` `Event` union (line 602) does **not** include `message.part.delta` — it only lists `message.part.updated` and `message.part.removed`. But the runtime **does** emit `message.part.delta` events (confirmed in `scripts/spike-output.txt`). The `EventMessagePartUpdated` type has an optional `delta?: string` field, which suggests the type author intended deltas to ride on `message.part.updated`; the actual server emits them as a separate type. The adapter must switch on `ev.type === "message.part.delta"` at runtime — do not rely on the TS union.

Other runtime-only event types observed: `server.connected`, `server.heartbeat`, `plugin.added`, `catalog.updated`, `reference.updated`, `integration.updated`. None are in the `Event` union. Filter by allowlist rather than by exhaustiveness.

---

## 9. Notes / surprises

1. **Response unwrap `{ data, request, response }`** is the biggest trap. M0.md §3's `s.id` is wrong; use `s.data.id`. Same for `session.messages()`, `session.abort()`.
2. **`message.part.delta` is a separate event type**, not a field on `message.part.updated`. The SDK types are out of date.
3. **No discrete tool_start/tool_end events.** Tools are `message.part.updated` with `part.type:"tool"` and `state.status` transitions. The adapter synthesizes `tool_start`/`tool_end` from status transitions.
4. **~80 catalog/plugin events fire at session create** — pure noise. The pump must ignore them (allowlist the ~6 types we care about).
5. **`finish:"tool-calls"` is not a stop.** Only `finish:"stop"` ends the turn. Stopping on `tool-calls` would truncate the model's post-tool answer.
6. **Provider retries** (`session.status` `type:"retry"`) emit with `attempt`, `message`, `next` timestamp. The OXMIQ bigmodel gateway threw transient `Bad Gateway` on the first run; the SDK retried up to 4 times then timed out. The second run succeeded cleanly. The adapter should not treat retries as fatal.
7. **`reasoning` parts** stream with the same `message.part.delta` mechanism as `text` parts — only `part.type` differs. Decide whether to surface them as `text_delta` or drop them.
8. **`server.close()`** on the `createOpencode()` return value tears down the in-process server. For a long-lived adapter, create the server once and reuse across TagTeam sessions (one opencode session per TagTeam session).

---

## 10. Artifacts

- `scripts/spike-opencode.mjs` — the spike script (idempotent; creates two opencode sessions and prints every event).
- `scripts/spike-output.txt` — raw captured event stream from the successful text-only and tool-use runs (full ground truth; consult this if any shape above is unclear).
- This document: `docs/implementation/spike-opencode-sse.md`.
