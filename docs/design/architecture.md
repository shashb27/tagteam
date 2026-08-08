# TagTeam — System Architecture & Wire Protocol

**Author:** System architect (swarm role)
**Status:** v1 — contract for backend + frontend builders
**Scope source:** `PROJECT_BRIEF.md` (the brief wins on any conflict)

This document is the implementation contract. Backend and frontend are built independently
against the protocol in §6 and must meet in the middle without further coordination.

---

## 1. Component overview

```
┌────────────────────────────  Node 20+ process (single, ESM, no build step)  ─────────────────────────────┐
│                                                                                                          │
│  HTTP (node:http)                       WebSocket (ws, path /ws)                                         │
│  ├── GET /            → web/index.html  ┌──────────────────────────────┐                                 │
│  ├── GET /join/:token → web/index.html  │  Connection layer            │                                 │
│  ├── GET /web/*       → static assets   │  frame parse/validate, join  │                                 │
│  ├── POST /api/sessions                 │  auth, per-socket state      │                                 │
│  └── GET /healthz                       └──────────────┬───────────────┘                                 │
│                                                        │                                                 │
│                                         ┌──────────────▼───────────────┐      ┌───────────────────────┐  │
│                                         │  Session store (in-memory)   │      │  Agent runner         │  │
│                                         │  Map<sessionId, Session>     │◄────►│  (one per session)    │  │
│                                         │  transcript, participants,   │      │  impl A: Agent SDK    │  │
│                                         │  invites, turn queue         │      │  impl B: Messages API │  │
│                                         └──────────────┬───────────────┘      └───────────┬───────────┘  │
│                                                        │ broadcast                        │              │
│                                                        ▼                                  ▼              │
│                                          all sockets of the session            Anthropic API             │
│                                                                                (ANTHROPIC_API_KEY,       │
│                                                                                 server-side only)        │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **One process, no database, no login.** All state in §5 lives in module-level Maps and dies on restart.
- **`server/`** owns everything above; **`web/`** is one static page (HTML/JS/CSS, no framework) that
  drives the whole UX through the protocol in §6.
- The server prints `TagTeam running at http://localhost:<port>` on startup (`PORT` env, default `3000`).
  `npm install && npm start` is the entire setup; `ANTHROPIC_API_KEY` must be in the environment
  (fail fast at startup with a clear message if it is missing).

### Suggested server module layout (guidance, not a hard boundary)

```
server/
  index.js          # http server, static file serving, /api/sessions, ws upgrade
  sessions.js       # session store, participants, invites, transcript, broadcast
  turns.js          # turn queue + run lifecycle (§7), fanout of agent events (§9)
  protocol.js       # frame constants, validation helpers, error codes
  agent/
    index.js        # createAgentSession() factory + SDK-availability probe (§8.1)
    sdkRunner.js    # Claude Agent SDK implementation (§8.3)
    apiRunner.js    # Messages API fallback implementation (§8.4)
  demo-workspace/   # small read-only file tree the agent can Read/Grep in the demo
```

---

## 2. Identity, keys, and tokens (nomenclature used everywhere below)

| Term | What it is | Who ever sees it |
| --- | --- | --- |
| `sessionId` | UUID identifying a session | everyone in the session (appears in URLs is fine) |
| `hostKey` | UUID capability returned by `POST /api/sessions`; proves "I am the host" | host browser only. **Never broadcast, never in any server→client frame except the host's own `session_created`/`joined`.** |
| `inviteToken` | UUID capability minted by the host; single-use, TTL'd; encodes the session (server-side lookup, token → session) | host (to copy the link) and the one guest who uses it |
| `participantId` | UUID assigned by the server at join | everyone in the session (used for attribution & revoke) |
| `resumeKey` | UUID returned in `joined`; lets the *same* browser reattach after a page refresh / WS drop | that participant's browser only |
| `clientMsgId` | Client-generated ID (any string ≤ 64 chars, e.g. `crypto.randomUUID()`) echoed back so the sender can reconcile its optimistic UI | sender + everyone (harmless) |

All server-generated IDs/tokens are `crypto.randomUUID()`.

---

## 3. HTTP surface (complete)

| Method & path | Purpose | Request | Response |
| --- | --- | --- | --- |
| `GET /` | Serve the app (host entry) | — | `web/index.html` |
| `GET /join/:token` | Serve the *same* app (guest entry). Client JS reads the token from `location.pathname`; **no validation happens at HTTP time** — validation is on WS `join`. | — | `web/index.html` |
| `GET /web/*` | Static assets (`app.js`, `style.css`) with basic content types | — | file or 404 |
| `POST /api/sessions` | Create a session | empty body (ignore body entirely) | `201` `{"sessionId": "...", "hostKey": "...", "wsPath": "/ws"}` |
| `GET /healthz` | Liveness | — | `200` `{"ok": true, "agentImpl": "sdk" \| "api"}` |

Everything else is WebSocket. There is deliberately **no** HTTP endpoint that reads or mutates
session state (keeps auth in one place: the WS `join` handshake).

CORS: none needed — the app is same-origin. Do not add CORS headers.

