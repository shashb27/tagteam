# TagTeam — team announcement (DRAFT)

> Status: **draft**. Sends after the critic signs off on M2 and the boss tags
> `v1.0.0-opencode`. Replace `<repo>` with the real clone URL before posting.

---

## Slack / Teams message

```
TagTeam is rebuilt on opencode and ready for a company-wide deploy.

What it is: tag a colleague into your live AI coding session. The expert talks
to the AI directly — no relaying, no context loss. Single-use invite link,
30-min TTL, host can revoke (read-only or kick) at any time.

Zero admin: first user registers via the UI and gets a normal local account
(bcrypt + cookie). No SSO, no bootstrap admin, no external services. State
lives in a local SQLite file — sessions survive a restart and resume from
another machine.

Model-agnostic: the AI backend is opencode, so it rides whatever provider
you already have credentials for (Anthropic, OpenAI, BigModel, local…).
Mock mode runs the whole demo with zero credentials.

One-command deploy: `cp .env.example .env && docker compose up -d` →
http://localhost:3000. Full runbook: <repo>/DEPLOY.md.

Backends deferred on purpose (not blocked, just not needed yet): Entra/SSO
(interface is already OIDC-shaped, drop-in later), Slack/Teams invite
delivery, Kubernetes horizontal scale.

Try it: <repo>. 5-min demo script below.
```

---

## 5-min demo script

Prep (once, on the host machine):

```bash
git clone <repo> tagteam && cd tagteam
cp .env.example .env            # leave MOCK_CLAUDE=1 for the zero-cred demo
docker compose up -d
open http://localhost:3000
```

Two browsers side by side (normal + incognito so they don't share storage).

**0:00 — Register + start.** In the left (host) browser: click **Register**,
create an account, log in, click **New session**, display name **Ava**. Chat
with the AI about anything — e.g. "Compare the kernel profiles in the demo
folder and flag anything the hardware team needs to weigh in on." Watch the
response stream. (In mock mode the AI is labeled "Assistant (mock)"; on the
opencode backend the model name from `/api/config` is shown.)

**1:00 — Tag in.** Click **Tag in a colleague** → **Copy link**. Paste the
link into the right (guest) browser. Register / log in there too, display
name **Sam**, click **Join session**. Sam's window now shows the **full
transcript**. Both rosters list Ava, Sam, and the AI.

**2:00 — Expert talks to the AI directly.** As Sam, send:

> Is the kv_cache_gather slowdown the unaligned-DMA errata, and can we pad
> the KV entries to 256 bytes without blowing the memory budget?

The AI answers **addressing Sam by name**. Ava sees every token live in her
window. No relay, no paraphrase loss.

**3:00 — Host control.** In Ava's roster, hover Sam's row:
1. Eye icon → **view-only**. Sam's composer locks; have Sam try to type.
2. Click again → **restore**. Sam can send again.
3. ✕ twice → **kick**. Sam gets "removed from session"; the invite link is
dead (single-use).

**4:00 — Dashboard + mobile.** Point at `/dashboard` (Ava's active + past
sessions, one-click resume — works cross-device). Resize the window under
640px to show the mobile layout: composer sticky, participants collapse to a
drawer.

**4:30 — Close.** "Single container, local SQLite, zero admin. Same
protocol carries to Entra/SSO, Slack delivery, and K8s when we need them —
those are drop-ins, not rewrites. Stop playing telephone with your AI. Tag
your expert in."

---

## Notes for the announcer

- The demo runs fully in mock mode (`MOCK_CLAUDE=1`) — no AI credentials
  needed. Flip to real opencode by running `opencode auth` on the host and
  removing `MOCK_CLAUDE` from `.env`.
- Don't claim features that aren't shipped. Deferred (say so if asked):
  Entra/SSO, Slack/Teams invite delivery, Kubernetes scale, expertise
  personas, admin dashboards.
- Full architecture: `docs/design/architecture.md`. Decisions + reasoning:
  `DECISION_LOG.md`. Deploy runbook: `DEPLOY.md`.
