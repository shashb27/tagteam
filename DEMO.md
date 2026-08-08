# TagTeam — 3-minute demo script

Cast (fictional, per the brief): **Ava** — engineer running a TPU procurement
evaluation (host). **Sam** — IT/infrastructure lead (tagged-in expert).

## Setup (before you start the clock)

1. `npm start` (or `MOCK_CLAUDE=1 npm start` for the zero-credential safety
   net — everything below works identically, responses are canned and labeled
   mock). Note the startup line `agent backend: sdk|api|mock`.
2. Two browser windows side by side: **left = Ava (host)**, **right = empty**
   (this becomes Sam). Use a normal window + a private/incognito window so the
   two sessions don't share storage.
3. Left window: open `http://localhost:3000`, type `Ava`, click
   **Start session**.

Fallback note: if the Agent SDK backend is active you'll see tool chips
(Claude actually reading files). On the `api` or `mock` backend there are no
chips — skip the "watch the tool chips" line and the demo still works.

## The script

**0:00 — The problem (say it while typing).**
"Ava is evaluating TPU vendors with Claude. Normally, when she hits an IT
question, she'd screenshot Claude's answer into chat, relay Sam's reply back,
and lose context on every hop. Watch instead."

**0:15 — Host works with Claude on real files.** Ava sends:

> Compare the TPU vendor quotes in the demo folder and recommend one for an
> 8-week benchmarking pilot.

Point at the streaming response — and, on the SDK backend, at the tool chips:
"Claude is doing real work here, reading actual files on the server, not
roleplaying." (It reads `tpu-quotes.md` / `vendor-comparison.md` — three
fictional vendors, real tradeoffs.)

**0:50 — The wall.** "The recommendation depends on firewall exceptions and
cloud quotas. That answer lives with IT — with Sam. Today this becomes a
20-message relay thread. In TagTeam, Ava tags Sam in."

**1:00 — Tag in.** Ava clicks **Tag in a colleague** → **Copy link**. Mention
the guardrail as you copy: "single-use link, expires in 30 minutes." Paste
the URL into the right-hand window, type `Sam`, click **Join session**.

**1:15 — The money shot.** Sam's window shows the **full transcript** — the
quotes discussion, everything. Both rosters show Ava, Sam, and Claude. Point
at the "Sam joined the session" line landing live in Ava's window.

**1:25 — The expert talks to Claude directly.** Sam sends:

> Do we already have firewall exceptions for these vendor portals, and is our
> chip quota enough for the pilot?

Claude answers **addressing Sam by name**, pulling from `it-network-notes.md`
(one vendor already allowlisted, quota short of the 64-chip config, file the
increase before the PO). Ava sees every token live. "No relay. No paraphrase
loss. Both humans and Claude in one room, and Claude knows who's who."

**2:10 — Guardrails.** In Ava's roster, hover Sam's row:
1. Click the eye icon → **view-only**. Sam's composer locks with a banner;
   have Sam try to type. "The host stays in control."
2. Click it again → **restore**. Sam can send again.
3. Click ✕ twice → **kick**. Sam gets a clean "removed from session" screen
   and the invite link is dead — single-use, remember.

**2:40 — Close.** "Single Node server, in-memory, `npm install && npm start`.
Deliberately deferred to v1: real identity/SSO, persistence, redacting
sensitive transcript spans before the guest joins, Teams delivery of invites,
and attaching to a live Claude Code CLI session — this same protocol carries
straight over. Stop playing telephone with your AI. Tag your expert in."

## Recovery notes (if something goes sideways)

- **Accidental tab reload** (either window): the session auto-resumes from
  sessionStorage — keep talking, don't restart.
- **Claude errors mid-answer**: the turn closes with an error line in the
  transcript; just resend. Or restart with `MOCK_CLAUDE=1` — the multiplayer
  story needs no live model.
- **Invite pasted wrong / expired**: mint a new one — takes two clicks; the
  guest cap counts joined guests, not minted links.
- **Second demo run**: just refresh the host window and start a new session
  (the old one keeps living in memory until GC'd; that's fine).
