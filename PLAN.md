# TagTeam → opencode Rebuild — Master Plan

**Branch:** `opencode` (off `main`). `main` stays as the Claude-only POC reference.
**Target:** A company-wide product that runs TagTeam on **opencode** (model-agnostic), end-to-end, testable, deployable, announceable — built with **zero admin access and zero budget** until a working POC exists.

## Constraints (hard, from Shash)

1. **opencode only** for now. Claude/Codex backends come later.
2. **No external admin or budget.** No Microsoft Entra / SSO (needs admin), no Slack/Teams webhook delivery (needs webhook perms), no Kubernetes. Everything must run on a developer laptop with `npm install && npm start`.
3. **Real identity without admin**: local-account auth (bcrypt + httpOnly cookie). Upgradeable to OIDC later — the auth interface is provider-agnostic.
4. **Persistence**: SQLite via `better-sqlite3` (local file, no server, no cost).
5. **Branch in the same repo**. Keep pushing to `opencode` so nothing is lost.

## What stays from the POC

- Wire protocol (`server/protocol.js`), session model (`server/sessions.js`), turn engine (`server/turns.js`), HTTP+WS layer (`server/index.js`), web client (`web/`) — **all agent-agnostic**. Minimal edits.
- Invite tokens (single-use, TTL, revoke, read-only) — keep, they're richer than opencode's `session.share`.
- Guardrails v0: single-use tokens, max 2 guests, host revoke, server-side keys, flood guard.

## What gets replaced

- `server/agent/sdkRunner.js` (Claude Agent SDK) → `server/agent/opencodeRunner.js` (`@opencode-ai/sdk`, in-process).
- `server/agent/apiRunner.js` (Anthropic Messages API) → removed (opencode already abstracts providers).
- `server/agent/mockRunner.js` → kept, de-Claude-ified (generic "Assistant (mock)").
- `server/config.js` Claude-specific knobs → opencode provider/model config.
- UI hardcoded "Claude" label → active model name from opencode.

## What gets added (the "product, not POC" flesh)

