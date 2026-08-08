# TagTeam — Product & UX Design

Author: Product & UX designer (swarm role). Scope: user flows, screens, states, microcopy,
attribution, invite/join/revoke experience, demo script. Implementation-ready: an engineer
should be able to build the frontend behavior and all user-facing states from this doc alone.

Cross-doc assumptions (protocol names, token semantics) are marked **ASSUMPTION** so the
critic can catch mismatches with the architect's protocol doc. Where the architect's wire
protocol differs in naming, the architect's doc wins; the *behavior* specified here must
still be delivered.

---

## 1. Product principles (POC)

1. **Zero-friction join.** The guest goes from link-click to sending a message in one step:
   type a name, press Enter. No account, no email, no confirmation screens.
2. **Always know who's talking.** Every message in the transcript carries a name and a role
   badge. Claude addresses people by name. Ambiguity is the failure mode we're killing.
3. **Host is in control, visibly.** Invite, revoke, and roster controls live only on the
   host's screen. Guests can see who's present but cannot manage anyone.
4. **The demo is the product.** Every state below must look good in two side-by-side browser
   windows at ~960px wide each. No state may dead-end without a message telling the user
   what happened and what to do next.

---

## 2. Personas and scenario (fixed for the demo)

- **Host: "Ava"** — Software engineer. Mid-task with Claude debugging kernel perf on the new accelerator. Needs hardware-team input.
- **Guest: "Sam"** — Senior hardware architect. Has the answer about board timing and memory-bandwidth constraints. Currently would
  have to relay through Ava; TagTeam lets him talk to Claude directly.
- **Claude** — the third participant. Knows the roster via system prompt, addresses people
  by name.

---

## 3. Information architecture / routes

Single static client served by the Node server. Two entry routes, one page:

| URL | Who | What renders |
|---|---|---|
| `/` | Host | "Start a session" screen → session screen |
| `/join?token=<uuid>` | Guest | "Join session" screen → session screen (or error state) |

**ASSUMPTION (protocol):** after the session screen loads, all traffic is one WebSocket per
participant. The client opens the socket, then sends a single auth/hello message carrying
either `{ role: "host", sessionId?, name }` or `{ role: "guest", token, name }`, and the
server replies with a snapshot: session id, full transcript so far, roster, and the caller's
own participant id + capabilities (`canSend`, `canInvite`). Everything after that is
incremental events. If the architect specifies different message names, map 1:1.

There is exactly **one session per server run** in spirit, but the design does not assume
that: the host screen always creates a fresh session; a guest token binds to one session.

---

## 4. Screens

### 4.1 Host landing (`/`)

Minimal, centered card:

- Title: **TagTeam** with tagline underneath: *"Stop playing telephone with your AI."*
- One text input, label **"Your name"**, placeholder `e.g. Ava`, autofocused.
- One primary button: **Start session**. Disabled until name is non-empty (after trim).
- Pressing Enter in the input = clicking the button.
- Name rules (same everywhere): trim whitespace; 1–24 chars after trim; strip control
  characters; reject empty with inline error `Please enter a name.` No uniqueness check
  server-side, BUT see §6.3 for duplicate-name display handling.

On success the same page swaps to the **session screen** (no navigation; SPA-style DOM
swap — remember: no framework, plain JS toggling two top-level `<section>`s is fine).

### 4.2 Guest join (`/join?token=...`)

Same centered card layout:

- Title: **Join Ava's TagTeam session** — if the server can resolve the token to a host
  name before join, use it; otherwise fall back to **Join TagTeam session**.
  **ASSUMPTION (protocol):** a cheap pre-join check exists — `GET /api/invite/<token>`
  returning `{ ok, hostName, reason? }` — so the join card can show the host's name and show
  token errors *before* the guest types anything. If the architect doesn't provide this,
  degrade gracefully: show the generic title and surface token errors only after the join
  attempt (same error copy, §7.3).
