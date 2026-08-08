# TagTeam Frontend Design — static HTML/JS/CSS client

Author: Frontend engineer (design). Status: ready to implement.
Scope: everything under `web/`. No build step, no framework, no external
dependencies (no CDN scripts, no fonts fetched at runtime). Plain ES2022
JavaScript, one HTML page, one stylesheet, one script.

Anything marked **ASSUMPTION** is a contract this design expects from the
architect/backend. If the architect's protocol doc says otherwise, the
architect's doc wins and the deltas here must be reconciled by the critic.

---

## 1. Files

```
web/
  index.html   — single page, serves both host and guest flows
  style.css    — all styles, CSS custom properties at top
  app.js       — all logic, loaded as <script type="module">
```

- **ASSUMPTION (server):** the server serves `web/` statically and routes both
  `GET /` and `GET /join` to `web/index.html` (same file; the client decides
  which flow to run from the URL). `style.css` and `app.js` are served at
  `/style.css` and `/app.js`.
- No other assets. The favicon is an inline `<link rel="icon" href="data:,">`
  to suppress the 404.

## 2. URL scheme and flow selection

| URL | Flow |
| --- | --- |
| `/` | Host flow: name gate → create session → chat |
| `/join?t=<inviteToken>` | Guest flow: name gate → redeem token → chat |

`app.js` boot logic:

```js
const inviteToken = new URLSearchParams(location.search).get('t');
const role = inviteToken ? 'guest' : 'host';
```

- **ASSUMPTION (backend):** the invite URL minted by the server is exactly
  `<origin>/join?t=<token>` where `<token>` is opaque (UUID). The client never
  parses the token; it only passes it back verbatim in the join message.
- The client does not implement any other routes. Opening `/join` without a
  `t` param shows the fatal error screen (section 9) with "This invite link is
  incomplete. Ask the host for a new one."

## 3. Wire protocol used by the client

Transport: one WebSocket to `ws(s)://<location.host>/ws`, opened after the
user submits their display name. All frames are JSON objects with a `type`
field. **ASSUMPTION:** this entire section is the protocol; it is my proposed
contract in the absence of the architect's doc. Field names below are exact.

### 3.1 Client → server

| type | payload | when |
| --- | --- | --- |
| `create_session` | `{ name: string }` | host, immediately after WS open |
| `join_session` | `{ name: string, token: string }` | guest, immediately after WS open |
| `user_message` | `{ text: string }` | composer submit (host or writable guest) |
| `create_invite` | `{}` | host clicks "Tag in" |
| `revoke_guest` | `{ participantId: string, mode: "readonly" \| "kick" }` | host clicks a control in the participants panel |

`name` is trimmed, 1–40 chars (client-enforced; server re-validates).
`text` is trimmed, 1–4000 chars, non-empty.

### 3.2 Server → client

| type | payload | client behavior |
| --- | --- | --- |
| `session_state` | `{ sessionId, selfId, participants: Participant[], messages: Message[] }` | sent once after successful create/join; client renders full transcript and enters CHAT state |
| `participant_joined` | `{ participant: Participant }` | add to panel, append system line "Sam joined" |
| `participant_left` | `{ participantId }` | mark offline in panel, system line "… left" |
| `participant_updated` | `{ participant: Participant }` | e.g. `canWrite` flipped; re-render panel; if it is self, apply read-only state (section 8) |
| `participant_removed` | `{ participantId }` | remove from panel, system line; if self → kicked overlay (section 8) |
| `chat_message` | `{ message: Message }` | append a completed human message (including the echo of your own — see 5.4) |
| `assistant_start` | `{ messageId }` | create streaming bubble with typing indicator |
| `assistant_delta` | `{ messageId, text }` | append `text` to that bubble |
| `assistant_end` | `{ messageId }` | finalize bubble (re-render body through the markdown-lite pass, drop indicator) |
| `invite_created` | `{ url, token, expiresAt }` | show invite panel; `expiresAt` is epoch ms |
| `error` | `{ code, message, fatal: boolean }` | fatal → error screen; non-fatal → toast (section 9) |

Shapes:

```js
Participant = { id: string, name: string, role: "host"|"guest",
                canWrite: boolean, online: boolean }
Message     = { id: string, authorId: string|null, authorName: string,
                authorRole: "host"|"guest"|"assistant"|"system",
                text: string, ts: number }
```