| Capability | Phase | Why |
|---|---|---|
| opencode agent backend | M0 | the port itself |
| Vitest unit suite | M0 | no tests = no product |
| Playwright E2E (two-browser) | M0 | the demo must be reproducible |
| ESLint + tsc --noEmit | M0 | code hygiene gate |
| GitHub Actions CI | M0 | green CI = merge gate |
| SQLite persistence | M1 | restart = no data loss; enables cross-device resume (Shash's Mac↔Windows setup) |
| Local-account auth (bcrypt, httpOnly cookie) | M1 | real identity, accountability, zero admin |
| Context redaction (host-hidden ranges + secret auto-redaction) | M1 | closes prompt-injection / accidental-leak hole; safe to share |
| Structured logs (pino) + `/metricsz` + audit trail | M1 | observability |
| Abuse guards (per-IP rate limit, origin allowlist, CSRF, session caps) | M1 | safe to expose beyond localhost |
| Dockerfile + docker-compose + env doc | M2 | one-command company-wide deploy |
| Session dashboard (active + past, cross-device resume) | M2 | usability |
| a11y pass (keyboard, SR, contrast) + mobile | M2 | inclusive |
| Load test (autocannon, local) | M2 | know the ceiling |

## Deferred (need admin/budget — not in this build)

- OIDC/SSO (Entra/Google/Okta) — needs admin. Local-auth interface is OIDC-shaped so swap is a later drop-in.
- Slack/Teams invite delivery — needs webhook perms. Copy-paste stays.
- Kubernetes / horizontal scale — single-process is fine for company-wide internal use.
- Expertise personas (summon the expert's agent when the human is asleep) — v1 product, not POC.

## Milestones (done-when)

### M0 — opencode port + testable (≤ 2 weeks)
- [ ] `opencode` branch exists, `main` untouched as reference.
- [ ] `server/agent/opencodeRunner.js` drives a TagTeam session via `@opencode-ai/sdk` `createOpencode()`; maps opencode SSE events → `assistant_delta` / `tool_activity` / `assistant_complete` frames.
- [ ] Mock backend de-Claude-ified; zero-cred `npm start` works and is clearly labeled.
- [ ] Web client shows the active model name, not "Claude".
- [ ] Vitest unit suite: protocol frames, session lifecycle, invite lifecycle (create/expire/use/revoke), resume, turn batching, delta coalescing, flood guard. ≥80% line coverage on `server/`.
- [ ] Playwright E2E: host creates session, tags guest, guest joins via link, guest asks, mock AI answers by name, host revokes, guest can't send. Green.
- [ ] ESLint clean, `tsc --noEmit` clean (JSDoc types).
- [ ] GitHub Actions: lint → typecheck → unit → e2e → build artifact. Green on `opencode`.
- [ ] `npm install && npm start` runs with zero credentials (mock) and with opencode configured.
- [ ] `docs/design/architecture.md` rewritten for opencode; `docs/implementation/M0.md` written.

### M1 — product hardening, zero-admin (2–4 weeks)
- [ ] SQLite: `sessions`, `participants`, `invites`, `messages`, `audit_events`, `users`, `sessions_auth` tables. Restart preserves everything.
- [ ] Local-account auth: register/login (bcrypt), httpOnly secure cookie, `users` table. Identity is real, no admin needed.
- [ ] Context redaction: host can mark transcript ranges guest-hidden; secret patterns (API keys, tokens, paths) auto-redacted before guest delivery.
- [ ] pino structured logs → `logs/tagteam.log` + console; `/metricsz` exposes counters; `audit_events` table records joins/revokes/errors/logins.
- [ ] Abuse guards: per-IP rate limit, origin allowlist (localhost + LAN by default), CSRF token on session-create, max sessions per origin, max failed logins per IP.
- [ ] Cross-device resume: login on Mac, pick up the same session on Windows (Shash's setup).
- [ ] Vitest + Playwright extended for auth, persistence, redaction. CI green.

### M2 — rollout ready (2–3 weeks)
- [ ] `Dockerfile` + `docker-compose.yml` + `.env.example` + `DEPLOY.md`. One command to run company-wide.
- [ ] Session dashboard: host's active + past sessions, one-click resume, cross-device.
- [ ] a11y pass: keyboard-only full flow, screen-reader labels, AA contrast, mobile viewport.
- [ ] Load test (autocannon): document the single-process ceiling (concurrent sessions, messages/sec).
- [ ] `README.md` rewritten for opencode; `DEMO.md` updated; announce draft in `docs/ANNOUNCE.md`.

### Announce
- Demo to the team. Hand them `DEPLOY.md` + the dashboard URL.

## Build crew (opencode agents)

Defined in `opencode.json` at repo root. The **Boss** is the default agent for this project and orchestrates the rest.

| Agent | Role | Owns |
|---|---|---|
| **boss** (default, orchestrator) | Holds the plan, dispatches specialists, blocks bad work, reports status. The only agent that edits `TASKS.md` and `DECISION_LOG.md`. | `PLAN.md`, `TASKS.md`, `DECISION_LOG.md` |
| **architect** | Target architecture, opencode adapter design, module map. | `docs/design/architecture.md` |
| **backend** | `server/` — opencode runner, persistence, auth, redaction, observability, abuse guards. | `server/` |
| **frontend** | `web/` — de-Claude, dashboard, a11y, mobile. | `web/` |
| **security** | Threat model, abuse guards, redaction review, auth review. | `docs/design/security.md` |
| **qa** | Vitest + Playwright + CI. | `test/`, `.github/workflows/` |
| **critic** | Stress-tests every deliverable; blocks merge on gaps. | review only |
| **integrator** | Reconciles docs, README, DEMO, announce. | top-level docs |

Loop: **design → critique → build → integrate → QA → approve → merge**. Boss drives the loop.

## Verification (how we know it works)

- **M0 gate:** Playwright two-browser E2E green on a clean checkout with `MOCK_CLAUDE=1 npm install && npm start`. No API key, no opencode config.
- **M0 gate (real):** Same E2E green with opencode configured (Zen or any provider).
- **M1 gate:** Restart the server mid-session; refresh both browsers; session resumes with full transcript and identity. Redaction E2E: host pastes a secret, guest never sees it. Abuse E2E: 100 rapid invites from one IP → throttled.
- **M2 gate:** `docker compose up` → dashboard reachable → two-browser E2E green against the container. Load test report in `docs/`.

## Risk register

| Risk | Sev | Mitigation |
|---|---|---|
| opencode SDK API drift mid-build | high | Pin `@opencode-ai/sdk` version; adapter behind an interface; mock backend always works. |
| opencode SSE event shapes differ from assumed mapping | high | M0 spike: write the adapter + one E2E first, before anything else. |
| `better-sqlite3` native build fails on Windows | med | Prebuilds ship for Node 20+; fall back to `sql.js` (pure WASM) if install fails. |
| Local auth is "not real enough" for company | med | Interface is OIDC-shaped; Entra drop-in is a later PR, not a rewrite. |
| Scope creep into Slack/Entra/K8s | med | Boss enforces the deferral list; every added item must trace to a milestone. |
| Single-process ceiling hit in production | low | Documented in M2 load test; horizontal scale is explicitly deferred. |
