<p align="center">
  <img src="docs/assets/banner.svg" alt="TagTeam — multiplayer AI coding sessions" width="100%" />
</p>

<h1 align="center">TagTeam</h1>

<p align="center">
  <strong>Tag a colleague into your live AI coding session. The expert talks to the AI directly — no relaying, no context loss.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/backend-opencode-blueviolet" alt="opencode" />
  <img src="https://img.shields.io/badge/milestones-M0%20%7C%20M1%20%7C%20M2-brightgreen" alt="M0 + M1 + M2 done" />
  <img src="https://img.shields.io/badge/node-20%2B-brightgreen" alt="Node 20+" />
  <img src="https://img.shields.io/badge/build%20step-none-success" alt="No build step" />
  <img src="https://img.shields.io/badge/mock%20mode-zero%20credentials-orange" alt="Mock mode available" />
  <img src="https://img.shields.io/badge/deploy-docker-blue" alt="Docker deploy" />
</p>

<p align="center">
  <em>"Stop playing telephone with your AI. Tag your expert in."</em>
</p>

---

## What it is

TagTeam turns a single-user AI coding session into a **multiplayer** session. A host
works with an AI in a shared live conversation and can **tag in** a colleague through a
single-use invite link. The colleague joins the *same live transcript*, gets a direct
line to the AI, and every message is attributed by name — so both humans and the AI
always know who said what, and the AI addresses each person by name. The host stays in
control and can revoke a guest (read-only or kick) at any moment.