- **ASSUMPTION:** Claude messages arrive with `authorRole: "assistant"`,
  `authorName: "Claude"`. Join/leave/revoke system lines MAY come as
  `chat_message` with `authorRole: "system"`; the client also synthesizes its
  own local system lines from `participant_*` events, and de-duplicates by
  preferring server-sent system messages if both exist is NOT attempted —
  builders must pick one source. Decision for this client: **the client
  synthesizes all system lines locally from `participant_*` events** and the
  server should not send system chat messages. Flagged for the architect.
- Error codes the client special-cases: `TOKEN_INVALID`, `TOKEN_EXPIRED`,
  `TOKEN_USED`, `SESSION_FULL`, `READ_ONLY`, `SESSION_NOT_FOUND`. All are
  fatal except `READ_ONLY` (toast: "You are read-only in this session").

### 3.3 Ordering and echo

The server is the single source of truth for transcript order. The client
does **no optimistic rendering**: your own message appears only when the
server echoes it back as `chat_message`. On localhost this is imperceptible
and it removes all de-dup/reorder logic. The composer clears immediately on
send (optimistic clear only).

### 3.4 Connection lifecycle

- No auto-reconnect in the POC. On `close`/`error` after a session was
  established: freeze the UI, disable the composer, show a full-width red
  banner "Connection lost — reload the page to continue" with a Reload
  button. (Reload restarts the host flow cleanly; for a guest whose
  single-use token is spent this is a dead end — acceptable POC limitation,
  named in the demo. Open question 1 proposes a rejoin key if the backend
  wants to support it.)
- A 20s client-side timeout on the initial create/join handshake: if no
  `session_state` or fatal `error` arrives, show the fatal error screen with
  "Could not reach the session server."

## 4. Page structure (index.html)

One page, three top-level screens toggled by a `data-screen` attribute on
`<body>` (`gate | chat | fatal`). Everything below exists in the static HTML;
JS only fills content and toggles visibility. Exact skeleton:

```html
<body data-screen="gate">
  <!-- Screen 1: name gate -->
  <main id="gate" class="gate">
    <h1 class="logo">TagTeam</h1>
    <p id="gate-sub" class="gate-sub"><!-- host: "Start a shared Claude session."
        guest: "You've been tagged into a live Claude session." --></p>
    <form id="gate-form">
      <input id="name-input" type="text" maxlength="40" autocomplete="off"
             placeholder="Your display name" required>
      <button id="gate-btn" type="submit"><!-- "Start session" / "Join session" --></button>
    </form>
    <p id="gate-note" class="gate-note hidden"><!-- guest only: "Invite links are
        single-use and expire. If this one fails, ask the host to tag you in again." --></p>
  </main>

  <!-- Screen 2: chat -->
  <div id="chat" class="chat hidden">
    <header class="topbar">
      <span class="logo-sm">TagTeam</span>
      <span id="session-label" class="session-label"></span>   <!-- "Session a1b2c3" (first 6 of sessionId) -->
      <span id="conn-dot" class="conn-dot" title="Connected"></span>
      <button id="tagin-btn" class="btn-primary">Tag in a colleague</button> <!-- host only -->
    </header>

    <div class="chat-body">
      <section id="transcript" class="transcript" aria-live="polite"></section>
      <aside id="sidebar" class="sidebar">
        <h2>In the room</h2>
        <ul id="participants"></ul>
        <div id="invite-panel" class="invite-panel hidden"><!-- filled by JS, see 6 --></div>
      </aside>
    </div>

    <div id="banner" class="banner hidden"></div>  <!-- read-only / disconnected notices -->

    <form id="composer" class="composer">
      <textarea id="composer-input" rows="1" maxlength="4000"
                placeholder="Message Claude…"></textarea>
      <button id="send-btn" type="submit">Send</button>
    </form>
  </div>

  <!-- Screen 3: fatal error / kicked -->
  <main id="fatal" class="gate hidden">
    <h1 class="logo">TagTeam</h1>
    <p id="fatal-msg"></p>
    <a href="/" id="fatal-home">Start your own session</a>
  </main>
</body>
```

