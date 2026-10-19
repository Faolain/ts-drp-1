# Track D numbers (8 rollovers, STARTUP_HEALTHY_GRID_POOL_LULL=1, creator-local)

Builds: rd2-base = 4c4f192c; rd2-b3 = 4c4f192c + patch.diff. Run logs/reports: scratchpad/run-<name>/.

## ABBA interleaved pair (order b3, base, base, b3)

| run | 1-min load | lull p50 (per epoch) | lull max | lull sum (8) | seal t4 / t5 / t6 / t7 | recipient install t7 | creator issue p50 |
|---|---|---|---|---|---|---|---|
| rd2-b3-l1-p1   | 39.8 | 2094.7 | 2394.4 | 11085.4 | 301 / 277 / 271 / 271 | 1027 | 68.0 |
| rd2-base-l1-p1 | 75.5 | 3638.2 | 4055.4 | 19293.8 | 796 / 512 / 668 / 461 | 1821 | 104.6 |
| rd2-base-l1-p2 | 65.3 | 3117.8 | 4011.5 | 17284.6 | 406 / 507 / 844 / 455 | 1709 | 98.4 |
| rd2-b3-l1-p2   | 45.0 | 2218.0 | 2798.1 | 12358.1 | 355 / 300 / 340 / 278 | 1058 | 75.1 |

Mean of p50: b3 2156 vs base 3378 ms (−36%). CAVEAT: the machine was shared (other agents'
benchmarks); load during the patched runs was 40–45 vs 65–75 for base, so part of this is load.

## Earlier, less favourable evidence (same harness)

| run | load | lull p50 | note |
|---|---|---|---|
| rd2-base-l1-a | 34 | 3211 | |
| rd2-b1-l1-a   | 21 | 2359 | batch 1 (bulk reads + blob prefetch) |
| rd2-b2-l1-a   | 30 | 2843 | + generation/promotion prefetch, no codec change |
| rd2-base-l1-b | 55 | 3291 | |

## CPU profiles of the lull windows (8 windows each)

| | window total | idle | non-idle CPU | top self costs |
|---|---|---|---|---|
| rd2-prof-base | 14915 ms | 3758 | 11157 | (program) 2062, writeValue 746, GC 668, #pump 484, decodeUtf8Range 246, loadBrowserBoundedReadRequest 191, decodeCollection 181, finishSorted 174 |
| rd2-prof-b2   | 16906 ms | 5545 | 11361 | (program) 1918, GC 1000, writeValue 668, #pump 411, finishSorted 230, decodeUtf8Range 213, encodeInternal 199 |

The IDB pipelining (b2) cut request count and the bounded-read loader cost, but non-idle CPU per
lull did not drop; canonical codec self time is ~27% of lull CPU (dist codec 2692 ms + src 373 ms
in b2). The codec change (b3) is microbenchmarked only: object-heavy encode −25…−30%, identical
bytes; no profiled b3 run was taken.