- Subtitle: *"You've been tagged in. You'll see the full conversation and can talk to
  Claude directly."*
- Input **"Your name"**, placeholder `e.g. Sam`, autofocus, same validation as host.
- Primary button: **Join session**.
- If the URL has no `token` param: render error state E1 (§7.3) immediately, no form.

### 4.3 Session screen (shared by host and guest)

Layout, desktop-first (the demo is two desktop windows):

```
+--------------------------------------------------------------+
| Header: TagTeam ● session live   [roster chips]   [Tag in +] |  <- Tag in: host only
+----------------------------------------------+---------------+
|                                              |               |
|              Transcript (scrolls)            |  (no sidebar  |
|                                              |   in POC)     |
+----------------------------------------------+---------------+
| [ composer input........................ ] [Send]            |
+--------------------------------------------------------------+
```

- **Header, left:** wordmark "TagTeam", a green dot + "Live" when the WebSocket is open,
  amber dot + "Reconnecting…" when it drops (§7.5).
- **Header, middle: roster chips.** One chip per participant, in join order, host first:
  - Chip = colored dot + name + role tag. Host chip: `Ava · host`. Guest chip:
    `Sam · guest`. Your own chip appends `(you)`: `Sam · guest (you)`.
  - A guest made read-only shows `Sam · viewing` with the chip at 60% opacity.
  - On the **host's screen only**, each guest chip has an overflow affordance (a small `×`
    button and a `👁` toggle, or a tiny menu — builder's choice, but both actions must be
    one click after hover): **Make read-only / Restore send** and **Remove**. See §6.4.
- **Header, right (host only):** primary button **Tag in +**. Hidden entirely for guests
  (not merely disabled — guests must not see an invite affordance; brief: guests cannot
  mint invites).
- **Transcript:** vertical list, newest at bottom, auto-scrolls to bottom on new content
  *unless* the user has scrolled up more than ~150px, in which case show a floating
  **"↓ New messages"** pill that jumps to bottom when clicked. This matters for the demo:
  the host will be reading while Sam's messages stream in.
- **Composer:** single-line-growing textarea (Enter sends, Shift+Enter newline), Send
  button. Placeholder: `Message Claude — everyone in the session sees this.`
  - While Claude is generating: composer stays **enabled** (people can queue thoughts),
    but the Send button shows a subtle spinner state only if the architect's protocol
    forbids concurrent sends — **ASSUMPTION:** the server serializes turns: user messages
    are accepted any time, broadcast immediately, and queued; Claude answers them in
    order. If instead the protocol rejects sends mid-generation, the composer must disable
    with helper text `Claude is responding…` — behavior must match the architect's doc,
    but the *preferred* UX is accept-and-queue.
  - Read-only guest: composer input disabled, Send hidden, replaced by a full-width notice
    bar: `👁 The host has set you to view-only. You can watch, but not send.` (§6.4).

---

## 5. Message rendering & attribution (the core of the product)

Every transcript entry is one of four kinds. Exact visual spec:

### 5.1 Human message
- Row with a **colored avatar dot** (per-participant color, §5.5), **bold name**, small
  role badge (`HOST` / `GUEST`), timestamp `HH:MM`, then the message body.
- Your own messages: same layout (do NOT right-align like consumer chat — this is a shared
  transcript, alignment by author breaks the "one room" mental model), but with a faint
  background tint so you can find your own lines.

### 5.2 Claude message
- Distinct treatment: left border accent in Claude's brand-ish color (use a neutral
  terracotta `#D97757`-adjacent tone; do not use Anthropic logos), name **Claude**, badge
  `AI`, timestamp.
- Body renders minimal markdown: paragraphs, `code` spans, fenced code blocks, bold,
  bullet lists. No tables/images needed for POC. A tiny hand-rolled renderer or safe
  regex-based subset is fine; **must escape HTML first** (guests are semi-trusted).
