# TagTeam — stop playing telephone with your AI

**Tag a colleague into your live Claude session. The expert talks to the AI directly — no relaying, no context loss, no waiting.**

---

## The problem

Every team — software, hardware, marketing, sales — now works with AI. But each person's
session is a **silo**: their context, their prompts, their conversation. The moment a task
crosses a team boundary, the AI leverage collapses into a game of telephone.

A software engineer is deep in a Claude session, debugging why an inference kernel
underperforms on the new accelerator board. Claude has all the code context. Past a certain
point, the answer lives with the hardware team — in another office, in another time zone.
Today that looks like this:

```mermaid
sequenceDiagram
    participant HW as Hardware architect (the expert)
    participant SW as Software engineer (the host)
    participant C as Claude
    HW->>SW: asks a question over chat
    SW->>C: retypes it into the session
    C->>SW: answers
    SW->>HW: paraphrases the answer back
    Note over HW,C: Every hop loses context.<br/>Repeat × 10 for one decision.
```

## The idea

TagTeam makes an AI session **multiplayer**. The host clicks **Tag in**, sends a
time-boxed invite link, and the expert joins the *same live conversation* — full
transcript, direct line to Claude, every message attributed by name.

```mermaid
sequenceDiagram
    participant A as Ava — software engineer (host)
    participant TT as TagTeam server
    participant C as Claude
    participant S as Sam — senior hardware architect (guest)
    A->>TT: works with Claude on the kernel bug
    A->>TT: "Tag in" → invite link (30-min, single-use token)
    A-->>S: sends the link across time zones
    S->>TT: opens link, joins the live session
    Note over S: sees the full transcript instantly
    S->>C: asks Claude directly, as himself
    C-->>A: streamed answer, addressed to Sam by name
    C-->>S: (both see everything, live)
    A->>TT: revoke guest when done
```

## Why it matters

- **Zero-hop expertise across team boundaries.** The hardware expert talks to the AI that
  holds the software context — and vice versa. Decisions that took an afternoon of relaying
  take minutes, across offices and time zones.
- **Knowledge moves sideways — and downward.** The session has room for a third seat: a
  junior engineer (Kai) can be tagged in to *shadow* — watching how the senior architect
  actually works the problem. The session becomes the classroom.
- **It meets people where they already are.** No new tool to learn: it's the same AI
  conversation, just with the right people in it.

## How it's built

```mermaid
flowchart LR
    subgraph Browser
        H[Host client]
        G[Guest client]
    end
    subgraph Node server
        WS[WebSocket hub<br/>fan-out to all participants]
        SES[In-memory sessions<br/>participants + transcript]
        TOK[Invite tokens<br/>single-use · 30-min TTL · guest cap]
        PROV[Provider chain]
    end
    A1[Claude Agent SDK<br/>read-only tools]
    A2[Messages API<br/>ANTHROPIC_API_KEY]
    A3[Mock provider<br/>zero credentials]
    H <--> WS
    G <--> WS
    WS --> SES
    WS --> TOK
    SES --> PROV
    PROV --> A1
    PROV -.fallback.-> A2
    PROV -.fallback.-> A3
```

Plain Node.js + a static web client. **No build step, no database, no framework** —
`npm install && npm start` is the entire setup. The provider chain degrades gracefully:
Agent SDK → API key → a clearly-labeled mock mode, so the demo runs with zero credentials.

## Guardrails — v0 now, v1 next

| Now (built) | Next (designed, deferred) |
| --- | --- |
| Single-use invite tokens, 30-min TTL | Real identity / SSO |
| Max 2 guests per session | Context scoping & redaction (what a guest may see) |
| Host can revoke a guest instantly | Chat-platform integration — tag in from where you already work |
| Guests cannot mint invites | Attach to local Claude Code CLI sessions |
| API key never leaves the server | Expertise personas: summon the expert's agent when the human is asleep |

## The meta-story: built by the thing it demonstrates

This POC was designed and built by a **six-agent swarm**: five specialists (product,
architecture, backend, frontend, security) plus a **resident critic** whose only job is to
complain, orchestrated through design → critique → build → integrate → a formal approval
vote by all six. Collaboration between intelligences — human and AI — is both the product
and the process.

---

*Hackathon POC. See `README.md` to run it and `DEMO.md` for the 3-minute demo script.*
