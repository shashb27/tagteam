# TagTeam → opencode — Live Task List

**Owner of this file:** the **boss** agent. Only the boss edits this. Specialists read it and report status to the boss; the boss moves items across columns.

Legend: `[ ]` pending · `[~]` in progress · `[x]` done · `[!]` blocked

---

## M0 — opencode port + testable

### Setup
- [ ] 0.1 Create `opencode` branch (done — created this session)
- [ ] 0.2 Write `opencode.json` at repo root with boss + 7 specialist agents (boss default)
- [ ] 0.3 Write `docs/design/architecture.md` (opencode target) — architect
- [ ] 0.4 Write `docs/design/security.md` (opencode target) — security
- [ ] 0.5 Write `docs/design/qa.md` (test strategy) — qa
- [ ] 0.6 Write `docs/personas/*.md` for all 8 agents — boss
- [ ] 0.7 Write `docs/implementation/M0.md` (module-by-module guide) — architect + backend

### Port the agent backend
- [ ] 0.8  Spike: minimal `server/agent/opencodeRunner.js` — one opencode session, echo a prompt, stream text deltas. Verify the SSE event shape. — backend
- [ ] 0.9  Map opencode events → TagTeam frames (`text_delta`→`assistant_delta`, tool call→`tool_activity` start, tool result→`tool_activity` end, final→`assistant_complete`). — backend
- [ ] 0.10 Replace `server/agent/index.js` backend selection: opencode (primary) → mock (fallback). Remove Anthropic SDK runners. — backend
- [ ] 0.11 Update `server/config.js`: drop `ANTHROPIC_API_KEY`/`TAGTEAM_MODEL`; add opencode provider/model + `MOCK_CLAUDE`. — backend
- [ ] 0.12 De-Claude `server/turns.js` system prompt ("You are the opencode agent inside TagTeam…"). — backend
- [ ] 0.13 De-Claude `server/agent/mockRunner.js` (generic "Assistant (mock)"). — backend
- [ ] 0.14 Read-only tool allowlist + demo-workspace confinement via opencode permission config. — backend + security

### Web client
- [ ] 0.15 Replace "Claude" labels in `web/index.html` + `web/app.js` with the active model name (fetch from a new `/api/config` endpoint). — frontend
- [ ] 0.16 Roster "AI" pinned row → dynamic model name. — frontend

### Tests
- [ ] 0.17 Vitest setup + `test/unit/protocol.test.js` (frame shapes, error codes). — qa
- [ ] 0.18 `test/unit/sessions.test.js` (create, invite lifecycle, resume, revoke). — qa
- [ ] 0.19 `test/unit/turns.test.js` (FIFO batch, delta coalescing, system prompt roster). — qa
- [ ] 0.20 `test/unit/flood.test.js` (per-connection flood guard). — qa
- [ ] 0.21 `test/unit/agent-mock.test.js` (mock backend streams canned text, attributes by name). — qa
- [ ] 0.22 `test/unit/agent-opencode.test.js` (opencode adapter event mapping, using a stubbed opencode client). — qa + backend
- [ ] 0.23 Playwright setup + `test/e2e/two-browser.spec.js` (host→tag→guest→ask→answer→revoke). Mock mode. — qa
- [ ] 0.24 Coverage gate: ≥80% lines on `server/`. — qa

### Tooling + CI
- [ ] 0.25 `eslint.config.js` (flat config, ESM). — qa
- [ ] 0.26 `tsconfig.json` (checkJs, JSDoc) + `tsc --noEmit`. — qa
- [ ] 0.27 `.github/workflows/ci.yml`: install → lint → typecheck → unit → e2e → upload artifact. — qa
- [ ] 0.28 `package.json` scripts: `lint`, `typecheck`, `test`, `test:e2e`, `start`. — qa

### M0 gate
- [ ] 0.29 Clean checkout, `MOCK_CLAUDE=1 npm install && npm start`, Playwright E2E green. — qa (verifies), boss (approves)
- [ ] 0.30 Same with opencode configured (Zen or any provider). — qa
- [ ] 0.31 Critic sign-off on M0. — critic
- [ ] 0.32 Commit + push `opencode` branch. — boss

---

## M1 — product hardening, zero-admin

### Persistence
- [ ] 1.1  `server/db.js` — better-sqlite3, schema, migrations. — backend
- [ ] 1.2  Persist sessions, participants, invites, messages on every state change. — backend
- [ ] 1.3  Restart-resume test: kill server, restart, reload browser, state intact. — qa

### Auth (local accounts, zero admin)
- [ ] 1.4  `server/auth/` — register, login (bcrypt), session cookie (httpOnly, secure, sameSite). — backend + security
- [ ] 1.5  `users` table; invite tokens bind to a user on redemption. — backend
- [ ] 1.6  UI: login/register gate before session create; guest join requires login too. — frontend
- [ ] 1.7  Auth interface OIDC-shaped (so Entra is a later drop-in). — architect

### Context redaction
- [ ] 1.8  Secret-pattern auto-redaction (API keys, tokens, internal paths) before guest delivery. — backend + security
- [ ] 1.9  Host "hide from guests" range marker in the transcript. — frontend + backend
- [ ] 1.10 Redaction E2E: host pastes a secret, guest transcript omits it. — qa

### Observability
- [ ] 1.11 pino structured logs → `logs/tagteam.log` + console. — backend
- [ ] 1.12 `/metricsz` counters (sessions, messages, errors, active connections). — backend
- [ ] 1.13 `audit_events` table: joins, revokes, logins, errors. — backend

### Abuse guards
- [ ] 1.14 Per-IP rate limit on session-create and message-send. — backend + security
- [ ] 1.15 Origin allowlist (localhost + LAN by default, env-configurable). — backend
- [ ] 1.16 CSRF token on `POST /api/sessions`. — backend + security
- [ ] 1.17 Max sessions per origin, max failed logins per IP. — backend
- [ ] 1.18 Abuse E2E: 100 rapid invites from one IP → throttled. — qa

### M1 gate
- [ ] 1.19 Cross-device resume E2E (two machines / two profiles). — qa
- [ ] 1.20 Critic sign-off on M1. — critic
- [ ] 1.21 Commit + push. — boss

---

## M2 — rollout ready

- [ ] 2.1  `Dockerfile` + `docker-compose.yml` + `.env.example` + `DEPLOY.md`. — backend
- [ ] 2.2  Session dashboard (active + past, cross-device resume). — frontend
- [ ] 2.3  a11y pass (keyboard, screen reader, AA contrast). — frontend + qa
- [ ] 2.4  Mobile viewport pass. — frontend
- [ ] 2.5  Load test (autocannon), report in `docs/`. — qa
- [ ] 2.6  `README.md` rewrite for opencode; `DEMO.md` update; `docs/ANNOUNCE.md` draft. — integrator
- [ ] 2.7  Critic sign-off on M2. — critic
- [ ] 2.8  Commit + push; tag `v1.0.0-opencode`. — boss

---

## Deferred (not in this build — needs admin/budget)

- [ ] OIDC/SSO (Entra/Google/Okta) — interface is ready, drop-in later.
- [ ] Slack/Teams invite delivery.
- [ ] Kubernetes / horizontal scale.
- [ ] Expertise personas (auto-respond as the expert when they're asleep).
- [ ] Session dashboards for admins (cross-user).
