# TagTeam → opencode — Decision Log

Append-only. Every entry: `## <ISO date+time> — <Stage>: <one-line summary>` then Decision / Evidence / Open question. Never rewrite history; if reversed, add a new entry referencing the old one.

---

## 2026-08-12 — Framing: opencode-only rebuild, zero-admin, zero-budget

- **Decision:** Rebuild TagTeam on opencode (model-agnostic) on branch `opencode`. Drop Claude/Codex backends for now. No external admin or budget until a working POC exists — so no Entra/SSO, no Slack webhook, no K8s. Local-account auth (bcrypt) replaces SSO; SQLite (local file) replaces any managed DB. Boss agent orchestrates the build.
- **Evidence:** Shash: "focus on opencode… I don't have the leverage to go buy new tools or get admin access until I have a working POC." Repo analysis: wire protocol, session model, invite lifecycle, turn engine, and web client are all agent-agnostic — only `server/agent/*` + a few UI strings are Claude-specific.
- **Open question:** provider/model default — opencode Zen vs pinned Anthropic via opencode. (Deferred to M0 spike; Zen is the working assumption.)

## 2026-08-12 — Architecture: in-process opencode SDK, keep the shell

- **Decision:** Use `@opencode-ai/sdk` `createOpencode()` in-process (Approach B). One TagTeam session = one opencode session. Map opencode SSE events onto the existing `assistant_delta` / `tool_activity` / `assistant_complete` frames. Wire protocol, HTTP surface, sessions/turns/protocol modules, and web client stay; `server/agent/*` is replaced.
- **Evidence:** Current design is single-process, no-build, in-memory — in-process SDK preserves that. opencode SDK exposes `session.prompt` + `event.subscribe` SSE with text/tool parts that map cleanly to TagTeam frames. A separate `opencode serve` (Approach A) would add a second process and ops overhead for no benefit at this scale.
- **Open question:** Does opencode's SSE actually emit per-token text deltas and paired tool start/end? M0 task 0.8 spikes this first.

## 2026-08-12 — Auth: local accounts now, OIDC-shaped interface, Entra later

- **Decision:** M1 ships local-account auth (bcrypt + httpOnly cookie, `users` table). The auth interface is provider-agnostic so Microsoft Entra / Google / Okta is a later drop-in PR, not a rewrite. Invite tokens bind to a user identity on redemption.
- **Evidence:** Shash has no admin access yet. Local accounts give real identity + accountability with zero infra. The POC's display-name-only model is not company-safe (no accountability, trivial impersonation).
- **Open question:** Password policy + session-cookie expiry — security agent owns this in `docs/design/security.md`.
