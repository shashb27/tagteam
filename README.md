<p align="center">
  <img src="docs/assets/banner.svg" alt="TagTeam — multiplayer Claude sessions" width="100%" />
</p>

<h1 align="center">TagTeam</h1>

<p align="center">
  <strong>Tag a colleague into your live Claude session. The expert talks to the AI directly — no relaying, no context loss, no waiting.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/hackathon-POC-blueviolet" alt="Hackathon POC" />
  <img src="https://img.shields.io/badge/node-20%2B-brightgreen" alt="Node 20+" />
  <img src="https://img.shields.io/badge/build%20step-none-success" alt="No build step" />
  <img src="https://img.shields.io/badge/mock%20mode-zero%20credentials-orange" alt="Mock mode available" />
  <img src="https://img.shields.io/badge/setup-npm%20install%20%26%26%20npm%20start-informational" alt="npm install && npm start" />
</p>

<p align="center">
  <em>"Stop playing telephone with your AI. Tag your expert in."</em>
</p>

---

## Do you face this too?

- You're mid-flow with your AI when the question crosses into someone else's domain — so you **screenshot the chat into Teams** and wait.
- An expert **dictates questions over a call** while you retype them into your session, then read the answers back to them.
- You've pasted the same AI answer between **three different chats** and lost half the context in every hop.
- A teammate solved this exact problem with AI last week — and **nothing about how** they did it ever reached you.

If any of these are just "Monday" for you, this is the fix.

## See it work — 30 seconds, zero credentials

<p align="center">
  <img src="docs/assets/demo.gif" alt="TagTeam demo: Ava (host, left) tags Sam (guest, right) into her live Claude session" width="100%" />
</p>

<p align="center">
  <em>Ava (left) works the kernel bug with Claude, tags Sam in with a single-use link — Sam (right) joins with the full transcript, asks Claude directly, gets answered by name, and is set to view-only when done. Recorded in mock mode: <code>MOCK_CLAUDE=1 npm start</code>. (<a href="docs/assets/demo.mp4">higher-quality MP4</a>)</em>
</p>

## The Problem

Every team — software, hardware, marketing, sales — now works with AI. But every session is a **silo**: one person's context, one person's prompts, one person's conversation. The moment a task crosses a team boundary, all that AI leverage collapses into a game of telephone.

Meet **Ava**, a software engineer deep in a Claude session, debugging why an inference kernel underperforms on a new accelerator board. Claude holds all the code context. But past a certain point, the answer lives with **Sam** — the senior hardware architect, in another office, in another time zone. Today, getting Sam's expertise into that session looks like this:

```mermaid
sequenceDiagram
    participant Sam as Sam — hardware architect (the expert)
    participant Ava as Ava — software engineer (the host)
    participant Claude
    Sam->>Ava: asks a question over chat
    Ava->>Claude: retypes it into the session
    Claude->>Ava: answers
    Ava->>Sam: paraphrases the answer back
    Note over Sam,Claude: Every hop loses context and time.<br/>Repeat × 10 for one decision.
```

<p align="center">
  <img src="docs/assets/telephone-vs-tagteam.svg" alt="The telephone game vs. TagTeam" width="100%" />
</p>

Sam never sees what Claude actually said. Claude never hears what Sam actually asked. Ava spends her afternoon as a lossy human router.

## The Impact

- **Zero-hop expertise across team boundaries.** The hardware expert talks directly to the AI that holds the software context — and vice versa. No paraphrasing, no context loss.
- **Hard-won knowledge moves sideways through the org.** Workflows, prompts, and live working context stop being trapped in one person's browser tab.
- **The session becomes the classroom.** There's a third seat: **Kai**, a junior engineer, can shadow the live session and watch how the seniors actually work a problem — the questions they ask, the dead ends they prune.
- **Afternoons become minutes.** Decisions that took a day of relaying across time zones happen live, in one conversation, with everyone (human and AI) seeing the same thing.

## The Solution

**TagTeam makes Claude sessions multiplayer.** A host works with Claude in a shared session and can **tag in** a colleague via a single-use, 30-minute invite link. The colleague joins the *same live conversation*: full transcript, direct line to Claude, every message attributed by name — so Claude and both humans always know who said what, and Claude addresses each person by name. The host stays in control and can revoke a guest at any moment.

<p align="center">
  <img src="docs/assets/how-it-works.svg" alt="How TagTeam works" width="100%" />
</p>

### The tag-in flow

```mermaid
sequenceDiagram
    participant Ava as Ava — host
    participant TT as TagTeam server
    participant Claude
    participant Sam as Sam — tagged-in expert
    Ava->>TT: works with Claude on the kernel bug (streamed live)
    Ava->>TT: "Tag in" → invite link (single-use token, 30-min TTL)
    Ava-->>Sam: sends the link across time zones
    Sam->>TT: opens link, types his name, joins the live session
    Note over Sam: sees the full transcript instantly
    Sam->>Claude: asks Claude directly, as himself
    Claude-->>Ava: streamed answer, addressed to Sam by name
    Claude-->>Sam: both see everything, live
    Ava->>TT: revoke guest (read-only or kick) when done
```

