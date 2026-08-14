# TagTeam — Target Architecture (opencode)

**Status:** v2 — contract for the opencode rebuild. Supersedes `docs/design/architecture.md` (v1, Claude POC) on the `opencode` branch. The wire protocol in §6 is unchanged from v1; only the agent layer + persistence/auth/redaction are new.

## 1. Component overview

```
┌──────────────────────── Node 20+ process (single, ESM, no build step) ────────────────────────┐
│                                                                                                │
│  HTTP (node:http)                        WebSocket (/ws, ws lib)                               │
│  ├── GET  /              → web/          ├── join handshake (host/guest/resume)               │
│  ├── GET  /join/:token   → web/          ├── user_message, create_invite, revoke_*            │
│  ├── GET  /login /register → web/        ├── ping/pong keepalive                              │
│  ├── POST /api/sessions                  └── frame validate → sessions/turns                  │
│  ├── POST /api/auth/{register,login,logout}                                                   │
│  ├── GET  /api/config (model name)                                                             │
│  ├── GET  /healthz · /metricsz                                                                 │
│  Static web/ (HTML+JS+CSS, no framework)                                                       │
│                                                                                                │
│         ┌──────────────────────┬───────────────────────┬────────────────────────┐             │
│         │ Session store        │ Turn engine           │ Agent runner           │             │
│         │ (in-memory + SQLite) │ (one run/session,     │ opencode SDK primary   │             │
│         │ sessions, invites,   │  FIFO batch, delta    │ mock fallback          │             │
│         │ participants,        │  coalescing)          │ (zero-credential demo) │             │
│         │ transcript, audit    │                       │                        │             │
│         └──────────┬───────────┴───────────┬───────────┴────────────┬───────────┘             │
│                    │ broadcast                │                       │                         │
│                    ▼                          ▼                       ▼                         │
│              all sockets of session     @opencode-ai/sdk        SQLite (better-sqlite3)       │
│                                         (in-process server)      logs/tagteam.log (pino)       │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **One process, one SQLite file, no external services.** All state lives in module-level Maps (hot) + SQLite (durable). Dies on process crash but restores from SQLite on restart.
- **`server/`** owns everything above; **`web/`** is one static page driving the UX through the protocol in §6.
- `npm install && npm start` is the entire setup. `MOCK_CLAUDE=1` runs with zero credentials.

## 2. Module map (opencode branch)

```
server/
  index.js            # http + ws; unchanged shape, adds /api/auth/*, /api/config, /metricsz
  protocol.js         # wire frames; UNCHANGED from v1
  sessions.js         # in-memory store + SQLite persistence + redaction filter
  turns.js            # turn engine; system prompt de-Claude-ified; otherwise unchanged
  config.js           # opencode provider/model + MOCK_CLAUDE; drops ANTHROPIC_*
  db.js               # NEW: better-sqlite3, schema, migrations, prepared statements
  auth/
    index.js          # NEW: local-account auth (bcrypt + cookie), OIDC-shaped interface
    local.js          # register/login/logout, session cookie
  redact.js           # NEW: secret-pattern auto-redaction + host-hidden ranges
  observe.js          # NEW: pino logger + metricsz counters + audit_events
  guard.js            # NEW: per-IP rate limit, origin allowlist, CSRF, session caps
  agent/
    index.js          # backend selection: opencode (primary) → mock (fallback)
    opencodeRunner.js # NEW: @opencode-ai/sdk in-process; SSE → TagTeam frames
    mockRunner.js     # de-Claude-ified canned responses (zero-cred demo)
  demo-workspace/     # read-only file tree the agent can Read/Grep (unchanged)
web/
  index.html · app.js · style.css   # de-Claude-ified; + login/register; + dashboard (M2)
test/
  unit/   # protocol, sessions, turns, flood, agent-mock, agent-opencode, auth, redact, guard
  e2e/    # two-browser.spec, redaction.spec, abuse.spec, resume.spec