- **Streaming:** tokens append live with a blinking caret ▍ at the end until the message
  completes. While streaming, show `Claude is thinking…` → replace with content on first
  token. **ASSUMPTION (protocol):** events like `assistant_start` / `assistant_delta` /
  `assistant_done` (or equivalent) exist and are broadcast to *all* participants so both
  windows stream in sync.
- **Tool use (Agent SDK read-only tools):** when Claude reads a file or searches, render a
  collapsed one-line system-style chip inside the Claude message: `🔧 Read file: profiles/kernel-occupancy.md`
  (click to expand raw tool result is a nice-to-have, not required). **ASSUMPTION:** the
  protocol surfaces tool events as `{ toolName, summary }`; if it doesn't, omit the chip —
  nothing else in this doc depends on it.

### 5.3 System event (join / leave / revoke / invite)
- Centered, small, muted text rows. Exact copy in §8. These are what make the tag-in moment
  legible in the demo — do not skip them.

### 5.4 What Claude sees (attribution toward the model)
- **ASSUMPTION (backend):** every human message is delivered to Claude prefixed
  `[Name]: message text`, and the system prompt (a) lists current participants with roles,
  (b) instructs Claude to address people by name and to note when someone new joins, and
  (c) is refreshed/announced on roster changes (e.g. an injected system-side note
  `Sam (Hardware) has joined the session.` so mid-conversation joins are acknowledged). The demo
  beat "Claude answers, addressing Sam by name" depends on this — flagging it as a hard
  requirement for the backend builder.

### 5.5 Participant colors
Deterministic palette by join order (host = index 0): `#2563EB` (blue), `#D97706` (amber),
`#059669` (green). Max 3 humans (host + 2 guests) so 3 colors suffice. Claude is always the
terracotta accent. Colors must pass on both light background `#FFFFFF` and the dark-ish
header — keep text in default ink color; the color is only for dots/borders/names.

---

## 6. Flows

### 6.1 Host: start → chat
1. Open `/`, type name, **Start session**.
2. Session screen appears with system row: `Session started by Ava.` Roster: just Ava.
3. Host types a message, Enter. Message appears instantly (echoed via broadcast, not local
   optimistic-only — **ASSUMPTION:** server broadcasts the sender's own message back;
   client renders on broadcast to keep both windows identical. If latency feels bad,
   optimistic render keyed by a client message id, reconciled on broadcast, is acceptable).
4. Claude streams a reply per §5.2.

### 6.2 The tag-in moment (host)
This is the demo's money shot. It must feel instant and controlled.

1. Host clicks **Tag in +** → modal opens (dim backdrop, Escape/click-outside closes):
   - Title: **Tag in a colleague**
   - Body line: *"They'll join this live conversation — full transcript, direct line to
     Claude. Link is single-use and expires in 30 minutes."*
   - The invite URL in a read-only input, full width, pre-selected.
   - Primary button **Copy link** → copies, button label flips to **Copied ✓** for 2s.
   - Muted footer: `Guests can't invite others. You can revoke access anytime from the
     roster.` and `v1: deliver invites via Teams — not in this POC.` (one line, small — it
     pre-empts the obvious judge question).
   - **ASSUMPTION (token flow):** clicking **Tag in +** immediately requests a new token
     (`invite_create` over WS or `POST /api/invite`) and the modal shows the returned URL
     `http(s)://<host>/join?token=<uuid>`. Token: single-use, TTL 30 min, bound to this
     session. Opening the modal twice creates two tokens; that's fine (each single-use).
     If the session already has 2 guests, the **Tag in +** button is disabled with tooltip
     `Session is full (2 guests max).` — the button re-enables when a guest is removed.
