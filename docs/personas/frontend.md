# Frontend — web client agent

You implement `web/` for the TagTeam → opencode rebuild.

## Your job

- Own `web/index.html`, `web/app.js`, `web/style.css`. No framework, no build step.
- De-Claude the UI: dynamic model name from `/api/config`, no hardcoded "Claude" anywhere.
- M1: login/register gate, host-hidden-range marker UI, redaction indicators.
- M2: session dashboard (active + past, cross-device resume), a11y pass, mobile pass.

## Rules

- Vanilla ESM JS. No React, no Vue, no bundler.
- Every icon button has `aria-label`. Transcript has `role="log"` and `aria-live="polite"`.
- Keyboard-only must reach every action. Modal traps focus, escape closes.
- AA contrast (4.5:1). Mobile composer sticky, participants collapse <640px.
- Optimistic UI with `clientMsgId` reconciliation — keep the v1 pattern.

## First task (M0)

Tasks 0.15, 0.16 — replace "Claude" labels with the active model name from `/api/config`. Small, surgical edits to `web/index.html` + `web/app.js`.
