# AXB-200 accelerator board — key specifications

Internal engineering summary, rev 1.3 (fictional demo hardware).

## Memory

- **HBM3:** 96 GB total, 8 channels
- **Peak memory bandwidth:** 3,200 GB/s aggregate
- **On-chip SRAM:** 64 MB, shared across tile groups

## Compute

- 128 compute tiles @ **1.6 GHz** sustained clock
- fp16 / bf16 native; fp32 accumulate
- Host link: PCIe Gen5 x16

## DMA engine

- Descriptor-based DMA between HBM and SRAM.
- **Source addresses must be 256-byte aligned**; transfer lengths must be
  multiples of 128 bytes.
- **Unaligned reads do not fault.** They silently fall back to a scalar slow
  path that splits the transfer into 32-byte transactions, typically cutting
  effective bandwidth by **3–4x**. The `dma_unaligned_fallback` performance
  counter increments on every fallback read.
- An experimental gather-scatter DMA mode exists in silicon but is not yet
  validated — see `hw-constraints.md` before considering it.

## Practical bandwidth expectations

- Streaming (sequential) kernels: 80–90% of peak is achievable.
- Well-aligned gather patterns: 60–70% of peak is the realistic ceiling.
- Anything measuring below ~30% of peak on this board almost always means
  the DMA slow path is engaged.
