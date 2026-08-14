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

## 2026-08-12 — Spike: opencode SSE event shapes confirmed (plan A, in-process)

- **Decision:** Use in-process `createOpencode({ port: 0 })` — confirmed working end-to-end with provider `bigmodel/glm-5.2`. The adapter will create one opencode session per TagTeam session and pump the global `event.subscribe()` stream.
- **Evidence:** `docs/implementation/spike-opencode-sse.md` (confirmed by running, SDK `@opencode-ai/sdk@1.18.18`). `scripts/spike-output.txt` holds the raw event stream.
- **Corrections to M0.md §3 (architect must apply):**
  1. SDK wraps responses as `{ data, request, response }` — use `s.data.id`, not `s.id`. Same for `session.messages()` / `session.abort()`.
  2. `createOpencode({ port: 0 })` returns `{ client, server }` — use `client` for calls, `server.close()` to tear down.
  3. No discrete `tool_start`/`tool_end` event types. Tools are `message.part.updated` with `part.type:"tool"` and `part.state.status` transitions `pending → running → completed|error`. Adapter synthesizes `tool_start`/`tool_end`.
  4. `message.part.delta` (with `field:"text"`) is a runtime event type NOT in the SDK's `Event` TS union — switch on `ev.type` at runtime; do not rely on the types.
  5. `finish:"tool-calls"` is NOT a stop — only `finish:"stop"` ends the turn.
  6. ~80 catalog/plugin events fire at session create — allowlist the ~6 event types we care about; ignore the rest.
  7. Provider retries (`session.status` `type:"retry"`) are transient — do not treat as fatal.
- **Open question:** Should `reasoning` parts be surfaced as `text_delta` or dropped? TagTeam's UI doesn't surface them separately. Recommend: route to `text_delta` (simplest, no UI change). Architect decides.