Host vs guest differences on the chat screen: `#tagin-btn` is removed from
the DOM (not just hidden) for guests; per-guest revoke controls in
`#participants` render only for the host.

## 5. Transcript rendering

### 5.1 Message DOM

Each transcript entry is one of:

```html
<!-- human or assistant message -->
<article class="msg msg-human|msg-assistant" data-mid="<messageId>" style="--author-hue: 210">
  <div class="msg-meta">
    <span class="msg-author">Ava</span>
    <span class="msg-role">host</span>      <!-- host | guest | Claude -->
    <span class="msg-time">14:32</span>
  </div>
  <div class="msg-body"><!-- rendered text, see 5.3 --></div>
</article>

<!-- system line -->
<div class="sysline">Sam joined the session</div>
```

### 5.2 Attribution

- Author name always shown; role chip next to it (`host` grey, `guest` grey,
  `Claude` accent-colored). Claude messages additionally get a distinct
  left-aligned card style (`.msg-assistant`: subtle tinted background,
  accent left border) so the eye separates AI from humans instantly.
- Per-human color: deterministic hue from the participant id —
  `hue = 40 + (djb2(participantId) % 8) * 40` — applied as `--author-hue`
  and used for the author-name color and the message's 3px left border.
  Claude uses a fixed accent (see 10). Same person = same color for every
  viewer on every reload.
- Consecutive messages from the same author within 3 minutes collapse the
  meta row (add class `msg-cont`, meta hidden via CSS) — cheap, purely
  additive polish; skip if time-pressed.

### 5.3 Text rendering (markdown-lite, XSS-safe)

Never assign untrusted text to `innerHTML` raw. Pipeline, in order:

1. HTML-escape the whole string (`& < > " '`).
2. Extract fenced code blocks (```…```) into placeholders; each becomes
   `<pre class="code"><code>…</code></pre>` (content already escaped; language
   tag ignored).
3. On the remainder: inline `` `code` `` → `<code>`, `**bold**` → `<strong>`,
   `*italic*` → `<em>` (non-greedy regexes, single line).
4. Split on `\n\n` into `<p>`, single `\n` → `<br>`.
5. Reinsert code-block placeholders. Assign the result with `innerHTML`.

That's the whole renderer (~30 lines). No links auto-linking, no lists, no
headings — Claude's answers stay readable and nothing can inject markup.
Human messages go through the same pipeline.

### 5.4 Streaming

- `assistant_start`: append an assistant `article` with body
  `<span class="cursor"></span>` (blinking block via CSS animation) and store
  it in `streams[messageId] = { el, text: "" }`.
- `assistant_delta`: `stream.text += delta`; re-render throttled via
  `requestAnimationFrame` (coalesce deltas arriving faster than a frame):
  set body to `renderText(stream.text)` + trailing cursor. Re-rendering the
  whole bubble per frame is fine at POC transcript sizes and keeps the
  markdown pass correct across chunk boundaries.
- `assistant_end`: final `renderText(stream.text)`, remove cursor, delete
  from `streams`.
- If a `chat_message` arrives mid-stream (another human typed), it simply
  appends after the streaming bubble — interleaving is whatever order the
  server sent.

### 5.5 Autoscroll

Stick-to-bottom: on every append/delta, if the user was within 80px of the
bottom before the mutation, `scrollTop = scrollHeight` after it. If the user
has scrolled up, do not yank; instead show a floating "↓ New messages" pill
(`#jump-latest`, absolutely positioned over the transcript) that scrolls to
bottom and hides on click or when the user reaches the bottom themselves.

## 6. Tag-in invite UI (host only)

- `#tagin-btn` in the topbar. Click → send `create_invite`, set button to
  disabled "Creating…" until `invite_created` or error.
- On `invite_created`, `#invite-panel` (in the sidebar) becomes visible:

```html
<div class="invite-panel">
  <h3>Invite link</h3>
  <input id="invite-url" readonly value="http://localhost:3000/join?t=…">
  <button id="copy-btn">Copy link</button>
  <p class="invite-meta">Single use · expires in <span id="invite-ttl">29:58</span></p>
</div>
```

