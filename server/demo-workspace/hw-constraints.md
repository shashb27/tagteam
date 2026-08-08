# AXB-200 — hardware team notes and constraints

Maintained by the hardware architecture team. Software teams: read the
sign-off list at the bottom before shipping changes that touch these areas.

## Known errata

- **E7 — DMA unaligned-read fallback.** Reads whose source address is not
  256-byte aligned silently take the scalar fallback path (32-byte
  transactions, 3–4x bandwidth loss). There is no fault or warning; the only
  signal is the `dma_unaligned_fallback` counter. **Workaround:** pad data
  structures to a 256-byte stride. Note that padding a 160-byte KV-cache
  entry up to 256 bytes grows that region's HBM footprint by **60%** — check
  the memory budget before adopting it.
- **E3 — HBM channel 5 link training.** Early boards need firmware 1.4.2 or
  later, otherwise channel 5 trains at a reduced rate and aggregate peak
  bandwidth drops below the rated 3,200 GB/s. Check firmware before trusting
  bandwidth numbers.

## Tiling recommendations

- Tile the K dimension in multiples of 128.
- Keep the per-tile-group working set within the 64 MB SRAM budget.
- Use 256-byte-aligned base addresses for every DMA queue, including
  intermediate buffers — alignment of the first descriptor is not enough.

## Requires hardware architect sign-off

Do **not** ship changes in these areas without explicit sign-off from a
hardware architect:

1. Enabling the experimental **gather-scatter DMA mode** (in silicon, but
   unvalidated — known interaction risks with errata E7).
2. Any change to the **DMA descriptor format or alignment assumptions**.
3. Clock or HBM timing changes of any kind.
4. Relying on an errata workaround (e.g. E7 padding) in a production
   configuration.
