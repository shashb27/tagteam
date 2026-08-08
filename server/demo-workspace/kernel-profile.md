# Kernel profile — decode path on the AXB-200 board

Build: `inference-runtime 2026-08-05` · Workload: 13B-parameter model, fp16,
batch 32, sequence length 4096 · Source: on-board performance counters,
averaged over 500 decode steps.

Peak HBM bandwidth for the AXB-200 is **3,200 GB/s** (see `board-specs.md`).

| Kernel            | Occupancy | Achieved BW (GB/s) | % of peak BW | Latency (ms) | Notes                                  |
|-------------------|-----------|--------------------|--------------|--------------|----------------------------------------|
| `gemm_fp16`       | 84%       | 2,720              | 85%          | 1.10         | Compute-bound; at expectation          |
| `attention_qkv`   | 78%       | 2,460              | 77%          | 0.42         | Healthy; compute/BW balanced           |
| `layernorm`       | 61%       | 2,050              | 64%          | 0.09         | Fine for an elementwise kernel         |
| `softmax_scale`   | 58%       | 1,890              | 59%          | 0.07         | Fine                                   |
| `kv_cache_gather` | 31%       | 704                | **22%**      | 2.85         | **Regression — see analysis below**    |

## Analysis: `kv_cache_gather`

- Roofline estimate for this gather pattern is **~0.65 ms**; measured latency
  is **2.85 ms** (~4.4x slower). It now dominates the decode step.
- The `dma_unaligned_fallback` counter fires on **97%** of the kernel's DMA
  reads. No other kernel trips this counter.
- The regression first appeared in build `2026-07-30`, when the KV cache
  layout changed to a **160-byte per-token stride** (was 256 bytes).
- `board-specs.md` says the DMA engine requires 256-byte-aligned source
  addresses and that unaligned reads silently fall back to a slow scalar
  path — this looks like the cause, but confirming it (and picking a safe
  workaround) needs the hardware team. See `hw-constraints.md`.
