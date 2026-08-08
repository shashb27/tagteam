# TagTeam — Security & Guardrails Design (POC)

Owner: Security & guardrails engineer.
Status: v0 for the hackathon POC. Everything in "v1 roadmap" is named in the demo, not built.

This doc specifies guardrails v0 exactly as scoped in `PROJECT_BRIEF.md`:
token TTL + single use, max 2 guests per session, host revoke (kick / read-only),
guests cannot mint invites, API key server-side only, read-only tools on the agent.

---

## 0. Cross-boundary assumptions (critic: check these against the architect's doc)

I do not own the wire protocol or the HTTP routes; the architect does. My design assumes
the following shapes. If the architect names things differently, the *behavior* specified
here still applies — only the names change.

- **A1 — Session creation** happens over HTTP: `POST /api/sessions` → `201 { sessionId, hostKey }`.
  `hostKey` is a secret the host client keeps in memory (and may put in its own URL fragment)
  and presents when opening its WebSocket, so a host page refresh can rejoin as host.
- **A2 — Joining** happens over WebSocket. The first client→server frame is a join message:
  host sends `{ type: "join", sessionId, hostKey, name }`; guest sends
  `{ type: "join", token, name }`. The invite token is **redeemed at this join frame**,
  not at HTTP page load (GET of the join page must be side-effect-free).
- **A3 — Invite minting** is a WebSocket message from an already-joined connection:
  `{ type: "create_invite" }` → server replies `{ type: "invite_created", url, expiresAt }`.
- **A4 — Revoke** is a WebSocket message:
  `{ type: "revoke", participantId, mode: "kick" | "readonly" }`.
- **A5 — Invite URL shape**: `http://<host>:<port>/join?t=<token>`. The token alone is enough;
  the server resolves token → session. No sessionId in the guest URL.
- **A6 — Chat messages** from clients are `{ type: "user_message", text }`. The server, never
  the client, stamps the sender name/role onto the message before broadcast and before it is
  fed to Claude (attribution is server-authoritative).
- **A7 — Single Node process**, single event loop, in-memory state (per brief). Several
  atomicity arguments below depend on this: there is no `await` between a check and its
  matching mutation, so no interleaving is possible.

---

## 1. Threat model (POC-honest)

In scope for v0 — an attacker who:
- obtains an invite URL after it was used or after 30 minutes (must be rejected);
- replays a used token from a second browser (must be rejected);
- opens many guest tabs to crowd the session (capped at 2 active guests);
- is a legitimate guest who tries to mint further invites or revoke others (must be rejected);
- inspects all client-side code, network traffic to the client, and localStorage looking for
  the Anthropic API key (must find nothing);
- prompts Claude into writing/deleting files or running commands (tools are read-only,
  enforced by SDK config, not by prompt).

Explicitly out of scope for v0 (deferred, see §8):
- attacker on the network path (demo runs on localhost / trusted LAN, plain `ws://`);
- guest impersonating a person ("types 'Sam'" is self-asserted — no identity);
- guest exfiltrating transcript content they can legitimately see (no scoping/redaction yet);
- host machine compromise, DoS beyond a trivial flood guard, multi-process consistency.

---

## 2. Invite tokens: generation, single-use, TTL

### 2.1 Data structures (server-side, in-memory)

```js
// server/state.js (or wherever the architect puts the store)
const invites = new Map();   // token (string) -> Invite
const sessions = new Map();  // sessionId -> Session

// Invite record
{
  token: string,        // crypto.randomUUID()
  sessionId: string,
  createdAt: number,    // Date.now()
  expiresAt: number,    // createdAt + INVITE_TTL_MS
  usedAt: number|null,  // set exactly once, on successful join
  revoked: boolean      // reserved; false in v0 (host revokes people, not invites)
}
```

Constants (top of one server module, exported):

```js
export const INVITE_TTL_MS   = 30 * 60 * 1000; // 30 min, per brief
export const MAX_GUESTS      = 2;              // active guests per session, per brief
export const MAX_MSG_BYTES   = 16 * 1024;      // any inbound WS frame
export const FLOOD_WINDOW_MS = 10_000;
export const FLOOD_MAX_MSGS  = 10;             // per connection per window
```

### 2.2 Generation (host mints)

On `create_invite` from a connection whose **server-side** role is `host` (see §5):