- **Copy:** `navigator.clipboard.writeText(url)`; on rejection (non-secure
  context is possible if demoing over LAN IP), fall back to
  `input.select(); document.execCommand('copy')`. Button text flips to
  "Copied ✓" for 1.5s.
- **TTL countdown:** 1s `setInterval` rendering `mm:ss` from
  `expiresAt - Date.now()`; at 0, panel body is replaced with "Link expired —
  tag in again to mint a new one" and the interval is cleared.
- Minting again replaces the panel contents (client shows only the most
  recent invite; older tokens live or die server-side).
- **Guest cap:** the client does not pre-compute the 2-guest limit. If the
  server rejects the mint (**ASSUMPTION:** non-fatal `error` with code
  `SESSION_FULL`), show toast "Guest limit reached (2). Remove a guest
  first." and re-enable the button. Server is the enforcer; client just
  reports.

## 7. Participants panel + host controls

Each `#participants` entry:

```html
<li class="pt" data-pid="…" style="--author-hue: 210">
  <span class="pt-dot"></span>            <!-- filled = online, hollow = offline -->
  <span class="pt-name">Sam</span>
  <span class="pt-badge">guest</span>     <!-- host | guest | read-only -->
  <span class="pt-actions">               <!-- host viewing a guest only -->
    <button class="pt-ro" title="Toggle read-only">👁</button>
    <button class="pt-kick" title="Remove from session">✕</button>
  </span>
</li>
```

Claude is pinned as the first row (name "Claude", badge "AI", always online),
rendered by the client — it is not in `participants[]`.

- `👁` sends `revoke_guest {participantId, mode:"readonly"}`. **ASSUMPTION:**
  the same message with the same mode toggles back to writable (server flips
  `canWrite` and broadcasts `participant_updated`); if the architect makes it
  one-way, the button hides after use. Read-only guests show the `read-only`
  badge (replaces `guest`).
- `✕` sends `revoke_guest {participantId, mode:"kick"}` after a
  `confirm("Remove Sam from the session?")`. Server broadcasts
  `participant_removed` and closes the guest's socket.
- No confirmation for read-only (reversible), confirm for kick (terminal).

## 8. Read-only and revoked states (guest side)

Driven entirely by server events about *self*:

- **Read-only** (`participant_updated` where `participant.id === selfId` and
  `canWrite === false`): composer textarea and Send disabled
  (`disabled` attribute + `.composer-disabled` styling), placeholder swapped
  to "Read-only — you can watch but not send", and `#banner` shows the amber
  notice "The host set you to read-only." Transcript keeps streaming live.
  If `canWrite` flips back to `true`: re-enable, hide banner, toast "You can
  send messages again."
- **Kicked** (`participant_removed` for self, or socket closed by server
  right after): switch to the fatal screen with message "The host removed
  you from this session." Distinguishing kick from a network drop: if a
  `participant_removed` for self was seen, it's a kick; otherwise show the
  generic disconnect banner. The server should send the removal event
  *before* closing the socket (**ASSUMPTION**).
- **Belt-and-braces:** if a read-only client somehow submits (e.g. Enter
  before the event landed), the server answers `error {code:"READ_ONLY",
  fatal:false}` → toast, no crash.

## 9. Composer, errors, toasts

**Composer:** `<textarea>` auto-grows 1→6 rows (`el.style.height` from
`scrollHeight`, reset on send). Enter sends, Shift+Enter inserts newline.
Send is a no-op for empty/whitespace text. The composer stays **enabled while
Claude is streaming** — multiplayer means anyone can queue the next message;
the server owns turn-taking (**ASSUMPTION:** server accepts `user_message`
mid-stream and queues or interleaves it).

**Fatal errors** (`error.fatal === true`, or handshake failures): show screen
`#fatal` with a human message per code:

| code | message |
| --- | --- |
| `TOKEN_INVALID` | "This invite link isn't valid. Ask the host to tag you in again." |
| `TOKEN_EXPIRED` | "This invite link has expired (links last 30 minutes)." |
| `TOKEN_USED` | "This invite link was already used. Links are single-use." |
| `SESSION_FULL` (on join) | "This session already has the maximum number of guests." |
| `SESSION_NOT_FOUND` | "This session has ended." |
| anything else | server's `message` verbatim, else "Something went wrong." |

