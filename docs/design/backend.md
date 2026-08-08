# TagTeam — Backend Design (Node ESM server)

Author: Backend engineer (design). Scope: everything under `server/`.
Companion docs: architect's protocol spec (wire protocol is architect-owned; assumptions below are flagged), frontend design (`web/`), security design (tokens/guardrails).

This document is implementation-ready: an engineer should be able to build `server/` from it without asking questions. Where the design touches another specialist's area, the assumption is stated explicitly and marked **ASSUMPTION** so the critic can catch mismatches.

---

## 1. Runtime constraints (from the brief — non-negotiable)

- Node 20+, plain **ESM JavaScript** (`"type": "module"` in `package.json`). No TypeScript, no build step, no bundler.
- Single process, single server. In-memory state only. No database, no login.
- `npm install && npm start` is the whole setup. `start` script: `node server/index.js`.
- `ANTHROPIC_API_KEY` from the environment, **server-side only** — it never appears in any payload sent to a browser.
- Dependencies (keep to exactly these):
  - `ws` — WebSocket server.
  - `@anthropic-ai/claude-agent-sdk` — primary Claude engine.
  - `@anthropic-ai/sdk` — fallback Claude engine.
  - Nothing else. HTTP is Node's built-in `node:http`; static file serving is hand-rolled (§4.1). No Express.

Environment variables (all optional except the API key):

| Var | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | — (fatal if missing at startup) | Claude auth |
| `PORT` | `3000` | HTTP + WS port (same port, WS via upgrade) |
| `TAGTEAM_ENGINE` | `agent` | `agent` = Agent SDK, `api` = Messages API fallback |
| `TAGTEAM_MODEL` | `claude-opus-5` | Model id passed to whichever engine is active |
| `TAGTEAM_INVITE_TTL_MS` | `1800000` (30 min) | Invite token TTL |

On startup the server prints exactly one line the demo script relies on:
`TagTeam running → http://localhost:3000` (using the real port).

---

## 2. Module layout

```
server/
  index.js        entry point: config, http server, ws upgrade, wiring, startup banner
  config.js       env parsing + constants (limits, TTLs); throws on missing API key
  store.js        in-memory session store: sessions, participants, transcript, invites
  tokens.js       invite-token mint / redeem / revoke / sweep
  hub.js          WebSocket handling: connection auth, message dispatch, broadcast
  turns.js        per-session turn queue; invokes the Claude engine per user message
  protocol.js     message-type string constants + payload builders (single source of truth
                  for wire shapes on the server side)
  static.js       tiny static file server for web/ (path-traversal safe)
  claude/
    engine.js     engine selection (agent vs api) + shared system-prompt builder
    agentEngine.js    @anthropic-ai/claude-agent-sdk adapter
    apiEngine.js      @anthropic-ai/sdk streaming Messages adapter
```

Module dependency direction (no cycles):
`index.js` → `hub.js` → `turns.js` → `claude/*`; everything reads `store.js`/`config.js`/`protocol.js`. `store.js` imports nothing from the others.

---

## 3. Data model (`store.js`)

All state lives in module-level `Map`s. Every id is `crypto.randomUUID()`.

```js
// sessions: Map<sessionId, Session>
Session = {
  id: string,
  createdAt: number,            // Date.now()
  participants: Map<participantId, Participant>,
  transcript: TranscriptEntry[],// append-only, seq-numbered
  nextSeq: number,              // monotonically increasing per session
  guestCount: number,           // guests ever admitted (enforces max 2 — see §6.3)
  sdkSessionId: string | null,  // Agent SDK conversation id for `resume` (agent engine only)
  turnQueue: [],                // owned by turns.js, stored here for lifetime cohesion
  turnActive: boolean,
}

Participant = {
  id: string,
  name: string,                 // display name, 1–40 chars, trimmed; server sanitizes
  role: 'host' | 'guest',
  canWrite: boolean,            // host: always true; guest: true until made read-only
  revoked: boolean,             // kicked; connection closed, cannot rejoin
  connected: boolean,
  ws: WebSocket | null,         // live socket ref, null when disconnected
  joinedAt: number,
}

TranscriptEntry = {
  seq: number,
  id: string,
  kind: 'chat' | 'assistant' | 'system',
  // kind 'chat':      authorId, authorName, text
  // kind 'assistant': text (final or partial), status: 'streaming'|'done'|'error',
  //                   toolNotes: string[]   (human-readable one-liners, e.g. "Read package.json")
  // kind 'system':    text (e.g. "Teja joined", "Host revoked Teja")
  ts: number,
}
```