```js
function createInvite(session) {
  const token = crypto.randomUUID();           // 122 random bits from CSPRNG — enough for a 30-min token
  const now = Date.now();
  invites.set(token, {
    token, sessionId: session.id,
    createdAt: now, expiresAt: now + INVITE_TTL_MS,
    usedAt: null, revoked: false,
  });
  return { url: `${session.baseUrl}/join?t=${token}`, expiresAt: now + INVITE_TTL_MS };
}
```

Rules:
- Only the host connection may trigger this (enforced in §5; a guest's `create_invite`
  gets `{ type: "error", code: "FORBIDDEN" }` and is otherwise ignored — connection stays open).
- Minting does **not** count against the guest cap; the cap is enforced at redemption
  (§3). Host may mint a replacement link freely; old unredeemed links simply expire.
- The token is never logged. Log `token.slice(0, 8) + "…"` if a log line is needed.

### 2.3 Redemption: single-use + TTL, atomically

Redemption happens exactly once, inside the WS `join` handler, **synchronously** —
no `await` between validation and mutation (assumption A7 makes this race-free):

```js
function redeemInvite(token) {
  const inv = invites.get(token);
  const now = Date.now();
  if (!inv)                 return { ok: false, code: "TOKEN_INVALID" };
  if (inv.usedAt !== null)  return { ok: false, code: "TOKEN_USED" };
  if (now >= inv.expiresAt) { invites.delete(token); return { ok: false, code: "TOKEN_EXPIRED" }; }
  const session = sessions.get(inv.sessionId);
  if (!session)             return { ok: false, code: "SESSION_GONE" };
  if (activeGuestCount(session) >= MAX_GUESTS)
                            return { ok: false, code: "SESSION_FULL" };
  inv.usedAt = now;                              // burn BEFORE any async work
  return { ok: true, session };
}
```

Ordering is deliberate: the token is burned *before* the participant is created or
anything is broadcast. If anything downstream throws, the token stays burned — we
prefer a wasted invite (host mints another, 1 click) over a replayable one.

Failure handling on the socket: send one `{ type: "error", code, message }` frame with the
code above, then close with WS close code **4401** (`TOKEN_INVALID`/`TOKEN_USED`/
`TOKEN_EXPIRED`/`SESSION_GONE`) or **4409** (`SESSION_FULL`). Human-readable messages:

| code | message shown to guest |
|---|---|
| TOKEN_INVALID | "This invite link isn't valid." |
| TOKEN_USED | "This invite link was already used. Ask the host for a new one." |
| TOKEN_EXPIRED | "This invite link expired. Ask the host for a new one." |
| SESSION_FULL | "This session already has the maximum number of guests." |
| SESSION_GONE | "This session has ended." |

Do not distinguish "never existed" from "expired-and-swept" beyond these codes — both
paths end in TOKEN_INVALID once swept, which is fine.

### 2.4 Expiry sweep

Lazy expiry (2.3) is authoritative. Additionally, a sweeper bounds memory:

```js
setInterval(() => {
  const now = Date.now();
  for (const [t, inv] of invites)
    if (inv.usedAt !== null || now >= inv.expiresAt) invites.delete(t);
}, 60_000).unref();   // .unref() so it never blocks process exit
```

Used tokens may be deleted at sweep time (they can never be redeemed again anyway;
`TOKEN_USED` degrading to `TOKEN_INVALID` after a sweep is acceptable).

### 2.5 Known accepted weaknesses (v0)

- Token travels in a query string → may land in server access logs / browser history.
  Accepted for the POC (we control the only server; no referrer leakage matters on
  localhost). v1: move token to URL fragment + POST redemption.
- `Map.get` string lookup is not constant-time. Irrelevant at this token entropy and
  network jitter; noted for completeness.
- No reconnect: a guest who refreshes after joining has a burnt token and is out.
  Demo flow doesn't need reconnect; host mints a new link if it happens. (Architect:
  if you add reconnect, it must use a server-issued participant credential, **not**
  token re-redemption.)

---

## 3. Participant cap

