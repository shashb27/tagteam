# TagTeam — 3-minute demo script

Cast (fictional, per the brief): **Ava** — software engineer debugging why
inference kernels underperform on the company's new AXB-200 accelerator
board (host). **Sam** — senior hardware architect (tagged-in expert).
**Kai** — junior engineer who can optionally shadow.

> The AI backend in this demo is **opencode** (model-agnostic). The model name
> shown in the UI comes from `/api/config` and reflects whatever provider you
> configured opencode with (BigModel `glm-5.2` in CI, or whatever you ran
> `opencode auth` against). In mock mode the AI label is "Assistant (mock)" and
> responses are canned — every multiplayer mechanic below is still fully real.

## Setup (before you start the clock)

1. `npm start` (or `MOCK_CLAUDE=1 npm start` for the zero-credential safety
   net — everything below works identically, responses are canned and labeled
   mock). Note the startup line `agent backend: opencode|mock`.
2. Two browser windows side by side: **left = Ava (host)**, **right = empty**
   (this becomes Sam). Use a normal window + a private/incognito window so the
   two sessions don't share storage.
3. Left window: open `http://localhost:3000`, register an account, log in,
   type `Ava`, click **Start session**.

Fallback note: if the opencode backend is active and the configured model has
tool use, you'll see tool chips (the AI actually reading files). On `mock` there
are no chips — skip the "watch the tool chips" line and the demo still works.

## The script

**0:00 — The problem (say it while typing).**
"Ava is a software engineer. Her inference kernels are mysteriously slow on
the company's new accelerator board. Normally, when she hits a hardware
question, she'd screenshot the AI's answer into chat, relay the hardware
team's reply back, and lose context on every hop. Watch instead."

**0:15 — Host works with the AI on real files.** Ava sends:

> Compare the kernel profiles in the demo folder and flag anything the
> hardware team needs to weigh in on.

Point at the streaming response — and, on the opencode backend with tool use,
at the tool chips: "The AI is doing real work here, reading actual files on
the server, not roleplaying." (It reads `kernel-profile.md` /
`board-specs.md` — five real kernels; four healthy, and `kv_cache_gather`
stuck at 704 GB/s, just 22% of the board's 3,200 GB/s peak.)

**0:50 — The wall.** "The AI found the smoking gun — unaligned DMA reads
falling back to a slow path. But is that really errata E7? And is the padding
workaround safe to ship? That answer lives with the hardware team — with Sam.
Today this becomes a 20-message relay thread. In TagTeam, Ava tags Sam in."

**1:00 — Tag in.** Ava clicks **Tag in a colleague** → **Copy link**. Mention
the guardrail as you copy: "single-use link, expires in 30 minutes." Paste
the URL into the right-hand window. Sam registers / logs in, types `Sam`,
clicks **Join session**.

**1:15 — The money shot.** Sam's window shows the **full transcript** — the
kernel-profile analysis, everything. Both rosters show Ava, Sam, and the AI.
Point at the "Sam joined the session" line landing live in Ava's window.

**1:25 — The expert talks to the AI directly.** Sam sends:

> Is the kv_cache_gather slowdown the unaligned-DMA errata, and can we pad
> the KV entries to 256 bytes without blowing the memory budget?

The AI answers **addressing Sam by name**, pulling from `hw-constraints.md`
(errata E7 confirmed — the 160-byte KV stride breaks the 256-byte DMA
alignment; padding restores the fast path but costs ~60% more HBM in that
region; the gather-scatter DMA mode needs Sam's sign-off). Ava sees every
token live. "No relay. No paraphrase loss. Both humans and the AI in one
room, and the AI knows who's who."

**2:10 — Guardrails.** In Ava's roster, hover Sam's row:
1. Click the eye icon → **view-only**. Sam's composer locks with a banner;
   have Sam try to type. "The host stays in control."
2. Click it again → **restore**. Sam can send again.
3. Click ✕ twice → **kick**. Sam gets a clean "removed from session" screen
   and the invite link is dead — single-use, remember.

(Optional, if time allows: mint a second link for `Kai`, a junior engineer
who shadows the debugging session view-only — sessions fit two guests.)

**2:40 — Close.** "Single Node server, in-memory + SQLite,
`npm install && npm start`. Deliberately deferred to a later drop-in: real
identity/SSO (Entra/Google/Okta — the auth interface is already OIDC-shaped),
Slack/Teams delivery of invites, and Kubernetes horizontal scale — this same
protocol carries straight over. Stop playing telephone with your AI. Tag
your expert in."

## Recovery notes (if something goes sideways)

- **Accidental tab reload** (either window): the session auto-resumes from
  sessionStorage and the SQLite-backed state — keep talking, don't restart.
- **AI errors mid-answer**: the turn closes with an error line in the
  transcript; just resend. Or restart with `MOCK_CLAUDE=1` — the multiplayer
  story needs no live model.
- **Invite pasted wrong / expired**: mint a new one — takes two clicks; the
  guest cap counts joined guests, not minted links.
- **Second demo run**: just refresh the host window and start a new session
  (the old one keeps living in memory + SQLite until GC'd; that's fine).