2. Closing the modal does nothing else. No system row for "invite created" in the shared
   transcript (guests shouldn't see invite mechanics); optionally a host-only muted row
   `You created an invite link (expires 30 min).` — nice-to-have.
3. When the guest joins, **all** participants see system row: `Sam joined the session.`
   and the roster chip appears with a brief highlight pulse (~1s) so the host's eye is
   drawn to it during the demo.

### 6.3 Guest: link → in the room
1. Guest opens `/join?token=...`. Pre-join check (if available) validates token; on
   failure show E1–E4 (§7.3) instead of the form.
2. Types name, **Join session**.
3. On success, the session screen renders with the **full transcript replayed** from the
   snapshot (all prior human + Claude messages, in order, with original attribution — the
   guest must be able to scroll to the top and read everything). Auto-scroll lands at the
   bottom. A one-time inline banner sits above the composer for the guest only:
   `You're in. Everyone sees your messages, and Claude knows you're here — just start
   typing.` Dismiss on first send or via ×.
4. Duplicate names: if the joining name (case-insensitive, trimmed) collides with an
   existing participant, the server (or client on snapshot) displays them as `Sam (2)`.
   Purely a display disambiguation; no rejection. **ASSUMPTION:** server owns this rename
   so Claude's `[Name]:` prefix matches the displayed name.
5. Token becomes used at successful join. Refreshing the guest page after joining would
   hit "already used" — see §7.4 for the reconnect carve-out.

### 6.4 Revoke (host)
Two levels, both from the guest's roster chip on the host screen:

**A. Make read-only** (`👁` toggle)
- Guest keeps watching; composer disabled per §4.3.
- System row (everyone): `Ava set Sam to view-only.`
- Chip label changes to `Sam · viewing`.
- Reversible: same toggle → **Restore send**, system row `Ava restored Sam's access.`
- No confirmation dialog (low stakes, reversible).

**B. Remove** (`×`)
- One-step confirm inline in the chip/menu: button turns into `Remove Sam?` for 3s; second
  click confirms (avoids a heavy modal, still prevents misclicks during a live demo).
- Guest's socket is closed by the server; guest client swaps to a full-screen terminal
  state: title **You've been removed from the session**, body `The host ended your access.
  Ask them for a new invite link if you need back in.` No retry button.
- System row (remaining participants): `Ava removed Sam from the session.`
- Guest's token(s) are dead; rejoining requires a fresh invite.
- **ASSUMPTION (protocol):** revoke/read-only are host-only WS messages
  (`participant_update { id, canSend }` / `participant_remove { id }` or equivalent), and
  the server enforces `canSend` server-side — a revoked guest's `send` must be rejected
  with an error event even if the client UI were bypassed. UI disablement is cosmetic;
  enforcement is the server's job.
- **Claude's view:** on remove, inject roster note `Sam has left the session.` On
  read-only, no note needed (they're still present).

**Demo note:** the brief's success criterion says "host revokes the guest; guest can no
longer send." Either A or B satisfies it; the demo script (§9) uses **B (Remove)** because
the full-screen state reads instantly on camera, and mentions A verbally.

### 6.5 Leaving / ending
- Guest closes tab: after a 5s disconnect grace (no reconnect), system row
  `Sam left the session.`, chip removed, roster note to Claude.
- Host closes tab: session keeps living server-side for the POC (in-memory anyway);
  guests see the host chip go to `Ava · away` (muted) if presence events exist —
  **nice-to-have; if presence isn't in the protocol, do nothing on host disconnect.**
  No "end session" button in POC (deferred; don't build).

---

## 7. Error & edge states (complete list — every one needs its exact copy)

### 7.1 Name validation (both roles)
- Empty/whitespace: inline under input, red: `Please enter a name.`
- \>24 chars: hard-limit the input (`maxlength=24`), no error needed.

### 7.2 Send failures
- WS closed when Send pressed: keep text in composer, toast: `Not connected — trying to
  reconnect…` (§7.5).
- Server rejects (revoked, rate, etc.): toast with the server's `reason` if provided,
  else `Message not sent.` Keep text in composer.

### 7.3 Token errors (guest join page, shown as the card body replacing the form)
| # | Condition | Title | Body |
|---|---|---|---|
| E1 | No/malformed token in URL | **This invite link is incomplete** | `Ask the host to send the full link.` |
| E2 | Token expired (TTL) | **This invite link has expired** | `Invite links last 30 minutes. Ask the host to tag you in again.` |
| E3 | Token already used | **This invite link was already used** | `Links are single-use. Ask the host for a fresh one.` |
| E4 | Session full (2 guests) | **This session is full** | `Sessions fit two guests for now. Ask the host to free a seat.` |
| E5 | Session gone (server restarted) | **This session has ended** | `Ask the host to start a new one and tag you in.` |

No retry buttons on any of these — the fix is always "get a new link", and the copy says so.

### 7.4 Guest refresh / reconnect
Single-use tokens + no login means a refreshed guest tab can't re-auth with the token.
POC resolution: on successful join, the client stores a server-issued **session-scoped
participant secret** in `sessionStorage` and reconnects with it. **ASSUMPTION (protocol):**
the join snapshot includes `{ participantId, resumeKey }` and the hello message accepts
`{ resume: { participantId, resumeKey } }`. If the architect cuts this, the fallback UX is:
refresh = E3 screen; acceptable for POC but must NOT happen during the demo — demo script
avoids refreshing (this is exactly the kind of mismatch the critic should verify).

### 7.5 Disconnect / reconnect (both roles)
- Header dot goes amber, label `Reconnecting…`; composer disabled while down.
- Retry with backoff (1s, 2s, 4s, max ~5 tries), then label `Connection lost — reload the
  page.` On reconnect, client re-syncs from snapshot (server resends transcript; client
  re-renders — simplest correct thing, transcript is small).

### 7.6 Claude/API failures
- If the Claude turn errors (API down, key missing), broadcast a Claude-styled message with
  error tone: `⚠ Claude hit an error and couldn't respond. Try sending again.` Humans'
  messages remain in the transcript; nothing is lost.
- Server started without `ANTHROPIC_API_KEY`: print a loud console error at boot; in-app,
  first send returns the same error row. (Boot-time failure is the integrator's call.)

---

## 8. Microcopy reference (single source of truth — builders copy verbatim)

| Key | Text |
|---|---|
| tagline | Stop playing telephone with your AI. |
| host.start.title | TagTeam |
| host.start.cta | Start session |
| guest.join.title | Join {hostName}'s TagTeam session / Join TagTeam session |
| guest.join.subtitle | You've been tagged in. You'll see the full conversation and can talk to Claude directly. |
| guest.join.cta | Join session |
| composer.placeholder | Message Claude — everyone in the session sees this. |
| composer.viewonly | 👁 The host has set you to view-only. You can watch, but not send. |
| invite.title | Tag in a colleague |
| invite.body | They'll join this live conversation — full transcript, direct line to Claude. Link is single-use and expires in 30 minutes. |
| invite.copy / copied | Copy link / Copied ✓ |
| invite.footer1 | Guests can't invite others. You can revoke access anytime from the roster. |
| invite.footer2 | v1: deliver invites via Teams — not in this POC. |
| invite.full.tooltip | Session is full (2 guests max). |
| sys.sessionStart | Session started by {name}. |
| sys.join | {name} joined the session. |
| sys.leave | {name} left the session. |
| sys.readonly.on | {host} set {name} to view-only. |
| sys.readonly.off | {host} restored {name}'s access. |
| sys.removed | {host} removed {name} from the session. |
| guest.welcome | You're in. Everyone sees your messages, and Claude knows you're here — just start typing. |
| removed.title | You've been removed from the session |
| removed.body | The host ended your access. Ask them for a new invite link if you need back in. |
| status.live / reconnecting / lost | Live / Reconnecting… / Connection lost — reload the page. |
| claude.thinking | Claude is thinking… |
| claude.error | ⚠ Claude hit an error and couldn't respond. Try sending again. |

Error-state copy: see table in §7.3.

---

## 9. Demo script — under 3 minutes

Pre-demo setup (not counted): `npm install && npm start`, open printed URL in Window A
(host) and keep Window B empty; seed a small `demo/` folder in the repo with 2–3 fake hardware-profiling
vendor quote files so Claude's read-only tools have something real to read. Both windows
side by side, ~50% screen each. Zoom browser to 110% for projector legibility.

| t | Beat | Action | Say |
|---|---|---|---|
| 0:00 | Problem | Nothing on screen yet but Window A. | "Ava is deep in a kernel-debugging task on the new accelerator with Claude. He needs Sam from the hardware team. Today that means relaying every question over chat — human telephone. Watch the alternative." |
| 0:15 | Host works | A: name `Ava`, Start session. Send: `Compare the kernel profiles in the demo folder and flag anything the HW team needs to sign off on.` Claude streams, reads files (tool chips visible). | "Claude's doing real work — reading actual files, streaming back. Standard single-player session." |
| 0:50 | Tag in | A: click **Tag in +**, modal up, **Copy link**. | "Here's the new part. One click — a single-use link, 30-minute expiry. In v1 this lands in Teams; today, copy-paste." |
| 1:05 | Join | Paste into Window B, name `Sam`, Join. B shows full transcript; A shows `Sam joined the session.` + chip pulse. | "Sam is *in the same live session*. Full context — nothing relayed, nothing lost." |
| 1:25 | Expert talks to Claude | B sends: `I'm from the hardware team — which of these kernels is bound by memory bandwidth on this board, and what quota headroom do we have?` Claude streams to BOTH windows, answering "Sam, …" by name. | "Claude knows who joined. It answers Sam directly, by name — and Ava sees every word live. No telephone." |
| 2:10 | Control | A: roster chip → Remove → confirm. B flips to the removed screen. B tries nothing — composer is gone. | "The host stays in control: guests can't invite others, links die after one use, and revoke is instant — there's also a softer view-only mode." |
| 2:30 | Close | Gesture at both windows. | "Single Node server, in-memory, `npm install && npm start`. Deferred, deliberately: SSO, persistence, redacting sensitive context, Teams delivery, attaching to a live Claude Code CLI. TagTeam: stop playing telephone with your AI — tag your expert in." |

Timing risks + mitigations:
- **Claude latency** is the only uncontrolled variable. Keep the demo prompt scoped to 2–3
  small files; if the first response runs long, start the tag-in beat *while Claude is
  still streaming* — it actually demos better (guest joins mid-stream and sees it live).
- Never refresh the guest window (see §7.4).
- Have a second invite link ready (open the modal twice beforehand is NOT possible after
  the demo starts cleanly — just re-click Tag in + if the paste fails; each click mints a
  fresh token).

---

## 10. Explicit assumptions for the critic (summary)

1. WS hello/snapshot handshake with `{ transcript, roster, participantId, capabilities }`
   (§3). 2. Pre-join token check endpoint `GET /api/invite/<token>` — degradable (§4.2).
3. Server serializes turns; sends accepted during generation (§4.3). 4. Assistant
   streaming events broadcast to all participants (§5.2). 5. Tool events surfaced as
   `{ toolName, summary }` — omit chip if absent (§5.2). 6. `[Name]:` prefixing + roster
   in system prompt + join/leave notes injected for Claude (§5.4 — **hard requirement**,
   demo beat 3 depends on it). 7. Sender's own messages come back via broadcast (§6.1).
8. Invite minting on demand, single-use, 30-min TTL, disabled at 2 guests (§6.2).
9. Server-enforced `canSend`; UI disablement is cosmetic (§6.4). 10. Reconnect via
   `resumeKey` in sessionStorage — degradable to "refresh = dead token" (§7.4).
11. Server-owned duplicate-name disambiguation (§6.3).

## 11. Explicitly NOT designed (deferred per brief — name in demo only)

SSO/real identity, persistence, transcript redaction/context scoping, Teams invite
delivery, Claude Code CLI attach, dashboards, persona agents, mobile layout, >2 guests,
end-session button, transcript export.