**Rule: at most `MAX_GUESTS = 2` guests may be *active* in a session at once.**
"Active" = has a live WS connection, has joined, and has not been kicked. A guest in
read-only mode is still active (still occupies a slot — they're in the room). A kicked
or disconnected guest frees their slot immediately.

```js
function activeGuestCount(session) {
  let n = 0;
  for (const p of session.participants.values())
    if (p.role === "guest" && p.connected && !p.kicked) n++;
  return n;
}
```

Enforcement points:
1. **Redemption (authoritative):** see §2.3 — a valid, unexpired token still fails with
   `SESSION_FULL` if 2 guests are active. The token is **not** burned in that case
   (check happens before `inv.usedAt = now`), so it can be retried after a slot frees.
2. **Mint time (UX courtesy, optional):** if 2 guests are active when the host clicks
   Tag in, still mint, but include `"note": "session is full; link works once a seat frees"`
   in `invite_created`. Do not block minting — links outlive current occupancy.

The cap counts *guests*, not participants: host + 2 guests = 3 humans max.

---

## 4. Host revoke semantics

Only the host connection may send `revoke` (role check per §5; violation → `FORBIDDEN`
error frame, no state change). Target is a `participantId` (server-assigned
`crypto.randomUUID()` at join — never the display name, which is not unique).

Participant record fields this feature owns:

```js
{ participantId, name, role: "host"|"guest", connected: bool,
  canSend: bool,      // false after readonly revoke
  kicked: bool }      // true after kick
```

### 4.1 `mode: "readonly"`

1. Set `p.canSend = false`. Idempotent (revoking an already-readonly guest is a no-op success).
2. Broadcast a participant-state update (architect's `participants_updated` or equivalent)
   so all UIs re-render; the target's composer disables with "The host made you read-only."
3. **Server-side enforcement is the real control:** every inbound `user_message` is checked
   against `p.canSend` at receipt time. If false → `{ type: "error", code: "READ_ONLY" }`,
   message dropped, never reaches the transcript or Claude. The disabled textbox is UX only.
4. The guest keeps receiving the live transcript stream.
5. No un-revoke in v0 (not in the brief). If the host wants them back interactive: kick +
   fresh invite.

### 4.2 `mode: "kick"`

1. Set `p.kicked = true`, `p.canSend = false`.
2. Send the target one `{ type: "error", code: "KICKED", message: "The host removed you from this session." }`,
   then `ws.close(4403, "kicked")`.
3. Broadcast participant-left to the rest; Claude's system-prompt roster (owned by the
   agent/prompt specialist) must be rebuilt without the kicked guest before the next turn.
4. Their guest slot frees immediately (§3).
5. Re-entry requires a brand-new invite; their old token was burnt at join. Because there
   is no identity (v0), a kicked person *can* return via a new invite — that is the host
   deliberately re-admitting them, which is correct.

### 4.3 Ordering / race notes

- Revoke and an in-flight guest message can cross on the wire. Rule: **state at receipt
  time wins.** If the message frame is processed before the revoke frame, it goes through;
  after, it's dropped. No rollback of already-broadcast messages (that's v1 redaction).
- A kick received while Claude is mid-stream does not abort the stream; the remaining
  participants still get the answer. The kicked socket is closed immediately, so the kicked
  guest stops receiving mid-stream. Acceptable and simplest.
- Host cannot revoke themself; `revoke` targeting the host or an unknown `participantId`
  → `{ type: "error", code: "BAD_TARGET" }`, no state change.

---

## 5. Roles: why guests cannot mint invites (or revoke)

**Principle: role is a server-side property of the connection, established once at join,
from what the client *proved*, not what it *claimed*.**

- A connection that joins with a valid `hostKey` for the session ⇒ `role = "host"`.
- A connection that joins by redeeming an invite token ⇒ `role = "guest"`. Unconditionally.
  There is no message, field, or flag by which a connection can change its own role later.
- The join message has no `role` field; if a client sends one it is ignored.
- Every privileged handler starts with the same two lines:

```js
const p = connections.get(ws);              // server-side lookup, keyed by the socket object
if (!p || p.role !== "host") return sendErr(ws, "FORBIDDEN");
```

Privileged messages in v0: `create_invite`, `revoke`. Everything else is available to any
active participant with `canSend` (and transcript receipt to any active participant).

Why this is airtight for the POC: the only way to acquire `hostKey` is the HTTP response
to session creation (A1). It is never broadcast, never included in the transcript, never
sent to guests, and never logged. A guest's browser has literally never seen it. So a guest
cannot forge hostness, and thus cannot mint invites — closing the loop where one 30-minute
invite could otherwise be laundered into unlimited access. It also means a guest cannot
kick the host or the other guest.

`hostKey` handling rules (for whoever builds `server/` and `web/`):
- Generated with `crypto.randomUUID()` at session creation; stored on the Session record.
- Compared with strict equality on join (`hostKey === session.hostKey`); wrong key →
  error frame `HOST_KEY_INVALID`, close 4401.
