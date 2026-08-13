# TagTeam — Security Design (opencode rebuild)

**Status:** v2. Supersedes v1 (Claude POC) on the `opencode` branch.

## 1. Threat model

| Threat | Attack | Mitigation |
|---|---|---|
| Impersonation | Anyone types a colleague's display name | M1: local-account auth; identity bound to invite token on redemption |
| Invite abuse | Guest shares the link around | Single-use tokens (v0); M1: bound to a user identity on redemption |
| Prompt injection via guest | Guest sends a message that makes the AI exfiltrate files | Read-only tool allowlist (Read/Grep/Glob only); no WebSearch/WebFetch; confined to `demo-workspace/`; `canUseTool` gate |
| Secret leak to guest | Host pastes an API key; guest sees it | M1: auto-redaction (secret patterns) + host-hidden ranges |
| Credential leak | API key leaves the server | Key never sent to the client; opencode runs server-side; `ANTHROPIC_API_KEY`/provider keys live only in server env |
| Session hijack | Guess `hostKey`/`resumeKey` | 128-bit random UUIDs; `hostKey` never broadcast; `resumeKey` per-participant, validated on resume |
| CSRF | Cross-site POST creates sessions | M1: double-submit CSRF token on state-changing endpoints |
| Flood / DoS | Rapid messages or session creates | Per-connection flood guard (v0); M1: per-IP token bucket |
| Origin spoofing | Random origin hits the server | M1: origin allowlist (localhost + LAN by default) |
| Brute-force login | Guess passwords | M1: bcrypt 12 rounds + max 10 failed logins/IP/10min |
| Data loss | Process crash | M1: SQLite write-through; restart restores state |
| Audit gap | "Who revoked whom?" unanswerable | M1: `audit_events` table + pino logs |

## 2. Tool allowlist (enforced in opencode permission config)

Allowed: `Read`, `Grep`, `Glob` — confined to `server/demo-workspace/` (path resolution + prefix check, same logic as v1 `sdkRunner.makeCanUseTool`).

Denied: `Write`, `Edit`, `Bash`, `NotebookEdit`, `TodoWrite`, `Task`, `WebSearch`, `WebFetch`, any MCP tool.

The allowlist is enforced at the opencode layer AND re-checked in the TagTeam adapter (defense in depth). If opencode's permission config ever drifts, the adapter still blocks.

## 3. Auth (M1) — local accounts, zero admin

- bcrypt 12 rounds. Password policy: ≥10 chars, ≥1 letter + 1 digit, no max (passphrase-friendly).
- Cookie `tt_sid`: httpOnly, Secure (when `BASE_URL` is https), SameSite=Lax, 7-day expiry, rotated on login, cleared on logout.
- Rate limit: max 10 failed logins per IP per 10 min → 15-min lockout for that IP.
- Email is the login identifier; no email verification in M1 (no SMTP without admin). Documented as a known gap; Entra drop-in removes it.
- Session creation and guest join both require a logged-in user.

## 4. Invite lifecycle (v0 rules, +identity in M1)

1. Host (logged in) `POST /api/sessions` (CSRF token) → `{sessionId, hostKey}`.
2. Host WS-joins with `hostKey`. Host is bound to `hostUserId`.
3. Host `create_invite` → token (UUID, 30-min TTL, single-use, server-side index).
4. Guest (logged in) opens `/join/:token` → WS-joins as guest. On join, token burns (`usedBy = guest.userId`); participant is bound to `userId`.
5. Host can `revoke_guest` (kick / read-only / restore) at any time.
6. Token expired/used/revoked → `TOKEN_EXPIRED`/`TOKEN_USED`/`TOKEN_REVOKED` fatal error.

## 5. Redaction (M1)

**Auto-redaction patterns** (in `server/redact.js`):
- `sk-ant-[A-Za-z0-9-_]+` (Anthropic keys)
- `sk-[A-Za-z0-9]{20,}` (generic API keys)
- `Bearer [A-Za-z0-9._-]+`
- `password\s*[:=]\s*\S+`
- `/Users/\S+`, `/home/\S+`, `C:\\\\Users\\\\\S+` (local paths)
- `\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b` (emails, optional flag)

Applied to every message delivered to a guest (in `serializeMessage` when recipient role is guest). Hosts see the raw text.

**Host-hidden ranges** — host sends `hide_range` frame with `{messageId, start, end}`; stored on `participant.hiddenRanges`; guests see `[hidden by host]` in that range. Auto-redaction still runs on visible ranges.

## 6. Abuse guards (M1)

- Per-IP token bucket: 10 `POST /api/sessions`/min, 60 `user_message`s/min.
- Origin allowlist via `ALLOWED_ORIGINS` env (default `localhost,127.0.0.1,192.168.0.0/16,10.0.0.0/8`).
- CSRF: double-submit token (`tt_csrf` cookie + `X-CSRF-Token` header) on all state-changing POSTs.
- Caps: 25 sessions total, 5 sessions/origin, 2 guests/session (v0), 10 failed logins/IP/10min.

## 7. Observability + audit (M1)

- pino → `logs/tagteam.log` (rotated daily) + stdout.
- `audit_events` table: `(ts, session_id, user_id, kind, detail_json)`. Kinds: `session_create`, `join`, `revoke`, `login_success`, `login_fail`, `error`, `redaction_triggered`.
- `/metricsz` — non-authenticated counters only (no per-user data).

## 8. Known gaps (deferred, need admin/budget)

- No email verification (no SMTP) → M1 local auth accepts any email. Entra drop-in fixes this.
- No HTTPS termination in-process → rely on reverse proxy / Docker + `BASE_URL=https://…`.
- No content moderation on guest messages.
- Single-process scale ceiling (documented in M2 load test).
- Expertise personas (auto-respond as the expert when asleep) — v1 product, not POC.