It is **model-agnostic**: the AI backend is [opencode](https://opencode.ai), so you can
point it at any provider you already have credentials for (Anthropic, OpenAI, BigModel,
local, …). The first registered user gets a normal local account — no admin setup, no
SSO, no external services. State persists in a local SQLite file; sessions survive a
server restart and can be resumed from another machine.

The canonical demo: **Ava**, a software engineer, is debugging why an inference kernel
underperforms on a new accelerator board. Past a certain point the answer lives with
**Sam**, the senior hardware architect in another time zone. Instead of screenshotting
chat into Teams and relaying answers, Ava tags Sam in with one link — Sam joins the live
session, asks the AI directly, gets answered by name, and is set to view-only when
done. See [`DEMO.md`](DEMO.md) for the full walkthrough.

## Quick start

```bash
git clone <repo> tagteam && cd tagteam
npm install
```

Then pick a mode. All three serve the app at **http://localhost:3000**
(override with `PORT=…`; the server prints the URL on startup).

### 1. Mock mode — zero credentials, the demo path

```bash
MOCK_CLAUDE=1 npm start
```

No API key, no login, nothing to configure. AI replies are scripted and clearly labeled
as mock in the transcript — but every multiplayer mechanic is fully real: live
streaming, invite tokens, attribution, revocation, persistence. This is the fastest way
to see the product work and is what the E2E suite runs against.

### 2. opencode mode — real AI, any provider

```bash
npm start
```

If you're authenticated with the opencode CLI on this machine (`opencode auth`),
TagTeam's in-process opencode server rides your local credentials — no extra API key
needed. The model name and provider come from your opencode config (override with
`OPENCODE_MODEL` / `OPENCODE_PROVIDER`, see [`.env.example`](.env.example)). The active
backend + model are printed at startup and reported at `/healthz` and the new
`/api/config` endpoint (which the web UI uses for its labels).

### 3. Company-wide — one command

```bash
cp .env.example .env      # edit BASE_URL / OPENCODE_* as needed
docker compose up -d
```

See [`DEPLOY.md`](DEPLOY.md) for the full company-wide runbook: prerequisites, first
user, backup, troubleshooting, and the one-liner fresh-box install.

> **Note on Claude / Codex backends:** the original POC shipped an Anthropic Messages-API
> backend and a Claude Code (Agent SDK) backend. Both are **deferred** on the `opencode`
> branch — opencode already abstracts providers, so they would be redundant. The wire
> protocol, session model, and turn engine are unchanged; only `server/agent/*` was
> replaced. They can be re-added later as opencode provider configs, not as separate
> runners.

## What shipped (M0 + M1 + M2)

- **Multiplayer sessions** — one host + up to 2 guests per session, live streaming,
  single-use invite tokens (30-min TTL), full transcript on join.
- **Attribution + host control** — every message attributed by name; host can revoke a
  guest to **read-only** or **kick** them; guests cannot mint invites (server-enforced).
- **Persistence** — sessions, participants, invites, messages, audit events written
  through to SQLite (`data/tagteam.db`); restart-resume across process death and across
  devices.
- **Auth (zero-admin)** — local accounts (bcrypt + httpOnly cookie), first user is a
  normal user, no bootstrap admin. The interface is OIDC-shaped so Entra/Google/Okta is
  a later drop-in.
- **Context redaction** — auto-redaction of secret patterns (API keys, tokens, paths)
  before delivery to guests; host can mark transcript ranges as hidden from guests.
- **Observability** — pino structured logs (`logs/tagteam.log`), `/metricsz` counters,
  append-only `audit_events` table (joins, revokes, logins, errors).
- **Abuse guards** — per-IP rate limits on session-create and message-send, origin
  allowlist, CSRF on `POST /api/sessions` + `/api/auth/*`, session + failed-login caps.
- **Dashboard** — `/dashboard` route lists the logged-in user's active + past sessions
  with one-click resume (cross-device).
- **Accessibility** — keyboard-only, visible focus, modal trap, `aria-live`
  transcript, AA contrast, screen-reader labels.
- **Mobile** — composer sticky, transcript scroll, participants collapse to a drawer
  under 640px.
- **Docker** — single-container deploy (`Dockerfile` + `docker-compose.yml`), volumes
  for `data/` and `logs/`, env from `.env`.
- **Load ceiling documented** — single-process numbers in [`docs/LOAD.md`](docs/LOAD.md);
  horizontal scale is a later concern (run multiple processes behind a load balancer).

### Deliberately deferred (needs admin / budget — not in this build)

- OIDC/SSO (Entra / Google / Okta) — the auth interface is already OIDC-shaped, drop-in
  PR later.
- Slack / Teams invite delivery — invite links are copy-paste today.
- Kubernetes / horizontal scale — single process first, prove the ceiling.
- Expertise personas (auto-respond as the expert when they're asleep).
- Admin dashboards (cross-user session views).

See [`DECISION_LOG.md`](DECISION_LOG.md) for the reasoning behind each of these.

## The two-browser walkthrough

1. **Open http://localhost:3000** in browser window #1. Register, then click **New
   session** — you're the host. Enter as **Ava**.
2. **Chat with the AI** about the demo scenario: debugging a kernel regression on the
   new accelerator board. Watch the response stream in.
3. Click **Tag in** → an invite link appears (single-use, expires in 30 minutes).
   **Copy it.**
4. **Open the link in browser window #2** (or an incognito window). Log in / register,
   type **Sam** as display name — you're in, with the full transcript already on screen.
5. As Sam, **ask the AI a question directly** — no relaying through Ava.
6. Watch the AI **answer Sam by name**, streamed live to both windows simultaneously.
7. Back in the host window, **revoke Sam** (make read-only, or kick). Sam can no longer
   send — the guardrails are server-enforced, not UI decoration.

## Repo map

| Path | What it is |
|---|---|
| `server/` | Node ESM backend: HTTP + WebSocket hub, in-memory + SQLite state, turn engine, opencode agent runner (`server/agent/`), local auth, redaction, guards, observability |
| `web/` | Static SPA (one HTML page + vanilla JS/CSS) — no framework, no build step; login/register, dashboard, chat, host controls |
| `docs/design/` | One design doc per specialist: `architecture.md`, `backend.md`, `frontend.md`, `product.md`, `security.md`, `qa.md` |
| `docs/implementation/` | Milestone guides: `M0.md`, `M1.md`, `M2.md` (+ opencode SSE spike) |
| `docs/personas/` | The 8 agent contracts that built this (boss, architect, backend, frontend, security, qa, critic, integrator) |
| `test/` | Vitest unit (`test/unit/`) + Playwright E2E (`test/e2e/`) + autocannon load (`test/load/`) |
| `Dockerfile` · `docker-compose.yml` · `.env.example` | Container build + company-wide config |
| `DEPLOY.md` | One-command company-wide runbook |
| `DECISION_LOG.md` | Append-only record of every architectural choice and why |
| `DEMO.md` | The 3-minute demo script (Ava / Sam kernel-debugging story) |

## How it was built

This rebuild was specified and built by an eight-agent swarm orchestrated through
opencode: a boss agent plus seven specialists (architect, backend, frontend, security,
qa, critic, integrator). Each specialist owns its design doc under `docs/design/` or
`docs/personas/`; the critic's only job is to find what the others got wrong. The
milestone gates (M0, M1, M2) each required critic sign-off before commit. See
[`DECISION_LOG.md`](DECISION_LOG.md) for the trace and [`TASKS.md`](TASKS.md) for the
leaf task list.