docs/
  design/        # architecture.md (this), security.md, qa.md
  implementation/ # M0.md, M1.md, M2.md
  personas/      # boss.md, architect.md, backend.md, frontend.md, security.md, qa.md, critic.md, integrator.md
opencode.json    # 8 agents; boss is default
PLAN.md · TASKS.md · DECISION_LOG.md
```

## 3. Identity, keys, tokens (unchanged from v1 + auth)

| Term | What it is | Who sees it |
|---|---|---|
| `sessionId` | UUID | everyone in the session |
| `hostKey` | UUID capability; proves "I am the host" | host browser only |
| `inviteToken` | UUID, single-use, TTL'd, server-side lookup | host + the one guest who uses it |
| `participantId` | UUID at join | everyone (attribution + revoke) |
| `resumeKey` | UUID; same-browser reattach after refresh/WS drop | that participant's browser only |
| `clientMsgId` | client-generated, ≤64 chars; echoed for optimistic-UI reconciliation | sender + everyone |
| **`userId`** (new M1) | UUID for a local-account identity | the user + server; bound to participant on join |
| **`authSid`** (new M1) | session cookie value (opaque, httpOnly) | the user's browser only |

All server-generated IDs are `crypto.randomUUID()`.

## 4. HTTP surface (v2 — additions marked NEW)

| Method & path | Purpose |
|---|---|
| `GET /` · `/join/:token` · `/login` · `/register` · `/dashboard` | serve `web/index.html` (SPA-style routing in the client) |
| `GET /web/*` | static assets |
| `POST /api/sessions` | create session (CSRF-protected M1) → `{sessionId, hostKey, wsPath}` |
| `GET /api/config` (NEW) | `{ modelName }` for the UI label |
| `POST /api/auth/register` (NEW M1) | `{email, password, name}` → sets cookie |
| `POST /api/auth/login` (NEW M1) | `{email, password}` → sets cookie |
| `POST /api/auth/logout` (NEW M1) | clears cookie |
| `GET /api/auth/me` (NEW M1) | current user or 401 |
| `GET /healthz` | `{ok, agentImpl}` |
| `GET /metricsz` (NEW M1) | counters |

## 5. Session state shape

Identical to v1 (`docs/design/architecture.md` v1 §5) with these additions:

- `session.hostUserId` — the `userId` of the host (M1).
- `participant.userId` — bound identity (M1; null in M0).
- `participant.hiddenRanges` — transcript ranges the host marked guest-hidden (M1).
- `audit_events` table (M1) — every join/revoke/login/error.

## 6. Wire protocol (UNCHANGED from v1)

See v1 `docs/design/architecture.md` §6 for the full frame contract. Backend and frontend are built independently against it. **M0 must not change any frame type.** The only protocol-level addition is in M1: the `joined` snapshot's transcript entries may carry a `redacted` flag for guests (host-hidden ranges replaced with a placeholder).

## 7. Agent runner — opencode adapter

```
TagTeam turn start
  → session.agent = opencodeRunner.createAgentSession({ sessionId })
  → opencode.session.create({ title: sessionId })
  → opencode.session.prompt({ path: { id }, body: { system, parts, tools } })
  → opencode.event.subscribe() SSE stream:
       text delta      → turns.onEvent({type:'text_delta'}) → assistant_delta frame
       tool call start → tool_activity frame (phase: start)
       tool result     → tool_activity frame (phase: end)
       final message   → assistant_complete frame
  → abort via session.abort on timeout/revoke
```

**Tool allowlist:** Read, Grep, Glob — confined to `server/demo-workspace/`. Enforced via opencode's permission config (M0 task 0.14). No network-egress tools (WebSearch/WebFetch) — a prompt-injected guest must not exfiltrate.

**Backend selection (M0):**
1. `opencode` (primary) — if `@opencode-ai/sdk` loads and a provider is configured.
2. `mock` (fallback) — zero credentials, canned streaming responses, clearly labeled.

The Anthropic Messages-API fallback is removed (opencode already abstracts providers).

## 8. Persistence (M1)

SQLite via `better-sqlite3`. One file: `data/tagteam.db` (path from env, default in repo gitignored). Schema:

```sql
users(id, email UNIQUE, name, passhash, created_at)
sessions(id, host_user_id, host_key, created_at, last_activity_at, title)
participants(id, session_id, user_id, name, role, can_send, status, joined_at, resume_key)
invites(token PK, session_id, created_at, expires_at, used_by, revoked)
messages(id, session_id, seq, role, author_id, author_name, text, ts, streaming, tool_events_json)
audit_events(id, ts, session_id, user_id, kind, detail_json)
auth_sessions(sid PK, user_id, created_at, expires_at)   -- cookie session
```

Write-through: every state mutation in `sessions.js` also writes to SQLite inside a transaction. On restart, `db.js` loads active sessions into the in-memory Maps.

Fallback if `better-sqlite3` native install fails: `sql.js` (pure WASM) — same schema, slower. Decided at install time, documented in `DEPLOY.md`.

## 9. Auth (M1, local accounts, OIDC-shaped interface)

```js
// server/auth/index.js
export const AuthProvider = {
  async register({email, password, name}) → {user} | throws
  async login({email, password})          → {user} | throws
  async logout(req)
  async currentUser(req)                  → {user} | null
  // OIDC drop-in replaces these four methods; everything else stays.
}
```

- bcrypt password hash, 12 rounds.
- Session cookie `tt_sid` — httpOnly, Secure (in prod), SameSite=Lax, 7-day expiry, rotated on login.
- Invite tokens bind to `userId` on redemption (one token → one user, still single-use).
- The interface is intentionally OIDC-shaped: an Entra/Google provider later implements the same four methods with `oidc-client` instead of bcrypt.

## 10. Redaction (M1)

Two layers:

1. **Auto-redaction** — `server/redact.js` scans outgoing text for secret patterns before delivery to guests: API keys (`sk-...`, `sk-ant-...`), bearer tokens, `password=...`, internal file paths, emails. Replaces with `[redacted]`.
2. **Host-hidden ranges** — host marks transcript message ranges as "hidden from guests" via a new `hide_range` frame. Guests receive those ranges as `[hidden by host]`. Stored on `participant.hiddenRanges` + persisted.

Redaction runs in `buildSnapshot` / `serializeMessage` when the recipient is a guest.

## 11. Observability + abuse guards (M1)

- **pino** logger → `logs/tagteam.log` + stdout. Every frame handler logs at debug; every error at error; every join/revoke/login at info.
- **`/metricsz`** — `{sessions, activeConnections, messagesTotal, errorsTotal, avgRunMs}`.
- **`audit_events`** — append-only, queryable.
- **Per-IP rate limit** — token bucket: 10 session-creates/min, 60 messages/min/IP.
- **Origin allowlist** — `ALLOWED_ORIGINS` env (default `localhost,127.0.0.1,192.168.0.0/16`).
- **CSRF** — double-submit token on `POST /api/sessions` and `/api/auth/*`.
- **Caps** — max 25 sessions (existing), max 5 sessions/origin, max 10 failed logins/IP/10min.

## 12. Deployment (M2)

- `Dockerfile` — node:20-slim, copy `server/` + `web/` + `package.json`, `npm ci --omit=dev`, `CMD node server/index.js`.
- `docker-compose.yml` — one service, volume for `data/` and `logs/`, env from `.env`.
- `.env.example` — every knob documented.
- `DEPLOY.md` — one-command company-wide run.

## 13. Build order (cross-reference)

M0 (§7 agent adapter, §6 protocol unchanged, tests) → M1 (§8 persistence, §9 auth, §10 redaction, §11 observe/guard) → M2 (§12 deploy + dashboard + a11y). See `TASKS.md` for the leaf tasks and `PLAN.md` for the done-when gates.