**Toasts** (non-fatal): fixed bottom-center stack, auto-dismiss 4s, max 3
visible. Used for `READ_ONLY`, `SESSION_FULL` on mint, clipboard failure,
and unknown non-fatal errors.

## 10. Visual design (style.css)

Single light theme; dark mode deferred to v1 (say so in the demo if asked).
Design tokens at the top of `style.css`:

```css
:root {
  --bg: #f7f7f5;         /* page */
  --surface: #ffffff;    /* cards, composer, sidebar */
  --border: #e4e2dd;
  --text: #1f1e1b;
  --text-dim: #6f6c65;
  --accent: #b3541e;     /* Claude / primary actions (warm rust) */
  --accent-soft: #faf1ea;/* assistant bubble bg */
  --danger: #b3261e;
  --warn-bg: #fdf3d7;    /* read-only banner */
  --radius: 10px;
  --font: system-ui, -apple-system, "Segoe UI", sans-serif;
  --mono: ui-monospace, "SF Mono", Menlo, monospace;
}
```

Layout: topbar 52px; `.chat-body` is `display:flex` — transcript flexes,
sidebar fixed `240px` (collapses under 720px viewport to a topbar toggle —
optional, demo runs on desktop; if cut, sidebar just stacks below on narrow
screens via `flex-wrap`). Composer pinned at bottom of the flex column.
Transcript max content width 760px centered. Messages are full-width rows
(not chat-app left/right bubbles) — this is a shared working session, not a
DM, and rows keep multi-party attribution scannable. Code blocks:
`--mono`, `overflow-x:auto`, tinted background. `prefers-reduced-motion`
disables the cursor blink and toast slide.

## 11. app.js internal structure

Single module, ~450 lines, top-to-bottom:

```
state: { role, selfId, sessionId, ws, participants: Map, streams: Map,
         connected, readOnly }
boot()            — parse URL, wire gate form, pick flow
connect(hello)    — open WS, send create_session|join_session, arm 20s timer
handlers = { session_state, participant_joined, ... }   — one function per type
sendMsg(type, payload)
renderMessage(m) / renderSystem(text) / renderText(raw)  — 5.1–5.3
renderParticipants()                                     — full re-render of the list
invite: onTagIn(), onInviteCreated(), ttlTick()
composer: autosize, keydown, submit
scroll: isNearBottom(), maybeScroll(), jump-pill
toast(msg) / fatal(msg) / banner(msg|null)
util: esc(), djb2(), fmtTime(), fmtTTL()
```

Rules for the builder: no classes needed, module-level `state` object;
every server frame goes through one `ws.onmessage` switch that dispatches to
`handlers[type]` and ignores unknown types (forward compatibility with
whatever the architect adds); all DOM lookups cached once at boot.

## 12. Demo-fit checklist (maps to success criteria)

1. Host `/` → name → chat with streaming Claude: sections 2, 5.4, 9.
2. Tag in → copy link → guest joins, full transcript: sections 6, 2, 3.2
   (`session_state.messages` backfill).
3. Guest asks, Claude answers by name, host sees live: sections 5.2, 3.3
   (broadcast echo).
4. Revoke → guest can't send: sections 7, 8.
5. No build step: section 1 — three static files, zero dependencies.

---

## Open questions for architect / backend (do not block on these; the
defaults above are what the frontend will implement)

1. **Reconnect/rejoin:** does the backend want to issue a `rejoinKey` in
   `session_state` so a reloaded guest can re-attach despite the spent
   single-use token? Frontend currently treats disconnect as terminal
   (section 3.4) and will happily add a `rejoin` hello if the protocol
   grows one.
2. **System lines:** confirm the server will NOT emit `authorRole:"system"`
   chat messages (client synthesizes join/leave/revoke lines locally,
   section 3.2) — otherwise guests get doubles.
3. **Read-only reversibility:** is `revoke_guest {mode:"readonly"}` a toggle
   (assumed) or one-way?
4. **Invite mint transport:** assumed over the WebSocket (`create_invite` /
   `invite_created`), not a REST endpoint.
5. **Concurrent sends while Claude streams:** assumed the server accepts and
   orders them; if the server instead rejects with a non-fatal error code
   (e.g. `BUSY`), the client will toast it — please name the code.
