# TagTeam — QA / Test Strategy (opencode rebuild)

**Status:** v2. Supersedes v1 on the `opencode` branch.

## 1. Layers

| Layer | Tool | What it proves | Gate |
|---|---|---|---|
| Unit | Vitest | protocol frames, session lifecycle, invite lifecycle, resume, turn batching, delta coalescing, flood guard, redaction, auth, guard | ≥80% lines on `server/` |
| Integration | Vitest (supertest + ws client) | HTTP surface + WS handshake + persistence roundtrip | all green |
| E2E | Playwright (two browsers, mock mode) | the demo story is reproducible end-to-end | green on clean checkout |
| E2E (real) | Playwright (opencode configured) | the port actually talks to opencode | green before M0 merge |
| Lint | ESLint (flat, ESM) | no warnings | clean |
| Type | `tsc --noEmit` (checkJs + JSDoc) | type safety without a build step | clean |
| Load | autocannon (M2) | single-process ceiling documented | report in `docs/` |

## 2. Unit test plan

`test/unit/protocol.test.js` — every frame type round-trips; error codes map to messages; `v` enforced.
`test/unit/sessions.test.js` — createSession, sanitizeName (control chars, brackets, length), createInvite (TTL clamp), checkInvite (expired/used/revoked/full), appendMessage seq ordering, buildSnapshot shape.
`test/unit/turns.test.js` — enqueueUserMessage starts a run; FIFO batch; delta coalescing (flush by bytes + by timer); system prompt includes roster; `[Name]:` prefix; run timeout aborts; error → assistant_error + assistant_complete.
`test/unit/flood.test.js` — FLOOD_MAX_MSGS in FLOOD_WINDOW_MS → RATE_LIMITED; window slides.
`test/unit/agent-mock.test.js` — mock streams canned text word-by-word; attributes by name; `MOCK_CLAUDE=1` path.
`test/unit/agent-opencode.test.js` — stub the opencode SDK client; assert SSE events map to TagTeam frames (text_delta→assistant_delta, tool call→tool_activity start, tool result→tool_activity end, result→assistant_complete); abort on timeout; dispose on session destroy.
`test/unit/auth.test.js` (M1) — register, login (wrong password fails), cookie set/cleared, currentUser, bcrypt rounds, rate limit on failed logins.
`test/unit/redact.test.js` (M1) — each secret pattern redacted for guests; hosts see raw; host-hidden ranges replace text; redaction is idempotent.
`test/unit/guard.test.js` (M1) — per-IP token bucket; origin allowlist; CSRF token required; session caps enforced.
`test/unit/db.test.js` (M1) — write-through; restart restores; transaction rollback on error.

## 3. E2E test plan

`test/e2e/two-browser.spec.js` (M0):
1. Launch server with `MOCK_CLAUDE=1`.
2. Browser A: `POST /api/sessions`, open `/`, join as host "Ava".
3. Ava sends a message; mock AI streams a response; Ava sees it.
4. Ava clicks "Tag in" → invite URL.
5. Browser B: open invite URL, join as guest "Sam".
6. Sam sees the full transcript.
7. Sam sends a message; mock AI addresses Sam by name; Ava sees it live.
8. Ava revokes Sam (read-only); Sam's composer disables.
9. Ava restores Sam; Sam can send again.
10. Ava kicks Sam; Sam sees the fatal "removed" screen; Sam can't reconnect with the burned token.

`test/e2e/redaction.spec.js` (M1) — host pastes `sk-ant-xxx`; guest never sees it; host does.
`test/e2e/abuse.spec.js` (M1) — 100 rapid `POST /api/sessions` from one IP → 429 after cap.
`test/e2e/resume.spec.js` (M1) — kill server, restart, reload both browsers, state intact, identities intact.
`test/e2e/opencode-real.spec.js` (M0, manual/gated) — same as two-browser but with opencode configured; runs in CI only when `OPENCODE_PROVIDER` is set.

## 4. CI pipeline (`.github/workflows/ci.yml`)

```
jobs:
  lint:        npm ci → eslint
  typecheck:   npm ci → tsc --noEmit
  unit:        npm ci → vitest run --coverage
  e2e-mock:    npm ci → MOCK_CLAUDE=1 playwright test
  e2e-real:    if secrets.OPENCODE_PROVIDER → playwright test --grep @real
  build:       npm ci --omit=dev → upload server+web artifact
```

All jobs must be green to merge `opencode` → protected branch. The Boss enforces this.

## 5. Coverage + gates

- Vitest `--coverage` with `c8`. Gate: `server/` ≥80% lines, `web/` not gated (UI tested via Playwright).
- E2E is the merge gate, not unit — the demo must actually work.

## 6. Test data + fixtures

- Mock backend uses the Ava/Sam kernel-debugging canned script (kept from v1, de-Claude-ified).
- `test/fixtures/demo-workspace/` — copy of `server/demo-workspace/` for isolated test runs.
- Playwright runs against a temp `PORT` and a temp `data/` dir (clean state per run).