Store API (plain exported functions, no classes needed):

```js
createSession()                       -> Session
getSession(id)                        -> Session | undefined
addParticipant(session, name, role)   -> Participant
appendEntry(session, partialEntry)    -> TranscriptEntry   // assigns seq, id, ts
snapshot(session, selfId)             -> JSON-safe object for the `joined` payload
                                         (participants without ws refs, full transcript)
deleteSession(id)                     -> void
```

**Lifecycle/GC:** a session is deleted when the host socket has been disconnected for 10 minutes **and** no other participant is connected, checked by a 60 s `setInterval` sweep in `store.js` (same timer also calls `tokens.sweep()`). No persistence — server restart wipes everything; that is in-scope for the POC.

---

## 4. HTTP surface (`index.js` + `static.js`)

One `node:http` server; `ws.WebSocketServer({ noServer: true })` attached via the `upgrade` event so HTTP and WS share `PORT`.

### 4.1 Routes

| Method + path | Purpose |
|---|---|
| `GET /` | serve `web/index.html` (host app) |
| `GET /join` | serve `web/index.html` too — the client reads `?token=...` from `location.search` and enters guest flow. (**ASSUMPTION** for frontend: one HTML entry point, client-side branching. If the frontend doc wants `join.html`, only `static.js`'s route table changes.) |
| `GET /<asset>` | any other GET: static file from `web/`, resolved safely (below) |
| `POST /api/sessions` | create session + host join token (the only JSON API endpoint) |
| anything else | `404` JSON `{ error: 'not_found' }` |

`static.js` safety rules: resolve `path.join(WEB_ROOT, decodeURIComponent(pathname))` with `path.normalize`, then require the resolved path to start with `WEB_ROOT + path.sep` (reject otherwise with 403 — prevents `../` traversal). Content types: hardcoded map for `.html .js .css .svg .png .ico`; default `application/octet-stream`. No caching headers needed (POC).

### 4.2 `POST /api/sessions`

Request body: none required (ignore any).
Response `201`:

```json
{ "sessionId": "<uuid>", "joinToken": "<uuid>", "wsUrl": "/ws" }
```

Behavior: `createSession()`, then `tokens.mint({ sessionId, role: 'host', ttlMs: INVITE_TTL })`. The host browser immediately opens the WebSocket and redeems `joinToken` in its `join` message (§6.1). Host tokens are single-use like guest tokens; if the host refreshes the page the session is effectively orphaned and GC'd — acceptable POC behavior, called out in DEMO.md by the integrator (**ASSUMPTION** flagged for integrator).

Why only one HTTP endpoint: everything after joining (chat, invite minting, revoke) rides the already-authenticated WebSocket, which avoids inventing a second auth scheme for HTTP calls. **ASSUMPTION** (protocol/frontend): invite creation is a WS message (`invite.create`), *not* a REST endpoint. If the architect's protocol doc specifies REST minting instead, move the handler body from `hub.js` into an HTTP route — the `tokens.js` API is shared either way.

---

## 5. Invite tokens (`tokens.js`)

```js
// invites: Map<token, Invite>
Invite = {
  token: string,        // crypto.randomUUID()
  sessionId: string,
  role: 'host' | 'guest',
  expiresAt: number,    // mintedAt + TTL (default 30 min)
  used: boolean,
}

mint({ sessionId, role, ttlMs })  -> Invite
redeem(token)  -> { ok: true, invite } | { ok: false, reason }
               // reasons: 'unknown', 'expired', 'used', 'session_gone'
               // marks used=true atomically before returning ok (single-threaded JS,
               //  so "atomic" = mark before any await)
sweep()        -> deletes invites past expiresAt (called by the store's 60 s interval)
```

Rules enforced here and in `hub.js`:

- **Single use**: `redeem` flips `used` synchronously; a second redeem returns `used`.
- **TTL**: checked at redeem time *and* purged by sweep.
- **Guests cannot mint**: `invite.create` handler checks `participant.role === 'host'` (§6.2).
- **Max 2 guests per session**: checked at redeem time against `session.guestCount` (count of guests ever admitted, not currently connected — prevents kick-then-invite-forever loops from exceeding the cap in spirit; see Open Questions).
- Tokens are opaque UUIDs; they carry no data, everything is server-side. The invite URL format is `http://<host>/join?token=<token>` — the server builds the full URL from the request's `Host` header when minting so the host can copy-paste it (**ASSUMPTION**: frontend displays `inviteUrl` verbatim).

---

## 6. WebSocket layer (`hub.js`)

### 6.1 Connection lifecycle

1. Browser opens `ws(s)://<host>/ws`. Upgrade handler accepts only pathname `/ws`; anything else → destroy socket.
2. The connection starts **unauthenticated**. The first message must be `join` within 10 s, else the server closes with code `4001`. No session/participant state exists until join succeeds.
3. `join` payload: `{ type: 'join', token: string, name: string }`.
   - `redeem(token)` → on failure send `{ type: 'error', code: '<reason>' , fatal: true }` and close (`4003`).
   - On success: sanitize `name` (trim, strip control chars, clamp 40 chars; empty → `"Anonymous"`), `addParticipant`, bind `ws` to the participant, reply with `joined` (full snapshot), broadcast `participant.joined` + append a `system` transcript entry ("Teja joined").
4. Heartbeat: server `ws.ping()` every 30 s; a socket that misses two pongs is `terminate()`d. On `close`: `participant.connected = false`, `ws = null`, broadcast `participant.left`. **Reconnection is not supported in the POC** (tokens are single-use); a dropped guest needs a fresh invite. Called out for DEMO.md.
5. All frames are JSON text. Non-JSON or frames > 16 KB → `error` (`bad_message`) and, on repeat (3 strikes), close `4002`.

### 6.2 Client → server messages (dispatch table)

**ASSUMPTION — wire protocol.** The architect owns the protocol spec. The shapes below are what the backend will implement; if the architect's doc differs, `protocol.js` is the single file to update. Envelope: flat JSON objects with a `type` discriminator; server→client messages that relate to transcript content carry `seq` so clients can order/dedupe.

| type | payload | who may send | effect |
|---|---|---|---|
| `join` | `token, name` | anyone (pre-auth) | §6.1 |
| `chat.send` | `text` (1–4000 chars) | any participant with `canWrite` | append `chat` entry, broadcast `chat.message`, enqueue Claude turn (§7) |
| `invite.create` | — | host only | mint guest token; reply **only to host**: `invite.created { token, inviteUrl, expiresAt }` |
| `participant.revoke` | `participantId, mode: 'kick' \| 'readonly'` | host only | §6.3 |

Violations (guest sends `invite.create`, read-only guest sends `chat.send`, unknown `type`) → `{ type: 'error', code: 'forbidden' | 'read_only' | 'unknown_type', fatal: false }` to the sender only. Nothing is broadcast.

### 6.3 Revocation semantics

- `mode: 'readonly'`: set `canWrite = false`; send `revoked { mode: 'readonly' }` to the target; broadcast `participant.updated`. The guest keeps receiving the live transcript but every `chat.send` is rejected with `read_only`.
- `mode: 'kick'`: set `revoked = true`, `canWrite = false`; send `revoked { mode: 'kick' }`; close the target socket (`4004`); broadcast `participant.left`; append system entry ("Host removed Teja"). A kicked participant's tokens are already spent; they cannot rejoin without a new invite.
- Host cannot revoke themselves (reject with `forbidden`).
- Demo success criterion #4 ("guest can no longer send") is satisfied by either mode; frontend shows both buttons.

### 6.4 Server → client messages

| type | payload | audience |
|---|---|---|
| `joined` | `self {id,name,role,canWrite}, sessionId, participants[], transcript[]` | joiner only |
| `participant.joined` / `participant.left` / `participant.updated` | `participant {id,name,role,canWrite,connected}` | all |
| `chat.message` | full `TranscriptEntry` (kind `chat`) | all |
| `system.message` | full `TranscriptEntry` (kind `system`) | all |
| `assistant.start` | `entryId, seq` | all |
| `assistant.delta` | `entryId, text` (delta chunk, append-only) | all |
| `assistant.tool` | `entryId, note` (e.g. `"Read package.json"`) | all |
| `assistant.done` | `entryId, text` (full final text — authoritative; clients replace accumulated deltas) | all |
| `assistant.error` | `entryId, message` (human-readable, sanitized — never raw API error bodies) | all |
| `invite.created` | `token, inviteUrl, expiresAt` | host only |
| `revoked` | `mode` | target only |
| `error` | `code, message?, fatal` | sender only |

`broadcast(session, msg)` = JSON.stringify once, send to every participant with `connected && ws.readyState === OPEN`. Send failures are swallowed (the `close` handler cleans up).

---

## 7. Claude turn loop (`turns.js`)

### 7.1 Queueing model

**One Claude turn in flight per session, FIFO queue behind it.** Rationale: the transcript is a single shared conversation; concurrent API calls would interleave two assistant replies and corrupt Agent-SDK session continuity.

```
chat.send accepted
  → append chat entry, broadcast
  → session.turnQueue.push({ entryId })          // the triggering user message
  → pump(session)

pump(session):
  if session.turnActive or queue empty: return
  session.turnActive = true
  job = queue.shift()
  runTurn(session, job)
    .finally(() => { session.turnActive = false; pump(session) })
```

- Queue cap: 10 pending turns; beyond that `chat.send` still appends to the transcript and broadcasts (humans can talk to each other) but replies to the sender with `error {code:'busy'}` and does **not** enqueue. Simpler than dropping the message entirely and keeps the human channel alive.
- **Coalescing rule:** when a turn starts, the engine is given the *entire transcript up to now* (§7.2), so any messages that queued up while a turn ran are all visible to the next turn. Therefore `pump` may drain the whole queue into a single job: implement as `queue.length = 0` after shift — i.e., each pump run collapses all pending jobs into one turn. This keeps latency sane when host and guest both type during a long answer.

### 7.2 What the engine receives

`runTurn(session)` builds:

**System prompt** (rebuilt every turn — cheap, and roster changes between turns):

```
You are Claude, working inside TagTeam, a shared multiplayer session.
There are multiple humans in this room. Every human message is prefixed with the
speaker's name in brackets, e.g. "[Shash]: ...". Currently in the room:
- Shash (host)
- Teja (guest)
Address people by name when replying to them, and make clear who you are
answering when messages from several people are pending. Do not invent
participants. You have read-only tools; never modify files or system state.
```

(Names come from `session.participants` where `revoked === false`. The read-only sentence is kept even in the API-fallback engine, harmlessly.)

**Conversation history**, from the transcript:

- `chat` entries → `{ role: 'user', content: '[<authorName>]: <text>' }`
- `assistant` entries with `status === 'done'` → `{ role: 'assistant', content: text }`
- `assistant` entries with `status === 'error'` and non-empty partial text → include as assistant turn with a trailing marker `\n[response interrupted by an error]` so the model knows it was cut off; skip if empty.
- `system` entries (joins/leaves) are **not** sent to the model — roster is in the system prompt.
- Consecutive user messages are fine — the Messages API merges same-role runs; the Agent SDK receives only the *new* messages since the last turn anyway (see §8.1).

### 7.3 Streaming fan-out

```
entry = appendEntry(session, { kind:'assistant', text:'', status:'streaming', toolNotes:[] })
broadcast assistant.start { entryId, seq }
engine.runTurn({ system, messages, newUserText, session,
                 onDelta(text)  { entry.text += text; broadcast assistant.delta },
                 onTool(note)   { entry.toolNotes.push(note); broadcast assistant.tool } })
→ on success: entry.status='done'; entry.text=finalText; broadcast assistant.done
→ on failure: §7.4
```

Deltas are broadcast as they arrive, unbuffered (chat-scale volume; no batching needed for a POC).

### 7.4 Error handling when the API fails mid-stream

Failure classes and behavior — all funnel through one `failTurn(session, entry, err)`:

| Failure | Detection | User-visible message |
|---|---|---|
| Auth (401) | SDK `AuthenticationError` / agent process error | "Claude API key is invalid on the server." |
| Rate limit (429) | `RateLimitError` | "Claude is rate-limited; wait a moment and resend." |
| Overloaded / 5xx | `APIStatusError` ≥ 500 / `529` | "Claude is temporarily overloaded; resend your message." |
| Network drop mid-stream | `APIConnectionError` / stream iterator throws | "Connection to Claude dropped mid-answer." |
| Refusal | response `stop_reason === 'refusal'` (API engine) | "Claude declined to answer that request." |
| Engine crash (Agent SDK subprocess dies) | promise rejection from `query()` iteration | "Claude engine error on the server." |

`failTurn` does, in order:

1. `entry.status = 'error'` — **partial text is kept** in the transcript (it already streamed to everyone; deleting it would desync clients that rendered it). The trailing marker in §7.2 keeps the model's view coherent on the next turn.
2. Broadcast `assistant.error { entryId, message }` with the sanitized message from the table. Raw error objects are logged server-side (`console.error` with session id) but never sent to browsers.
3. **No automatic retry.** The SDKs already retry 429/5xx twice internally (default `max_retries`); if that still failed, a silent third try just burns quota. Humans resend.
4. Release the lock (`turnActive = false` in the shared `finally`) and `pump()` — queued messages still get their turn, using the transcript that now includes the error-marked partial.

A hard timeout wraps every turn: `AbortController`, 120 s (agentic tool use can be slow; opus-5 turns can run long). On abort, treat as the network-drop row. The abort signal is passed to both engines (`client.messages.stream(..., { signal })`; for the Agent SDK, `query()` accepts an `AbortController` in options — if the installed version doesn't, fall back to ignoring the iterator's remaining output after abort and letting the subprocess idle out).

Session death mid-turn (all sockets gone, session GC'd): `runTurn` checks `getSession(id)` before each broadcast; if gone, abort the stream and drop output on the floor.

---

## 8. Claude engines (`claude/`)

### 8.1 Common interface (`engine.js`)

```js
// selectEngine(config) -> engine object, decided once at startup
engine = {
  name: 'agent' | 'api',
  // resolves with { text, stopReason } or throws (→ §7.4)
  runTurn({ session, system, messages, newUserText, onDelta, onTool, signal }) -> Promise
}
```

`newUserText` = the concatenated `[Name]: text` lines added since the previous completed turn (what the Agent SDK needs); `messages` = the full history (what the API engine needs). Both are always built; each engine uses the one it wants.

Startup behavior: if `TAGTEAM_ENGINE=agent` (default), `engine.js` verifies the Agent SDK is usable by dynamic `import('@anthropic-ai/claude-agent-sdk')` inside a try/catch; on failure it logs a warning and falls back to the API engine **at startup, not per-request** — the brief's fallback clause is an environment capability question, not a runtime race.

### 8.2 Agent SDK engine (`agentEngine.js`)

Uses `query()` from `@anthropic-ai/claude-agent-sdk`. Design contract (exact option names must be verified against the installed SDK version's docs at implementation time — the Agent SDK is a separate product from the Messages API and its surface moves; treat `code.claude.com/docs/en/agent-sdk` as authoritative):

- **Per turn:** call `query({ prompt: newUserText, options })` and iterate the returned async iterable.
- **Options:**
  - `model: config.model`
  - `systemPrompt: system` (the roster prompt from §7.2)
  - **Read-only tool allowlist:** `allowedTools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch']` and `disallowedTools` for everything write-capable (`Write`, `Edit`, `Bash`, `NotebookEdit`). Belt and suspenders: even if a write tool slips through naming drift, `permissionMode` stays `'default'` (never `bypassPermissions`/`acceptEdits`), so writes would require an approval that nothing grants.
  - **Continuity:** first turn of a session runs fresh; capture the SDK's session id from its init/system message and store as `session.sdkSessionId`; subsequent turns pass `resume: session.sdkSessionId`. This is why the agent engine only needs `newUserText` — the SDK holds its own history. If a resume fails (SDK session evicted), clear `sdkSessionId`, rebuild `prompt` as full transcript text, and run fresh; do this once, not in a loop.
  - `includePartialMessages: true` (or the version's equivalent) so assistant text arrives as stream events for `onDelta`. If the installed version cannot stream partials, degrade: emit one `onDelta(fullText)` per completed assistant message — the wire protocol is unchanged, the UX is just chunkier.
  - `cwd`: a dedicated scratch directory (`os.tmpdir()/tagteam-<sessionId>`) so `Read`/`Glob` roam somewhere harmless by default; the demo scenario (TPU procurement chat + web search) doesn't rely on local files.
- **Message mapping** while iterating:
  - assistant text (partial or complete) → `onDelta`
  - tool-use events → `onTool(\`${toolName} ${primaryInput}\`)` — one short line, e.g. `Read /etc/hosts`, `WebSearch "TPU v5e pricing"`. Truncate input repr to 80 chars.
  - final result message → resolve with accumulated text.
  - error result / iterator throw → reject (→ §7.4).

### 8.3 Messages API engine (`apiEngine.js`)

Uses `@anthropic-ai/sdk`, constructed once: `new Anthropic()` (reads `ANTHROPIC_API_KEY` from env).

```js
const stream = client.messages.stream({
  model: config.model,              // default 'claude-opus-5'
  max_tokens: 64000,                // streaming default; opus-5 thinks by default and
                                    // max_tokens caps thinking + text together
  system,                           // roster prompt
  messages,                         // full attributed history from §7.2
}, { signal });
stream.on('text', (delta) => onDelta(delta));
const final = await stream.finalMessage();
```

- No `temperature`/`top_p`/`top_k` (rejected on opus-5). No `thinking` param (adaptive by default on opus-5; we don't surface thinking, so the default `display: "omitted"` is fine — clients just see a pause before text).
- No tools in the fallback engine — the brief's "real work (read files, search)" is the Agent SDK's job; the fallback is pure chat behind the same interface.
- After `finalMessage()`: if `final.stop_reason === 'refusal'`, reject with a typed `RefusalError` so §7.4 maps it to the refusal row (check `stop_reason` **before** reading content). If `stop_reason === 'max_tokens'`, resolve normally but append `onTool('response truncated at token limit')` as a visible note.
- Error taxonomy: catch the SDK's typed classes (`Anthropic.AuthenticationError`, `RateLimitError`, `APIConnectionError`, `APIStatusError`) and rethrow tagged for the §7.4 table — never string-match error messages.
- Optional hardening (implement only if time permits, behind `TAGTEAM_FALLBACKS=1`): server-side refusal fallback via `client.beta.messages.stream` with `betas: ['server-side-fallback-2026-07-01']`, `fallbacks: 'default'`. Not required for the demo.

**Prompt-cache note:** the system prompt embeds the roster, which changes when guests join — that intentionally trades cache efficiency for correctness, and at POC scale is irrelevant. Do not "optimize" by moving the roster into the first user message.

---

## 9. Security posture (v0 guardrails, backend view)

- API key: env-only, never serialized into any client payload or log line.
- Invite tokens: single-use + 30 min TTL + swept; minting requires an authenticated host socket; max 2 guests per session enforced at redeem.
- Host power: revoke (kick/read-only) is host-only; guests can never mint or revoke.
- Claude tools: read-only allowlist, default permission mode, scratch `cwd` (§8.2).
- Input hygiene: name sanitization, 4000-char chat cap, 16 KB frame cap, 3-strike close on garbage frames.
- Explicitly deferred (name in demo, don't build): real identity/SSO, transcript redaction/context scoping, rate limiting beyond the turn queue, TLS (localhost demo), persistence.

---

## 10. Startup sequence (`index.js`)

1. `config.js` throws early if `ANTHROPIC_API_KEY` missing → process exits with a clear one-line error.
2. `selectEngine()` (dynamic import probe, §8.1) — log which engine is active.
3. Create `http.Server` (routes §4) + `WebSocketServer({ noServer: true })`, wire `upgrade` → `/ws` only.
4. Start sweeps (invites + session GC, one 60 s interval).
5. `listen(PORT)` → print the banner URL.
6. `process.on('SIGINT')`: close WS server, `server.close()`, exit — no state to flush.

---

## 11. Explicit cross-boundary assumptions (for the critic)

1. **Wire protocol (architect):** message types/payloads exactly as in §6.2/§6.4, flat JSON with `type` discriminator, transcript entries carrying `seq`, invite minting over WS not REST, single WS path `/ws`. `protocol.js` isolates all shapes if the architect's spec differs.
2. **Frontend:** single `index.html` served for both `/` and `/join`; client parses `?token=` itself; client accumulates `assistant.delta` and replaces with `assistant.done`'s full text; `inviteUrl` displayed verbatim; `joined` snapshot is sufficient to render the whole room (no follow-up fetches).
3. **Token/security specialist:** token semantics (UUID opaque, single-use at redeem, TTL 30 min, host token same mechanism as guest token, max-2-guests counted as "ever admitted"). If the security design counts *concurrent* guests instead, change one comparison in `tokens.redeem`.
4. **Integrator:** startup banner line format; "host refresh orphans the session" and "no guest reconnection" limitations to be named in DEMO.md; `npm start` → `node server/index.js`.
5. **Agent SDK availability:** engine choice is startup-time, not per-request; option names in §8.2 are a contract to verify against the installed SDK version, with specified degradations (no partial streaming → chunkier deltas; no resume → fresh turn with full transcript).
