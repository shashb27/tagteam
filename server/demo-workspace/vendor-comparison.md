# Vendor Comparison Matrix — TPU Pilot

Fictional demo data. Summarizes tpu-quotes.md for the procurement review.

| Criterion            | CloudPeak (A)      | Hyperion (B)       | Arcline (C)        |
| -------------------- | ------------------ | ------------------ | ------------------ |
| Hardware             | v5e reserved pods  | v5p on-demand      | mixed v5e/v5p      |
| $/chip-hour          | $1.08              | $2.35              | $1.45              |
| Commit               | 12 months          | none               | 6 months           |
| Est. monthly         | ~$49.8k            | ~$27k              | ~$25.1k            |
| Delivery             | 2 weeks            | immediate          | 4–6 weeks          |
| Flexibility          | low                | high               | medium             |
| Contract risk        | low                | low                | medium (novation)  |

## Recommendation draft

- For the 8-week benchmarking phase: Hyperion (B) on-demand — no commit,
  immediate start, spikes are cheap at ~35% utilization.
- For the follow-on production order: re-quote after benchmarks; CloudPeak (A)
  wins on unit economics only if sustained utilization exceeds ~60%.
- Decision blocked on: IT network readiness (vendor portal access) and the
  quota increase filing. See it-network-notes.md.