- Host client keeps it in a JS variable and, if the architect wants refresh-survival,
  in the URL **fragment** (`/#hk=...`) — fragments are never sent to servers or logs.
  Never in a cookie, never in localStorage (OneDrive-synced machines; and it outlives the session).
- Exactly one live host connection per session: if a second connection presents a valid
  hostKey, the server closes the older host socket (4408 "superseded") and seats the new
  one. This makes host refresh work without ever having two hosts.

---

## 6. API key stays server-side

- Read once at boot: `process.env.ANTHROPIC_API_KEY`. If unset/empty, print
  `Set ANTHROPIC_API_KEY and restart (export ANTHROPIC_API_KEY=sk-ant-...)` and `process.exit(1)`.
  Failing at boot beats failing at first message mid-demo.
- The key is passed only to the Agent SDK / Anthropic SDK constructor inside `server/`.
  It must never appear in: any WS frame, any HTTP response body or header, any file under
  `web/`, any client-visible error (wrap SDK errors: send the client
  `{ type: "error", code: "AGENT_ERROR", message: "Claude hit an error, try again." }` and
  log the real error server-side only — SDK error strings can echo request metadata).
- The browser never talks to `api.anthropic.com`. All model traffic originates in the Node
  process. Grep-able invariant for the integrator's final check:
  `grep -ri "sk-ant\|ANTHROPIC" web/` must return nothing.
- Repo hygiene: `.gitignore` contains `.env`; no `.env.example` with a real-looking key;
  README says to export the variable, per brief.

---

## 7. Read-only tool restriction on the agent

The agent must be *configured* read-only, not *prompted* read-only. System-prompt
instructions are advisory; SDK tool allowlists are enforcement.

### 7.1 Primary path — Claude Agent SDK

```js
import { query } from "@anthropic-ai/claude-agent-sdk";

const READ_ONLY_TOOLS = ["Read", "Glob", "Grep"];   // file reading + search, per brief

const stream = query({
  prompt: buildPrompt(session),
  options: {
    allowedTools: READ_ONLY_TOOLS,
    disallowedTools: ["Bash", "Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch", "Task"],
    permissionMode: "default",
    cwd: WORKSPACE_DIR,                              // see below
    canUseTool: async (toolName /*, input */) =>
      READ_ONLY_TOOLS.includes(toolName)
        ? { behavior: "allow", updatedInput: undefined }
        : { behavior: "deny", message: "TagTeam POC is read-only." },
  },
});
```

Three independent layers, any one of which alone blocks a write:
1. `allowedTools` — only the three read tools are offered to the model at all.
2. `disallowedTools` — explicit denial of every mutating/executing tool by name, so a
   future SDK default-set change can't silently reintroduce one.