---

## 4. Session model & lifecycle

### 4.1 Roles and permissions

| Capability | Host | Guest (canSend=true) | Guest (read-only) |
| --- | --- | --- | --- |
| See full live transcript | ✅ | ✅ | ✅ |
| Send messages to Claude | ✅ | ✅ | ❌ (`READ_ONLY` error) |
| Create invites | ✅ | ❌ (`NOT_HOST`) | ❌ |
| Revoke a guest (kick / read-only / restore) | ✅ | ❌ (`NOT_HOST`) | ❌ |
| Revoke an unused invite | ✅ | ❌ | ❌ |

Exactly one host per session (the creator). **Max 2 guests**: counted as guest participants with
`status !== 'kicked'`. A kicked guest frees a slot. Invite `join` is rejected with `SESSION_FULL`
when 2 non-kicked guests already exist.

### 4.2 Happy-path lifecycle

1. Host opens `/`, clicks "New session" → client `POST /api/sessions`, stores `{sessionId, hostKey}`
   in `sessionStorage`, opens WS, sends `join` (host variant).
2. Host chats; each `user_message` runs a Claude turn (§7) streamed to all sockets (§9).
3. Host clicks **Tag in** → `create_invite` → server replies `invite_created` with a full URL
   (`<origin>/join/<inviteToken>`, TTL default 30 min). Host copies it out-of-band (Teams/Slack —
   delivery integration is deferred per brief).
4. Guest opens the link → app shows a name prompt → opens WS, sends `join` (invite variant).
   Server validates token (exists, not expired, not used, session not full), marks it used,
   creates the participant, sends `joined` (with full transcript snapshot) to the guest and
   `participant_joined` to everyone else.
