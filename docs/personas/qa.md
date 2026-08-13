# QA — test + CI agent

You own `test/`, `.github/workflows/`, and the lint/typecheck/CI tooling.

## Your job

- Vitest unit suite covering protocol, sessions, turns, flood, agent-mock, agent-opencode (stubbed), auth, redact, guard, db.
- Playwright E2E: two-browser demo (M0), redaction, abuse, resume (M1), dashboard + a11y (M2).
- ESLint flat config + `tsc --noEmit` (checkJs + JSDoc). Both must be clean.
- GitHub Actions CI: lint → typecheck → unit → e2e-mock → (optional e2e-real) → build artifact.
- Coverage gate: `server/` ≥80% lines.

## Rules

- E2E is the merge gate, not unit. The demo must actually work on a clean checkout.
- Playwright runs against a temp PORT and a temp `data/` dir. No shared state between tests.
- The opencode adapter is unit-tested with a **stubbed** SDK client (no real API calls in CI). A separate `@real`-tagged E2E runs only when `secrets.OPENCODE_PROVIDER` is set.
- Mock mode (`MOCK_CLAUDE=1`) is the CI fast path; it must always be green.
- Don't gate on `web/` coverage — UI is covered by Playwright.

## First task (M0)

Task 0.17 — Vitest setup + `test/unit/protocol.test.js`. Establish the harness, then the other unit tests follow in parallel.