### Architecture

One Node.js process, in-memory state, no database, no framework, no build step. A static web client drives everything over a single WebSocket protocol.

```mermaid
flowchart LR
    subgraph Browser
        H[Host client — Ava]
        G[Guest client — Sam]
    end
    subgraph Node server
        WS[WebSocket hub<br/>fan-out to all participants]
        SES[In-memory sessions<br/>participants + transcript]
        TOK[Invite tokens<br/>single-use · 30-min TTL · guest cap]
        PROV[Provider chain]
    end
    A1[Claude Agent SDK<br/>read-only tools · local CLI creds]
    A2[Messages API<br/>ANTHROPIC_API_KEY]
    A3[Mock provider<br/>zero credentials]
    H <--> WS
    G <--> WS
    WS --> SES
    WS --> TOK
    SES --> PROV
    PROV --> A1
    PROV -.fallback.-> A2
    PROV -.fallback.-> A3
```

The provider chain degrades gracefully at startup: **Agent SDK** (real read-only tool use, rides local Claude Code credentials) → **Messages API** (streaming chat via `ANTHROPIC_API_KEY`) → a **clearly-labeled mock** — so the multiplayer demo always runs, even with zero credentials.

### Guardrails — v0 built, v1 designed

| Built now (v0) | Designed, deliberately deferred (v1) |
| --- | --- |
| Single-use invite tokens with 30-min TTL | Real identity / SSO |
| Max 2 guests per session | Context scoping & redaction (what a guest may see) |
| Host can revoke a guest instantly (read-only or kick) | Chat-platform integration — tag in from where you already work |
| Guests cannot mint invites (enforced server-side) | Attach to a local Claude Code CLI session |
| API key never leaves the server | Expertise personas: summon the expert's agent when the human is asleep |

## Try it

**Prerequisites:** [Node.js 20+](https://nodejs.org). That's it — no build step, no database, no framework.

```bash
git clone https://github.com/shashb27/tagteam.git
cd tagteam
npm install
```

<p align="center">
  <img src="docs/assets/install-cast.svg" alt="Install and start TagTeam in mock mode" width="90%" />
</p>

Then pick a run mode. All three serve the app at **http://localhost:3000** (override with `PORT=…`; the server prints the URL on startup).

### 1. Mock mode — recommended for judging (zero credentials)

```bash
MOCK_CLAUDE=1 npm start
```

No API key, no login, nothing to configure. Claude's replies are scripted and **clearly labeled as mock** in the transcript — but every multiplayer mechanic is fully real: live streaming, invite tokens, attribution, revocation. This is the fastest way to see the product work.

### 2. Claude Code login mode (Agent SDK)

```bash
npm start
```

If you're logged into the Claude Code CLI on this machine, the Agent SDK rides your local credentials — no API key needed. Claude gets **read-only tools** (Read/Grep/Glob) scoped to a small demo workspace, so it can do real work in the session. The server probes the SDK at startup and falls back automatically if it's unavailable.

### 3. API-key mode (Messages API)

```bash
ANTHROPIC_API_KEY=sk-ant-... npm start
```

Streaming chat via the Anthropic Messages API. Same multiplayer experience, minus tool use.

> Force a specific backend with `TAGTEAM_AGENT=sdk|api|mock`. The active backend is printed at startup and reported at `/healthz`.

### The two-browser walkthrough

1. **Open http://localhost:3000** in browser window #1. Click **New session** — you're the host. Enter as **Ava**.
2. **Chat with Claude** about the demo scenario: debugging a kernel regression on the new accelerator board. Watch the response stream in.
3. Click **Tag in** → an invite link appears (single-use, expires in 30 minutes). **Copy it.**
4. **Open the link in browser window #2** (or an incognito window). Type **Sam** at the name prompt — you're in, with the full transcript already on screen.
5. As Sam, **ask Claude a question directly** — no relaying through Ava.
6. Watch Claude **answer Sam by name**, streamed live to both windows simultaneously.
7. Back in the host window, **revoke Sam** (make read-only, or kick). Sam can no longer send — the guardrails are server-enforced, not UI decoration.

## Repo map

| Path | What it is |
| --- | --- |
| `server/` | Node ESM backend: HTTP + WebSocket hub, in-memory sessions & tokens, turn engine, provider chain (`server/agent/`) |
| `web/` | Static frontend (one HTML page + vanilla JS/CSS) — no framework, no build |
| `docs/design/` | One design doc per swarm specialist: architecture & wire protocol, backend, frontend, product, security |
| `docs/PITCH.md` | The pitch narrative |
| `DEMO.md` | The 3-minute demo script |
| `PROJECT_BRIEF.md` | The contract: scope, guardrails, success criteria |

## The meta-story

This POC was designed and built by a **six-agent swarm**: five specialists (product, architecture, backend, frontend, security) plus a **resident critic** whose only job is to find what the others got wrong — orchestrated through a design → critique → build → integrate loop that ends only on a **unanimous approval vote** by all six.

The design docs in `docs/design/` are the agents' actual working contracts, written independently and reconciled through critique. Collaboration between intelligences — human and AI — is both the product and the process.
