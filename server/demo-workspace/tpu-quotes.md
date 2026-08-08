# TPU Vendor Quotes — Pilot Cluster (Q3)

Internal working notes for the accelerator procurement pilot. Fictional demo data.

## Quote A — CloudPeak Systems (v5e reserved pods)

- Config: 4x v5e pod slices, 16 chips per slice (64 chips total)
- Price: $1.08 per chip-hour, 12-month reserved commit
- Estimated monthly: ~$49,800 (at 100% utilization)
- Delivery: capacity available in 2 weeks
- Notes: cheapest per chip-hour of the three quotes, but the 12-month commit
  locks us in before benchmarks are done.

## Quote B — Hyperion Cloud (v5p on-demand slices)

- Config: on-demand v5p slices, burstable 8–32 chips
- Price: $2.35 per chip-hour, no commit
- Estimated monthly: ~$27,000 (benchmark-spike usage profile, ~35% utilization)
- Delivery: immediate
- Notes: most flexible for the benchmarking phase; unit price is more than
  double Quote A. Best fit if the pilot stays under 3 months.

## Quote C — Arcline Partners (partner resale, mixed v5e/v5p)

- Config: resold reserved capacity, 24 chips fixed
- Price: $1.45 per chip-hour, 6-month commit
- Estimated monthly: ~$25,100
- Delivery: 4–6 weeks (contract novation required)
- Notes: middle ground on price and commit length; delivery risk is the
  longest of the three. Requires legal review of the resale terms.

## Open questions

1. Does IT already have a firewall exception for the vendor management
   portals? (See it-network-notes.md.)
2. Budget line covers the pilot cluster only — anything beyond 8 accelerators
   needs separate approval.
3. Quota increase must be filed BEFORE the purchase order, not after.