5. Guest sends messages exactly like the host; attribution is by `participantId`/name (§8.5).
6. Host revokes: `revoke_guest` with `mode: "read_only"` (guest stays, can't send) or
   `mode: "kick"` (participant marked kicked, sockets closed). Broadcast to all.
7. No explicit "end session" in the POC. Sessions are garbage-collected 2 hours after the last
   socket disconnects (a `setInterval` sweep every 5 min is fine). `session_closed` is sent if a
   sweep ever races a live socket.

### 4.3 Reconnect / refresh (cheap but specified)

- `joined` includes a `resumeKey`. The client stores `{sessionId, participantId, resumeKey}` in
  `sessionStorage` and, on reload or WS drop, rejoins with the `resume` variant of `join`.
- Resume reattaches the socket to the existing participant (no new participant, no
  `participant_joined` broadcast; a `participant_updated` with `connected: true` is broadcast
  instead). Kicked participants cannot resume (`REVOKED`).
- The host may *also* always rejoin with `hostKey` (covers cleared sessionStorage).
- An invite token is single-use for *joining*; it is never reusable, including for reconnect —
  reconnect is `resumeKey`'s job. A guest who loses `sessionStorage` needs a fresh invite. That
  is acceptable POC behavior; say so in the demo if asked.
- A participant may have **multiple concurrent sockets** (same person, two tabs) — `sockets` is a
  Set. This falls out of resume for free; don't fight it.

---

## 5. In-memory state shape (exact)

Module-level in `server/sessions.js`:

```js
/** @type {Map<string, Session>} */
const sessions = new Map();

/** Invite token → sessionId, so /ws join can find the session without a sessionId. */
/** @type {Map<string, string>} */
const inviteIndex = new Map();
```

```js
// ---- Session ----
{
  id: "6f9c1e2a-...",            // sessionId
  hostKey: "b1d4...-...",
  createdAt: 1754650000000,       // Date.now() ms everywhere
  lastActivityAt: 1754650100000,  // updated on any frame; used by the GC sweep

  participants: new Map(),        // participantId -> Participant (insertion order = join order)
  invites: new Map(),             // inviteToken   -> Invite

  transcript: [],                 // Message[], append-only, ordered by seq
  nextSeq: 1,                     // monotonic per session; every Message gets one

  // Turn engine (§7)
  pendingUserMessages: [],        // Message[] (role 'user') not yet consumed by a run
  activeRun: null,                // null | ActiveRun

  agent: null,                    // AgentSession (§8.2), created lazily on first run
  rosterDirty: true,              // set true whenever participants change; consumed by §8.5
}

// ---- Participant ----
{
  id: "p-uuid",
  name: "Teja",                   // display name, trimmed, 1..40 chars, control chars stripped
  role: "host" | "guest",
  canSend: true,                  // flipped by revoke_guest mode "read_only" / "restore"
  status: "active" | "kicked",
  connected: true,                // derived: sockets.size > 0, but kept explicit for snapshots
  sockets: new Set(),             // Set<WebSocket>, NOT serialized into snapshots
  resumeKey: "r-uuid",
  joinedAt: 1754650050000,
}

// ---- Invite ----
{
  token: "i-uuid",
  createdAt: 1754650040000,
  expiresAt: 1754651840000,       // createdAt + ttlMinutes*60_000 (default 30, max 120)
  usedBy: null,                   // null | participantId — set exactly once (single-use)
  revoked: false,                 // host revoked the link before use
}

// ---- Message (transcript entry) ----
{
  id: "m-uuid",
  seq: 7,
  role: "user" | "assistant" | "system",
  // user:      authorId/authorName = the participant
  // assistant: authorId = "claude", authorName = "Claude"
  // system:    authorId = "system", authorName = "System"  (join/leave/revoke notices)
  authorId: "p-uuid",
  authorName: "Shash",
  text: "What TPU SKUs did we shortlist?",
  ts: 1754650060000,
  streaming: false,               // true only on the in-progress assistant message
  toolEvents: [],                 // assistant only: [{tool, summary, ok, ts}], for snapshot replay
}

// ---- ActiveRun ----
{
  messageId: "m-uuid",            // the assistant Message being streamed
  abortController: new AbortController(),
  deltaIndex: 0,                  // next assistant_delta index (§9)
  flushTimer: null,               // coalescing timer handle (§9)
  buffer: "",                     // deltas awaiting flush
}
```

Rules:

- **Snapshot serialization:** when a `Participant` or `Message` goes over the wire, strip
  server-only fields: `sockets`, `resumeKey` (participants); nothing stripped from messages.
  `hostKey` is never in any snapshot.
- **`transcript` is append-only.** The streaming assistant message is appended at run start with
  `text: ""` and `streaming: true`, then mutated in place (text grows, `toolEvents` appended,
  `streaming` flipped to false at completion). This makes late-join snapshots trivially correct.
- **System messages** are real transcript entries (e.g. `"Teja joined the session."`,
  `"Teja was made read-only by the host."`) so both humans and late joiners see them. They are
  *not* sent to Claude as transcript turns — Claude learns roster changes via §8.5.
- All limits: user message text ≤ 8,000 chars (`MESSAGE_TOO_LONG`), `pendingUserMessages` cap 10
  (`RATE_LIMITED`), max 25 sessions alive (`POST /api/sessions` → `503`).

---

## 6. WebSocket wire protocol (COMPLETE — this is the contract)

- Endpoint: `ws(s)://<host>/ws` (same origin as the page; client builds it from `location`).
- Every frame is one JSON text message: `{"type": "<name>", "v": 1, ...payload}`.
  `v` is optional on receive (assume 1), always sent by the server. Unknown fields are ignored;
  unknown `type` from a client → `error {code:"BAD_FRAME"}` (non-fatal); unknown `type` from the
  server → client ignores it (forward compatibility).
- The **first** client frame on a socket MUST be `join`. Any other frame first →
  `error {code:"NOT_JOINED", fatal:true}` and the server closes the socket (code 4000).
- After a fatal `error`, the server closes the socket with WS close code **4000** (auth/validation)
  or **4001** (kicked). Non-fatal errors leave the socket open.
- Server sends `ping` frames? No — the `ws` library's protocol-level ping/pong is used server-side
  (30 s interval, terminate after 2 misses). The JSON `ping`/`pong` below exists only so the
  *client* can keep intermediaries warm and measure liveness; frontend may skip it entirely.

### 6.1 Client → Server frames

#### `join` — exactly one of three variants, always the first frame

Host (fresh):
```json
{"type": "join", "v": 1, "as": "host", "sessionId": "6f9c1e2a-…", "hostKey": "b1d4…", "name": "Shash"}
```
Guest (invite):
```json
{"type": "join", "v": 1, "as": "guest", "inviteToken": "i-uuid", "name": "Teja"}
```
Resume (either role, after refresh/drop):
```json
{"type": "join", "v": 1, "as": "resume", "sessionId": "6f9c1e2a-…", "participantId": "p-uuid", "resumeKey": "r-uuid"}
```
Success → `joined` to this socket, plus `participant_joined` (fresh guest/host? host is created
at session creation time but only becomes a participant on first `join`, which also broadcasts —
to an empty room, harmlessly) or `participant_updated {connected:true}` (resume) to others.
Failure → fatal `error` with one of: `SESSION_NOT_FOUND`, `BAD_HOST_KEY`, `INVALID_TOKEN`,
`TOKEN_EXPIRED`, `TOKEN_USED`, `TOKEN_REVOKED`, `SESSION_FULL`, `BAD_NAME`, `BAD_RESUME`, `REVOKED`.

#### `user_message`
```json
{"type": "user_message", "clientMsgId": "c-123", "text": "What's our GPU budget line?"}
```
Rejections (non-fatal `error`, echoing `clientMsgId`): `READ_ONLY`, `EMPTY_MESSAGE`,
`MESSAGE_TOO_LONG`, `RATE_LIMITED`. Success: broadcast `user_message` (server-authoritative copy)
to **everyone including the sender**; sender reconciles via `clientMsgId`. Then the turn engine
(§7) takes over.

#### `create_invite` (host only)
```json
{"type": "create_invite", "ttlMinutes": 30}
```
`ttlMinutes` optional; default 30; clamp to 1..120. Errors: `NOT_HOST`. Note: minting is allowed
even when 2 guests are present — the limit is enforced at *join* time (`SESSION_FULL`).
Success → `invite_created` **to the host's sockets only**.

#### `revoke_invite` (host only) — revoke an unused link
```json
{"type": "revoke_invite", "inviteToken": "i-uuid"}
```
Errors: `NOT_HOST`, `INVALID_TOKEN` (unknown or already used). Success → `invite_revoked` to host only.

#### `revoke_guest` (host only)
```json
{"type": "revoke_guest", "participantId": "p-uuid", "mode": "kick"}
```
`mode`: `"kick"` | `"read_only"` | `"restore"` (restore flips a read-only guest back to
`canSend: true`; costs nothing and makes the demo safer). Errors: `NOT_HOST`,
`PARTICIPANT_NOT_FOUND`, `CANNOT_REVOKE_HOST`.
Effects — `kick`: participant `status="kicked"`, broadcast `participant_left {reason:"kicked"}`,
append a system Message, close the guest's sockets (WS code 4001) *after* sending them the
broadcast. `read_only`/`restore`: flip `canSend`, broadcast `participant_updated`, append a
system Message.

#### `ping`
```json
{"type": "ping", "t": 1754650000000}
```
→ `pong` with the same `t`. Optional for the frontend.

### 6.2 Server → Client frames

#### `joined` — reply to a successful `join`, this socket only
```json
{
  "type": "joined", "v": 1,
  "self": {"participantId": "p-uuid", "resumeKey": "r-uuid", "role": "guest", "name": "Teja", "canSend": true},
  "session": {
    "id": "6f9c1e2a-…",
    "participants": [
      {"id": "p-host", "name": "Shash", "role": "host", "canSend": true, "connected": true, "status": "active"},
      {"id": "p-uuid", "name": "Teja", "role": "guest", "canSend": true, "connected": true, "status": "active"}
    ],
    "transcript": [
      {"id": "m-1", "seq": 1, "role": "user", "authorId": "p-host", "authorName": "Shash",
       "text": "Help me compare TPU procurement options.", "ts": 1754650060000, "streaming": false, "toolEvents": []},
      {"id": "m-2", "seq": 2, "role": "assistant", "authorId": "claude", "authorName": "Claude",
       "text": "Sure, Shash. Based on…", "ts": 1754650061000, "streaming": true,
       "toolEvents": [{"tool": "Read", "summary": "Read demo-workspace/tpu-quotes.md", "ok": true, "ts": 1754650061500}]}
    ]
  }
}
```
If a run is streaming at join time, the snapshot contains the partial message with
`streaming: true`; subsequent `assistant_delta` frames extend it (§9 — `index` is the *global*
delta counter for that message, and the client must treat the snapshot text as "everything before
the next delta received on this socket"; the server guarantees it never re-sends flushed text to
a socket that got it in a snapshot, because the snapshot is built and sent synchronously between
flushes).

#### `error`
```json
{"type": "error", "v": 1, "code": "READ_ONLY", "message": "The host has made you read-only.", "fatal": false, "clientMsgId": "c-123"}
```
`clientMsgId` present only when rejecting a specific `user_message`. Full code list:
`BAD_FRAME`, `NOT_JOINED`, `SESSION_NOT_FOUND`, `BAD_HOST_KEY`, `INVALID_TOKEN`, `TOKEN_EXPIRED`,
`TOKEN_USED`, `TOKEN_REVOKED`, `SESSION_FULL`, `BAD_NAME`, `BAD_RESUME`, `REVOKED`, `READ_ONLY`,
`EMPTY_MESSAGE`, `MESSAGE_TOO_LONG`, `RATE_LIMITED`, `NOT_HOST`, `PARTICIPANT_NOT_FOUND`,
`CANNOT_REVOKE_HOST`, `INTERNAL`. `fatal: true` ⇒ socket is closed right after.

#### `participant_joined` — broadcast (all sockets except the joiner's, which got `joined`)
```json
{"type": "participant_joined", "v": 1,
 "participant": {"id": "p-uuid", "name": "Teja", "role": "guest", "canSend": true, "connected": true, "status": "active"},
 "systemMessage": {"id": "m-9", "seq": 9, "role": "system", "authorId": "system", "authorName": "System",
                    "text": "Teja joined the session.", "ts": 1754650070000, "streaming": false, "toolEvents": []}}
```
(Every frame that appends a system Message carries it inline as `systemMessage`, so clients never
need to re-fetch the transcript.)

#### `participant_left` — broadcast, all sockets (including the kicked guest, pre-close)
```json
{"type": "participant_left", "v": 1, "participantId": "p-uuid", "reason": "kicked",
 "systemMessage": { "id": "m-12", "seq": 12, "role": "system", "authorId": "system", "authorName": "System", "text": "Teja was removed by the host.", "ts": 1754650300000, "streaming": false, "toolEvents": [] }}
```
`reason`: `"kicked"` | `"disconnected"` (all sockets gone — participant stays in the roster with
`connected:false`; only `kicked` removes send rights permanently). For `disconnected`, send
`participant_updated {connected:false}` instead — `participant_left` is used **only** for kicks.
(Stated plainly: `participant_left` ⇔ kick.)

#### `participant_updated` — broadcast
```json
{"type": "participant_updated", "v": 1, "participantId": "p-uuid",
 "patch": {"canSend": false},
 "systemMessage": {"id": "m-11", "seq": 11, "role": "system", "authorId": "system", "authorName": "System", "text": "Teja was made read-only by the host.", "ts": 1754650200000, "streaming": false, "toolEvents": []}}
```
`patch` contains only changed public fields (`canSend`, `connected`). `systemMessage` is omitted
for pure connectivity changes (connect/disconnect) — those don't clutter the transcript.
The affected guest also receives this frame and must disable its composer when
`patch.canSend === false`.

#### `user_message` — broadcast (server-authoritative echo)
```json
{"type": "user_message", "v": 1, "clientMsgId": "c-123",
 "message": {"id": "m-10", "seq": 10, "role": "user", "authorId": "p-uuid", "authorName": "Teja",
              "text": "Do we already have a firewall exception for the vendor portal?", "ts": 1754650100000, "streaming": false, "toolEvents": []}}
```
`clientMsgId` is echoed to all (only the sender cares). Non-senders just append.

#### `assistant_start` — broadcast, a Claude turn began
```json
{"type": "assistant_start", "v": 1,
 "message": {"id": "m-13", "seq": 13, "role": "assistant", "authorId": "claude", "authorName": "Claude",
              "text": "", "ts": 1754650101000, "streaming": true, "toolEvents": []},
 "inReplyTo": ["m-10"]}
```
`inReplyTo`: ids of the user messages consumed by this run (≥1; >1 when messages queued during a
previous run — §7). Frontend may ignore it or use it for a subtle "answering …" hint.

#### `assistant_delta` — broadcast, streaming text
```json
{"type": "assistant_delta", "v": 1, "messageId": "m-13", "index": 4, "delta": "Based on the quotes in tpu-quotes.md, the three viable"}
```
`index` starts at 0 per message and increments by 1 per frame (coalescing in §9 means one frame ≠
one model token). Client appends `delta` to the message text. If the client ever sees a gap in
`index`, its state is corrupt → simplest recovery is reconnect via resume (snapshot heals it);
gaps cannot happen on a healthy socket because WS is ordered.

#### `tool_activity` — broadcast, agent is using a tool
```json
{"type": "tool_activity", "v": 1, "messageId": "m-13", "phase": "start", "tool": "Read", "summary": "Read demo-workspace/tpu-quotes.md"}
```
```json
{"type": "tool_activity", "v": 1, "messageId": "m-13", "phase": "end", "tool": "Read", "summary": "Read demo-workspace/tpu-quotes.md", "ok": true}
```
Rendered as a small inline chip in the assistant bubble ("🔧 Read: demo-workspace/tpu-quotes.md").
Only `phase:"end"` events are persisted into `toolEvents` for snapshots. In the Messages-API
fallback (no tools), this frame simply never occurs — the frontend must not depend on it.

#### `assistant_complete` — broadcast, turn finished
```json
{"type": "assistant_complete", "v": 1, "messageId": "m-13",
 "text": "Based on the quotes in tpu-quotes.md, the three viable options are…",
 "stopReason": "end_turn"}
```
`text` is the **full final text** — the client MUST replace its accumulated text with this
(reconciliation; makes delta loss on flaky links self-healing). `stopReason`:
`"end_turn" | "max_tokens" | "aborted" | "error"`. Sets `streaming: false`.

#### `assistant_error` — broadcast, turn failed
```json
{"type": "assistant_error", "v": 1, "messageId": "m-13", "message": "Claude request failed (rate limited). Try again."}
```
Always followed by `assistant_complete` with `stopReason: "error"` and whatever partial `text`
accumulated (possibly empty), so every `assistant_start` is guaranteed to be closed by exactly
one `assistant_complete`. The transcript keeps the partial message; the error text is *not*
appended to it.

#### `invite_created` — to the requesting host's sockets only
```json
{"type": "invite_created", "v": 1, "inviteToken": "i-uuid",
 "url": "http://localhost:3000/join/i-uuid", "expiresAt": 1754651840000}
```
`url` is built from `BASE_URL` env if set, else from the HTTP `Host` header captured at session
creation, else `http://localhost:<port>`.

#### `invite_revoked` — to the host's sockets only
```json
{"type": "invite_revoked", "v": 1, "inviteToken": "i-uuid"}
```

#### `session_closed` — broadcast, then all sockets closed (code 4000)
```json
{"type": "session_closed", "v": 1, "reason": "expired"}
```

#### `pong`
```json
{"type": "pong", "v": 1, "t": 1754650000000}
```

### 6.3 Ordering guarantees

Per socket, the server emits frames in transcript order: a message's `user_message` /
`assistant_start` frame is sent before any frame referencing a later `seq`. All broadcasts
iterate `session.participants` → `sockets` synchronously, so every socket sees the same order.
The frontend can therefore treat `seq` as a display sort key and never re-sort.

---

## 7. Turn engine (who talks to Claude, when)

One Claude run at a time per session. Incoming user messages during a run are **queued, not
rejected** — critical for the demo moment where the guest jumps in mid-stream.

```
on user_message accepted:
  append Message to transcript, broadcast user_message
  push onto session.pendingUserMessages
  if session.activeRun === null → startRun(session)

startRun(session):
  batch = pendingUserMessages.splice(0)            // consume ALL pending (1..10 messages)
  create assistant Message (text:"", streaming:true), append to transcript
  session.activeRun = { messageId, abortController, deltaIndex:0, buffer:"", flushTimer:null }
  broadcast assistant_start { message, inReplyTo: batch.map(m => m.id) }
  userText = composeUserTurn(session, batch)        // §8.5
  agent.run({ userText, systemPrompt, onEvent, signal }) …
    → on success: flush buffer, broadcast assistant_complete {stopReason from runner}
    → on failure: flush buffer, broadcast assistant_error, then assistant_complete {stopReason:"error"}
  finally:
    session.activeRun = null
    if pendingUserMessages.length > 0 → startRun(session)   // drain the queue
```

- Batching multiple queued messages into one run is intentional: Claude sees
  `[Shash]: …\n\n[Teja]: …` as one user turn and answers both, addressing each by name.
- A run is aborted (`abortController.abort()`) only when the session is GC'd. There is **no**
  user-facing "stop generating" in the POC (deferred; the protocol leaves room — a future
  `abort_run` client frame — do not build it).
- Timeout: abort a run after 120 s wall clock → treated as failure path with message
  "Claude took too long and was stopped."

---

## 8. Claude integration

### 8.1 Runner selection (startup, once)

```js
// server/agent/index.js
export async function createAgentBackend() {
  const forced = process.env.TAGTEAM_AGENT;            // "sdk" | "api" | unset
  if (forced === "api") return apiBackend();
  try {
    const sdk = await import("@anthropic-ai/claude-agent-sdk"); // throws if not installed/usable
    if (forced !== "sdk") {
      /* 1-shot smoke test: run a trivial query("Say OK", { maxTurns: 1 }) with a 20 s timeout;
         any throw/timeout → fall back. Skipped when TAGTEAM_AGENT=sdk (fail loudly instead). */
    }
    return sdkBackend(sdk);
  } catch (err) {
    console.warn("[agent] Agent SDK unavailable (%s) — falling back to Messages API", err.message);
    return apiBackend();
  }
}
```

The chosen backend is global (one probe at startup, reported in `/healthz` and the startup log
line: `agent backend: sdk` / `agent backend: api (fallback)`). Both packages are declared in
`package.json` dependencies: `@anthropic-ai/claude-agent-sdk` and `@anthropic-ai/sdk`.

### 8.2 The internal interface both implementations satisfy

```js
// backend.createAgentSession(...) — one AgentSession per TagTeam session, created lazily
// on the first run and stored at session.agent.
const agent = backend.createAgentSession({ sessionId });

// One call per turn. Serialized by the turn engine — never called concurrently per session.
await agent.run({
  userText,       // string — the fully composed user turn (§8.5). Attribution/roster already baked in.
  systemPrompt,   // string — recomputed every run (§8.5); implementations pass it fresh each call.
  onEvent,        // (evt) => void, see event union below
  signal,         // AbortSignal
});
// resolves { text: string, stopReason: "end_turn"|"max_tokens"|"aborted" }
// rejects on API/agent failure (turn engine maps to assistant_error path)

agent.dispose(); // called at session GC; must be safe to call twice
```

`onEvent` union (the runner's whole output vocabulary — turns.js maps these 1:1 onto §6 frames):

```js
{ type: "text_delta", text: "chunk of assistant prose" }
{ type: "tool_start", tool: "Read", summary: "Read demo-workspace/tpu-quotes.md" }
{ type: "tool_end",   tool: "Read", summary: "Read demo-workspace/tpu-quotes.md", ok: true }
```

Nothing else crosses this boundary. **The conversation memory strategy is an implementation
detail behind this interface** — that is the whole point of the abstraction:

| | Agent SDK impl | Messages API impl |
| --- | --- | --- |
| Memory | SDK-native: capture `session_id` from the init message on run 1, pass `resume` on later runs | keeps its own `history` array of `{role, content}` inside the AgentSession |
| Tools | read-only allowlist | none |
| `tool_start/end` events | emitted | never emitted |

### 8.3 Agent SDK implementation (`sdkRunner.js`)

Per run:

```js
const q = sdk.query({
  prompt: userText,
  options: {
    model: MODEL,                                  // see Config table, §10
    systemPrompt: systemPromptString,              // full replacement, passed every run
    resume: this.sdkSessionId ?? undefined,        // multi-turn continuity
    allowedTools: ["Read", "Grep", "Glob", "WebSearch", "WebFetch"],
    disallowedTools: ["Write", "Edit", "Bash", "NotebookEdit", "TodoWrite", "Task"],
    permissionMode: "bypassPermissions",           // safe: allowlist is read-only
    cwd: DEMO_WORKSPACE_DIR,                       // server/demo-workspace — the only files it should read
    maxTurns: 8,                                   // tool-use loop bound per run
    includePartialMessages: true,                  // REQUIRED for token streaming
    abortController,                               // bridged from `signal`
  },
});
for await (const msg of q) {
  // msg.type === "system" && msg.subtype === "init"  → this.sdkSessionId = msg.session_id
  // msg.type === "stream_event":
  //   event.type === "content_block_delta" && event.delta.type === "text_delta"
  //     → onEvent({type:"text_delta", text: event.delta.text})
  //   event.type === "content_block_start" && event.content_block.type === "tool_use"
  //     → remember block; emit tool_start when input is known (on content_block_stop),
  //       summary = `${tool}: ${primaryArg}` (file_path / pattern / query / url, truncated to 80 chars)
  // msg.type === "assistant": ignore text blocks for streaming purposes (already streamed via
  //   stream_event); use tool_use blocks as the authoritative tool_start if stream events were missed
  // msg.type === "user" (tool results): emit tool_end {ok: !content.is_error}
  // msg.type === "result": final — resolve {text: msg.result, stopReason: mapped}
}
```

Notes for the builder:
- **De-duplication rule:** stream only from `stream_event` text deltas; the final `result.result`
  string is authoritative for `assistant_complete.text`. Never emit `text_delta` from `assistant`
  messages (would double-stream).
- The read-only guarantee is the *allowlist* (`allowedTools`), not `permissionMode`. If a tool
  outside the list is somehow requested, the SDK denies it; `bypassPermissions` only removes
  interactive prompting, which a headless server cannot answer.
- `dispose()`: nothing to clean per SDK session beyond dropping `sdkSessionId` (SDK sessions are
  files on disk managed by the SDK; leaking them for a weekend POC is fine).
- Seed `server/demo-workspace/` with 2–3 small fake TPU-procurement files
  (`tpu-quotes.md`, `vendor-comparison.md`, `it-network-notes.md`) so the demo's tool use has
  something real to read. Contents are the integrator's problem; existence is this doc's contract.

### 8.4 Messages API fallback (`apiRunner.js`)

```js
import Anthropic from "@anthropic-ai/sdk";
const client = new Anthropic();                     // reads ANTHROPIC_API_KEY

// per AgentSession: this.history = []              // [{role:"user"|"assistant", content:string}]
async run({ userText, systemPrompt, onEvent, signal }) {
  this.history.push({ role: "user", content: userText });
  const stream = client.messages.stream(
    { model: MODEL, max_tokens: 4096, system: systemPrompt, messages: this.history },
    { signal },
  );
  stream.on("text", (t) => onEvent({ type: "text_delta", text: t }));
  const final = await stream.finalMessage();
  const text = final.content.filter(b => b.type === "text").map(b => b.text).join("");
  this.history.push({ role: "assistant", content: text });
  return { text, stopReason: final.stop_reason === "max_tokens" ? "max_tokens" : "end_turn" };
}
```

On rejection, pop the pushed user turn back off `history`? **No** — keep it, and on the next run
the API sees two consecutive user turns; the Anthropic API accepts consecutive same-role turns by
merging. Simpler and loses nothing. No tools in the fallback; the demo still fully works minus
the tool chips.

### 8.5 Prompt & context assembly (shared by both impls, lives in `turns.js`)

**System prompt** (recomputed every run from live state):

```
You are Claude inside TagTeam, a shared multiplayer session where several people
collaborate with you in one live conversation.

People currently in the room:
- Shash (host)
- Teja (guest)

Every human message is prefixed with the speaker's name in brackets, e.g. "[Teja]: ...".
Address people by name when you answer, especially when different people asked different
things. Never invent statements from participants. If a request needs input from a specific
person in the room, ask them directly by name.

You may use read-only tools to consult files in your workspace. Never modify anything.
```

(The tools paragraph is included only when the SDK backend is active.)

**User turn composition** (`composeUserTurn(session, batch)`):

1. If `session.rosterDirty`, prepend roster-change notes accumulated since the last run, then
   clear the flag: `(Note: Teja joined the session.)` / `(Note: Teja left the session.)` —
   needed because the SDK `resume` path can't rely on the system prompt alone being re-read,
   and it reads naturally in both impls.
2. Then each message in the batch as `[<authorName>]: <text>`, separated by blank lines.

```
(Note: Teja joined the session.)

[Shash]: Teja, can you check the firewall question?

[Teja]: Claude, which ports does the vendor portal need open?
```

Claude's replies are stored/streamed verbatim (no name prefix added to assistant text).

---

## 9. Streaming fanout (token → every browser)

```
Anthropic stream ─► runner onEvent(text_delta) ─► turns.js coalescer ─► broadcast assistant_delta ─► N sockets
```

- **Coalescing:** `turns.js` appends each `text_delta` to `activeRun.buffer` AND to the transcript
  message's `text` (transcript stays authoritative for snapshots). A flush — emit one
  `assistant_delta` with `index: deltaIndex++`, `delta: buffer`, then clear buffer — happens when
  `buffer.length ≥ 256` or a 60 ms timer fires, whichever first. This caps frame rate at ~16/s
  per session regardless of model token rate; smooth enough for a demo, cheap for `ws`.
- **Broadcast:** synchronous loop over all participants' sockets, `socket.readyState === OPEN`
  guard, `socket.send(json)`; a send error just terminates that socket (its owner can resume).
  No per-socket queues, no backpressure handling — explicitly out of POC scope (localhost demo).
- **Late joiners:** the `joined` snapshot is built synchronously in the same tick as it is sent,
  and flushes are also synchronous — so the snapshot's partial `text` exactly equals all flushed
  deltas, and every *later* flush reaches the new socket. No delta replay mechanism needed.
- **Tool events** bypass the coalescer (rare, sent immediately) but are still ordered relative to
  text because everything is emitted from the same async iteration.
- **Completion:** flush remaining buffer, set `streaming:false` and final `text` on the transcript
  message, broadcast `assistant_complete` (full text — client-side reconciliation per §6.2).

---

## 10. Configuration & guardrails checklist

| Env var | Default | Meaning |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | required | fail-fast at startup if unset |
| `PORT` | `3000` | HTTP+WS port |
| `BASE_URL` | unset | overrides invite-URL origin |
| `TAGTEAM_AGENT` | unset | `sdk` \| `api` to force a backend |
| `TAGTEAM_MODEL` | `claude-sonnet-4-5` | `MODEL` for both backends (builder: verify the current Sonnet id against the `claude-api` skill / docs at build time) |

Guardrails v0 → mechanism map:

| Brief requirement | Mechanism in this design |
| --- | --- |
| Token TTL + single use | `Invite.expiresAt` + `usedBy` set-once; checked atomically in the `join` handler (§4.2, §6.1) |
| Max 2 guests | non-kicked guest count checked at join (§4.1) |
| Revoke: kick / read-only | `revoke_guest` (§6.1); `canSend` enforced server-side on every `user_message` |
| Guests cannot mint invites | `create_invite` requires `role === "host"` (server-side check, not UI-only) |
| API key server-side only | key only ever read in `server/agent/*`; no frame or endpoint ever contains it |
| Read-only Claude | SDK `allowedTools` allowlist + `cwd` pinned to `demo-workspace/`; fallback has no tools at all |

---

## 11. Explicit assumptions for other specialists (critic: check these)

1. **Frontend** implements §6 exactly: renders from the `joined` snapshot + incremental frames,
   uses `seq` as sort key, reconciles streaming text on `assistant_complete`, stores
   `{sessionId, participantId, resumeKey}` (+ `hostKey` for the host) in `sessionStorage`, and
   auto-resumes on WS close with 1 s → 2 s → 4 s backoff (give up after 5 tries, show a banner).
   Tool chips and `inReplyTo` are optional polish; everything else in §6 is mandatory.
2. **Frontend** is a single page for both roles: role is decided by URL
   (`/` → host flow with "New session" button; `/join/<token>` → name prompt → guest flow).
   No other routes exist.
3. **Backend builder** owns enforcement of every limit in §5 and every error code in §6.2 —
   client-side checks are UX sugar only.
4. **Security/guardrails specialist:** the trust boundary is the WS `join` handshake; after join,
   the socket *is* the identity (no per-frame auth). `hostKey`/`resumeKey` never leave the owning
   browser. If you add anything (e.g. origin check on WS upgrade — recommended, same-origin
   only), layer it into `join`/upgrade without changing frame shapes.
5. **Integrator:** `package.json` declares both Anthropic packages + `ws`; `npm start` = `node
   server/index.js`; Node ≥ 20 enforced via `engines`. Seed files for `demo-workspace/` per §8.3.
   Deferred-items list for the demo script comes from the brief verbatim.
6. **Prompt/persona specialist (if any):** the system prompt template and user-turn composition
   in §8.5 are the single injection points; change the *strings*, not the mechanism.
7. Model id default `claude-sonnet-4-5` is a placeholder-grade decision — whoever builds
   `agent/index.js` verifies the current recommended Sonnet id and updates the default in one place.

## 12. Open questions (non-blocking; defaults chosen so building can proceed)

1. **Guest reconnect after `sessionStorage` loss** requires a fresh invite (§4.3). Acceptable for
   the demo? (Default: yes — demo never closes the guest tab except for the kick step.)
2. **"Max 2 guests"** interpreted as 2 *concurrent non-kicked* guests, so a kick frees a slot.
   If the critic reads the brief as "2 guest joins ever", change one comparison in the join
   handler — nothing else moves.
3. Agent SDK **`resume` + per-call `systemPrompt`**: assumed the SDK honors a fresh system prompt
   on resumed sessions. Mitigation already built in: roster changes are ALSO injected into the
   user turn (§8.5), so even if resume pins the old system prompt, attribution still works.
4. Batched-turn UX: when two queued questions are answered in one assistant message, the
   transcript shows one Claude bubble answering both. Judged fine (Claude addresses each by
   name); alternative (one run per message) doubles latency in the demo's key moment.
