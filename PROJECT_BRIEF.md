# TagTeam — Project Brief (Hackathon POC)

## The problem (cross-team, software × hardware)

A software engineer is deep in a Claude session debugging why an inference kernel
underperforms on a new accelerator board. Past a certain point the answer lives with the
hardware team — a senior architect in another office and time zone. Today the expert asks
questions over chat, the engineer relays them to Claude, Claude answers, and the engineer
paraphrases back. Every hop loses context and time. The expert should be able to **jump
into the live AI session** and talk to Claude (and the host) directly — and a junior
engineer should be able to shadow the session and learn from how the seniors work.

Generalized: every team (software, hardware, marketing, sales) uses AI in a silo. Workflows,
prompts, and live working context don't move sideways between people.

**Use only fictional names in all demo material and mock content — never real employee
names.** Standard demo cast: Ava (software engineer, host), Sam (senior hardware architect,
tagged-in expert), Kai (junior engineer, shadowing).

## The product

**TagTeam — multiplayer Claude sessions.** A host works with Claude in a shared session and
can "tag in" a colleague via a time-boxed invite link. The colleague joins the *same live
conversation*: sees the full transcript, sends messages directly to Claude, and everything is
attributed by name so Claude and both humans know who said what.

Pitch line: *"Stop playing telephone with your AI. Tag your expert in."*

## POC scope (must be buildable and demoable this weekend)

- **Single Node.js server**, in-memory state, no database, no login (participants type a
  display name when joining).
- Host opens the web app, creates a session, chats with Claude with streaming responses.
- Claude runs server-side via the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) so
  it can do real work (read files, search) — restricted to **read-only tools** in the POC.
  If the Agent SDK cannot run in this environment, fall back to `@anthropic-ai/sdk`
  streaming Messages API behind the same internal interface.
- **Tag-in:** host clicks a button → gets an invite URL containing a single-use token,
  default TTL 30 minutes.
- Guest opens the link, sees the live transcript, and can send messages. Every message is
  attributed (`[Ava]: …`, `[Sam]: …`) and Claude's system prompt tells it who is in the
  room and to address people by name.
- **Guardrails v0:** token TTL + single use, max 2 guests per session, host can revoke a
  guest (kick / make read-only), guests cannot mint invites, API key lives server-side only.
- **No build step anywhere:** plain ESM JavaScript server (no TypeScript compile), single
  static HTML/JS/CSS client served by the server, no frontend framework.
- Runs with `ANTHROPIC_API_KEY` from the environment. `npm install && npm start` must be the
  entire setup.

## Explicitly deferred to v1 (name these in the demo, do not build)

SSO / real identity, persistence, context scoping & redaction of sensitive transcript parts,
Teams integration for delivering invites, attaching to a local Claude Code CLI session,
session dashboards, persona/expertise agents.

## Success criteria (the demo, in order)

1. Two browser windows side by side. Host (Ava, software) chats with Claude about a real
   task (the kernel-on-accelerator debugging scenario).
2. Host clicks **Tag in** → copies the invite link → guest window opens it, types "Sam",
   and is in — full transcript visible.
3. Guest asks Claude a question directly; Claude answers, addressing Sam by name; host sees
   everything live.
4. Host revokes the guest; guest can no longer send.
5. Total setup for a fresh machine: `npm install && npm start`, open the printed URL.

## Tech defaults (architect may refine in docs/design/, builders follow the design docs)

Node 20+, ESM modules, `ws` for WebSockets, in-memory session store, `crypto.randomUUID()`
tokens. The architect's design doc MUST fully specify the WebSocket wire protocol (JSON
message types in both directions) so backend and frontend can be built independently and
meet in the middle.

## File layout (hard boundaries — builders stay in their lane)

- `server/` — backend only
- `web/` — frontend only (static, served by the server)
- `docs/design/` — one design doc per specialist
- `README.md`, `DEMO.md` — written by the integrator
