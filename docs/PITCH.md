# TagTeam — stop playing telephone with your AI

**Tag a colleague into your live Claude session. The expert talks to the AI directly — no relaying, no context loss, no waiting.**

---

## The problem (a true story)

Shash, a product lead, is deep in a Claude session working through TPU procurement.
Past a certain point he needs Teja from IT. Today that looks like this:

```mermaid
sequenceDiagram
    participant T as Teja (the expert)
    participant S as Shash (the host)
    participant C as Claude
    T->>S: asks a question over chat
    S->>C: retypes it into his session
    C->>S: answers
    S->>T: paraphrases the answer back
    Note over T,C: Every hop loses context.<br/>Repeat × 10 for one decision.
```

Every team — software, hardware, marketing, sales — has this problem. Everyone uses AI,
but each person's session is a **silo**. Expertise can't step into the room where the work
is actually happening.

## The idea

TagTeam makes an AI session **multiplayer**. The host clicks **Tag in**, sends a
time-boxed invite link, and the expert joins the *same live conversation* — full
transcript, direct line to Claude, every message attributed by name.

```mermaid
sequenceDiagram
    participant S as Shash (host)
    participant TT as TagTeam server
    participant C as Claude
    participant T as Teja (guest)
    S->>TT: works with Claude in a session
    S->>TT: "Tag in" → invite link (30-min, single-use token)
    S-->>T: sends the link
    T->>TT: opens link, joins the live session
    Note over T: sees the full transcript instantly
    T->>C: asks Claude directly, as himself
    C-->>S: streamed answer, addressed to Teja by name
    C-->>T: (both see everything, live)
    S->>TT: revoke guest when done
```

## Why it matters

- **Zero-hop expertise.** The person who knows the answer talks to the AI that has the
  context. Decisions that took an afternoon of relaying take minutes.
- **Knowledge moves sideways.** A junior can be tagged into a senior's session and watch
  how the problem actually gets worked — the session becomes the classroom.
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
| Host can revoke a guest instantly | Teams integration — tag in from where you already chat |
| Guests cannot mint invites | Attach to local Claude Code CLI sessions |
| API key never leaves the server | Expertise personas: summon "Agent Teja" when the human is asleep |

## The meta-story: built by the thing it demonstrates

This POC was designed and built by a **six-agent swarm**: five specialists (product,
architecture, backend, frontend, security) plus a **resident critic** whose only job is to
complain, orchestrated through design → critique → build → integrate → a formal approval
vote by all six. Collaboration between intelligences — human and AI — is both the product
and the process.

---

*Hackathon POC by Shash Bhaskar. See `README.md` to run it and `DEMO.md` for the 3-minute demo script.*