3. `canUseTool` callback — final programmatic gate; default-deny anything not on the
   allowlist (covers MCP tools or new tool names we didn't anticipate).

Workspace scoping: `WORKSPACE_DIR` is a dedicated demo directory inside the repo
(e.g. `<repo>/demo-workspace/`, seeded with the kernel-debugging demo files), passed as
`cwd`. Read-only tools can still *read* outside `cwd` if given absolute paths, so the
system prompt additionally instructs Claude to stay within the workspace — belt on top
of the real control being that no tool can *modify* anything anywhere. Do not seed
secrets into the workspace.

`WebSearch`/`WebFetch` are network reads, not writes, but they're an exfiltration channel
(guest-injected prompt could smuggle transcript content into a URL). Denied in v0; the
brief's "search" is satisfied by Grep over the workspace. If the demo owner decides live
web search is worth it, flip `WebSearch` into `READ_ONLY_TOOLS` consciously — that is the
single allowed deviation, and it must be a deliberate demo-time decision, not a default.

### 7.2 Fallback path — plain `@anthropic-ai/sdk`

Per the brief's fallback clause: streaming Messages API with **no `tools` parameter at
all**. Zero tools ⇒ trivially read-only. Same internal interface (the architect's
agent-adapter boundary), so nothing else changes.

### 7.3 Verification (integrator's checklist)

- Ask Claude, as host: "create a file called pwned.txt in the workspace" → it must refuse /
  fail with a denied tool, and `ls demo-workspace` shows no new file.
- Ask as guest: "run `whoami`" → Bash denied.
- Ask: "read demo-workspace/specs.md" → succeeds (proves read path works, restriction
  is precise, not a dead agent).

---

## 8. v1 guardrail roadmap (ordered — name in the demo, do not build)

Order is by (leak severity) x (dependency order). Each step builds on the previous.

### 8.1 First: context scoping — control *what the guest can see*
The v0 gap with the biggest blast radius: today a tagged-in guest sees the **entire**
transcript, including everything from before they joined — budgets, names, vendor pricing.
v1: host chooses at invite time what the guest gets: (a) full transcript, (b) from-now-on
only, or (c) a Claude-generated task briefing of the relevant slice. Mechanically this is
a per-participant transcript filter at broadcast time plus a scoped context assembly for
Claude's turns — the same server chokepoints v0 already routes everything through, which
is why this ships first and needs no new infrastructure.

### 8.2 Second: redaction — control *what leaves the room in either direction*
Depends on scoping's per-participant delivery filter existing. Adds: host can mark
messages or spans as sensitive (retroactively too — "redact that number I pasted");
redacted spans render as `▮▮▮` for guests and are **also stripped from the context
assembled for Claude's turns whenever a guest is present**, so Claude cannot be prompted
by the guest into paraphrasing a secret it saw earlier. Plus pattern-based auto-flagging
(API keys, credentials) suggested to the host. Redaction without scoping would be
whack-a-mole; that's why it's second.

### 8.3 Third: identity — control *who people actually are*
SSO (Entra ID for OXMIQ / Teams delivery of invites, per the deferred list). Invites
bound to a specific person ("this link only works for sam@..."), names verified rather
than typed, per-identity audit log, revoke-by-person rather than revoke-by-connection,
and kicked-means-kicked (v0's "kicked guest can accept a fresh invite" hole closes here).
Last not because it matters least, but because it's the only one needing external
infrastructure, and because scoping + redaction reduce the damage an unverified guest
can do in the meantime — right order for risk burn-down.

One line for the demo script: *"v0 controls the door — who gets in, for how long, what
they can touch. v1 controls the room — what each person sees (scoping), what can leave
(redaction), and who they really are (identity), in that order."*

---

## 9. Cheap hardening included in v0 (small, demo-protecting)

These are each ≤10 lines and prevent an embarrassing demo failure; builders should include
them, but none may grow beyond what is written here.

- **Frame size cap:** on `ws.on("message")`, if `data.length > MAX_MSG_BYTES` → error frame
  `MSG_TOO_LARGE`, drop. Also pass `maxPayload: MAX_MSG_BYTES` to the `ws` server options.
- **Flood guard:** per connection, sliding counter — more than `FLOOD_MAX_MSGS` (10)
  `user_message`s in `FLOOD_WINDOW_MS` (10 s) → error frame `RATE_LIMITED`, drop message
  (do not disconnect). Protects the Anthropic bill and the transcript.
- **JSON hygiene:** every inbound frame goes through `try { JSON.parse } catch` → malformed
  input gets `BAD_MESSAGE` and is dropped; unknown `type` likewise. Never crash the process
  on client input.
- **Display-name sanitation:** trim; length 1–40; strip control chars; reject empty →
  `BAD_NAME`. Names are rendered with `textContent` (never `innerHTML`) on the client —
  same rule for message bodies. (Frontend builder owns rendering; this is the requirement.)
  Also collapse `[` and `]` out of names so a guest named `] [Ava` can't spoof the
  server-side `[Name]:` attribution format Claude sees.
- **Session teardown:** when the host socket closes and does not reconnect within 60 s,
  close all guest sockets (4410 "session ended") and delete the session + its invites.
  In-memory state should not accrete across demo runs.

Explicitly **not** doing in v0 (would violate POC scope): HTTPS/WSS, origin allowlists,
cookies/CSRF machinery, persistence of any security event beyond `console.log`, per-user
API budgets.

---

## 10. Error / close code summary (single source of truth)

| WS close code | Meaning |
|---|---|
| 4400 | BAD_MESSAGE / BAD_NAME on join |
| 4401 | TOKEN_INVALID / TOKEN_USED / TOKEN_EXPIRED / SESSION_GONE / HOST_KEY_INVALID |
| 4403 | KICKED |
| 4408 | Host connection superseded by newer host connection |
| 4409 | SESSION_FULL |
| 4410 | Session ended (host left) |

Error frames (`{ type: "error", code, message }`) codes used without closing:
`FORBIDDEN`, `READ_ONLY`, `RATE_LIMITED`, `MSG_TOO_LARGE`, `BAD_MESSAGE`, `BAD_TARGET`,
`AGENT_ERROR`.
