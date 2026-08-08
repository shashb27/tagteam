# TagTeam — multiplayer Claude sessions (hackathon POC)

*Stop playing telephone with your AI. Tag your expert in.*

A host works with Claude in a shared, live session and can **tag in** a colleague
via a single-use, time-boxed invite link. The colleague joins the *same
conversation*: full transcript, direct line to Claude, every message attributed
by name so Claude and both humans know who said what.

## Quick start

Requirements: **Node 20+**.

```bash
npm install
npm start
```

Open the printed URL (default `http://localhost:3000`), enter a display name,
and you are the host. Click **Tag in a colleague**, copy the link, open it in a
second browser window (or send it to a colleague on the same network), enter a
name — that person is now in the session.

That's the entire setup. No database, no build step, no login.

## How Claude runs (provider selection)

The server picks a Claude backend at startup, in this order:

1. **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) — the primary path.
   Uses your local Claude Code CLI credentials, so it can work with **no API
   key at all**. Probed with a one-shot smoke test (up to 20 s) at boot.
   This backend gives Claude read-only tools (`Read`, `Grep`, `Glob`) over
   `server/demo-workspace/` — you get visible tool chips in the UI.
2. **Messages API** (`@anthropic-ai/sdk`, streaming) — used when the Agent SDK
   is unavailable and `ANTHROPIC_API_KEY` is set. Pure chat, no tools.
3. **Mock** — canned streaming responses, clearly labeled `Claude (mock)`.
   Zero credentials required, so the multiplayer demo always runs.

The chosen backend is printed at startup and reported by `GET /healthz`
(`{"ok":true,"agentImpl":"sdk"|"api"|"mock"}`).

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | HTTP + WebSocket port |
| `ANTHROPIC_API_KEY` | unset | Enables the Messages API fallback (the Agent SDK path can run on Claude Code CLI credentials instead) |
| `TAGTEAM_AGENT` | unset | Force a backend: `sdk` \| `api` \| `mock` |
| `MOCK_CLAUDE` | unset | `1` forces the mock backend (same as `TAGTEAM_AGENT=mock`) |
| `TAGTEAM_MODEL` | `claude-sonnet-5` | Model for the API backend (passed to the SDK only when set explicitly) |
| `BASE_URL` | unset | Overrides the origin used in invite URLs (defaults to the request Host header) |

Useful invocations:

```bash
MOCK_CLAUDE=1 npm start            # guaranteed-to-work demo, no credentials
TAGTEAM_AGENT=api npm start        # skip the SDK, use ANTHROPIC_API_KEY
TAGTEAM_AGENT=sdk npm start        # force the Agent SDK (fails loudly if broken)
```

## Guardrails (v0)

- Invite tokens are **single-use** with a TTL (default 30 min, max 120).
- **Max 2 concurrent guests** (kicking a guest frees the slot; enforced at join).
- Host can revoke a guest: **view-only**, **restore**, or **kick** (server-enforced).
- Guests cannot mint invites (server-enforced, not just UI).
- The API key never leaves the server; no frame or endpoint contains it.
- Claude is read-only: every tool call is decided by a `canUseTool` gate that
  allows only `Read`/`Grep`/`Glob`, default-denies everything else, and
  confines file access to `server/demo-workspace/`. The SDK `allowedTools`
  option is deliberately left empty — tools listed there are auto-approved
  before `canUseTool` runs, which would bypass the path confinement. No
  network tools (WebSearch/WebFetch are disallowed — no exfiltration channel).

## Layout

```
server/            backend (single Node process, ESM, in-memory state)
  index.js         HTTP + WebSocket connection layer
  sessions.js      session store, participants, invites, transcript
  turns.js         turn queue, streaming fanout, prompt assembly
  protocol.js      frame constants + error codes
  agent/           backend selection + sdk / api / mock runners
  demo-workspace/  the only files Claude can read (demo TPU-procurement docs)
web/               static client (no framework, no build step)
docs/design/       per-specialist design docs (architecture.md §6 is the wire contract)
PROJECT_BRIEF.md   scope contract
DEMO.md            3-minute demo script
```

Sessions live in memory and are garbage-collected 2 hours after the last
socket disconnects. Restarting the server ends all sessions.

## Deferred to v1 (by design)

SSO / real identity, persistence, context scoping & redaction, Teams
integration for invite delivery, attaching to a local Claude Code CLI session,
session dashboards, persona/expertise agents.
