# Bounded attribution completed; memory acceptance remains open

The corrected bounded capture and the subsequent unprofiled 64-writer,
100-transition diagnostic both passed. One growing **harness** retaining owner
was confirmed and removed. No product lifecycle leak was confirmed. Persisted
fake IndexedDB data accounts for most measured snapshot-graph growth, but the
remaining graph growth has not been fully attributed.

## Unprofiled verification

The [preserved original run](../d110c-grid-authority/grid100-diagnostic-terminal-lifecycle-repaired/summary.md)
is unchanged. The [new terminal status](grid100-assertion-released/status.json)
records natural exit zero, exact before/after source custody, no timeout, no
cleanup signals and no remaining processes. Wall time was 1,954,894.665208 ms
(32m35s), versus 1,553,910.940541 ms previously; this is not a performance pass.

All 100 genuine transitions, 6,464 contributions, 200 recovered sources, ten
creator restarts and final cold reopen passed. Final reopen preserved exact
world/authority and issued/published nothing twice. All 101 epoch samples match
the original world digests and correctness/retention counters. The
[machine comparison](grid100-assertion-released/comparison.json) specifies the
compared fields, evidence hashes and independently checked slope arithmetic;
[its script](compare-unprofiled100.mjs) is reproducible against preserved inputs.

| Post-GC process measurement              |     Original |    Corrected |
| ---------------------------------------- | -----------: | -----------: |
| Last-32 heap-used slope, bytes/sample    |   781,111.17 |   536,049.95 |
| Last-32 array-buffer slope, bytes/sample | 1,476,810.52 | 1,316,076.95 |
| Last-32 owned-byte slope, bytes/sample   | 2,257,921.69 | 1,852,126.90 |
| Peak owned bytes                         |  354,150,122 |  313,756,507 |
| Final owned bytes                        |  351,417,433 |  311,060,658 |
| Peak RSS, separate process envelope      |  979,697,664 |  924,975,104 |

Owned bytes means heap used plus array buffers. Array buffers are already part
of external memory: external is recorded separately, never added again. The
owned-byte slope decreased 17.97%, but remains **11.21 times** the 165,161-byte
reference. The 512,000,000-byte reference ceiling was not crossed. Neither this
nor successful correctness assertions is memory acceptance.

The workload/seed/lifecycle assertions and heap settings were preserved. The
shared per-epoch frame and bounded diagnostic lookup also changed since the
original100; the numeric improvement must not all be assigned to one fix.
Identical observed digests/counters do not claim byte-identical DAG scheduling.
No census, snapshot capture or preparation observer ran in the final100.

## Confirmed retaining owner and causal correction

The original snapshot's strong chain was:

`global.__vitest_worker__.current.onFinished[] → callback context → promise →
assertion proxy/flags → TypeError → lazy CallSiteInfo → publishAccepted closure
→ room context → inputWithoutRebase.onProjection → projection cell.owner`.

The test-end registry held already-checked expected-rejection assertions until
the whole test ended, retaining retired room contexts across transitions.
This is a harness lifetime mismatch, not evidence that product close failed.
The assertion now reduces the promise to a boolean in a short-lived helper and
asserts that scalar synchronously; it still fails if publication unexpectedly
resolves. The installed-Vitest positive control proves the old callback growth,
and separate RED/GREEN ownership regressions cover the new helper and rejection
semantics. No framework internals are cleared and no product cleanup is invented.

The [original strong paths](capture30-startup-settled/analysis/strong-owners.json)
and [paired GREEN analysis](capture30-assertion-released/analysis/summary.json)
retain constructor counts, shallow sizes, dominator partitions and root proofs.
At transitions 10/20/30, total real rooms/registrations changed from
137/147/157 to a flat 128: 64 current plus 64 bounded original fixture roots.
Vitest onFinished callbacks changed from 10/20/30 to absent at every boundary.
FDBDatabase constructors stay at 390; CausalityIndex and MessageQueueManager
stay at 128. The original fixture roots remain explicit bounded overhead.
Weak edges and ephemeron-pair shortcuts are excluded from independent old-owner
strong-path proofs; current weak-map associations require independently rooted
handles and tables. Retained sizes of overlapping owners are not summed.

## Persisted data and residual growth

Snapshots were captured in actual workload worker PID 90906, after startup
recovery settled and GC, at transitions 10/20/30. SHA hashes, source/worker
identity and scalar memory/census telemetry are preserved in the
[capture summary](capture30-assertion-released/analysis/telemetry-summary.json).
The capture completed terminal accounting and final cold reopen. Its timing and
process counters are profiling diagnostics, not substitutes for final100.

The database root is `global.indexedDB → FDBFactory._databases → current raw
Database → rawObjectStores → records/indexes`. Membership/backlink checks cover
257 physical databases, 1,097 stores and 2,194 disjoint record/index anchors.
Current-database dominator partitions grow from 26,416,411 to 63,688,898 bytes
between transitions 10 and 30. This is actual heap-graph ownership, not serialized
payload subtraction. Paired partitions match exactly at 10/20 and differ by only
528 bytes at 30, in the creator quarantine scope index.

Across those GREEN snapshots, total graph growth is 39,023,195 bytes, of which
37,272,487 is growth in the current-database partition. **1,750,708 bytes of
graph growth outside that partition remains unattributed.** This is not a
corrected process slope or a product-only memory figure. Code/JIT/runtime growth
is a possible contributor, not a demonstrated allocation cause.

Within the alternative disjoint record/index partition, quarantine retained
bytes grow 12,814,352 → 38,336,592; live-journal bytes grow
5,489,320 → 14,471,146. These are overlapping alternatives to the broader raw
database partition and must not be added to it. The census independently labels
quarantine rows verified/unexpired and journal rows by epoch/status. The
quarantine retention hypothesis is thus supported by stored rows and rooted
heap objects; it is not an explanation assigned to all growth. No retention
policy changed. Total logical payload bytes grow 18,027,446 → 46,446,982 and
remain explicitly separate from retained heap.

Current-runtime and fixture owner summaries include sessions, registrations,
ingress, latches, caches and observer containers. Queue-manager constructor
counts are bounded in snapshots, but exact queue depth is not exposed by the
scalar runtime census; gate presence is not queue depth.

## Verification, review and historical failures

Evidence is retained under [capture review dispositions](capture-review-dispositions.json),
[startup review dispositions](startup-review-dispositions.json), and
[assertion review dispositions](assertion-review-dispositions.json). Sol, Fable
and Grok reviewed meaningful checkpoints. Final assertion Grok review used 100
turns; the final phase-aware guard correction then received a focused Sol pass,
not another full Grok/Fable review. Focused regression/integration checks,
whole-program types, lint (zero errors; existing documentation warnings) and
format passed before final capture and unprofiled verification.

Preserved failures include the snapshot stream completion smoke, census before
startup settlement, the first three-snapshot run's terminal fence guard, initial
terminal-regression setup failures, and exhausted/failed review attempts. The
phase-aware correction always joins startup and preserves general runtime
assertions; only the invalid post-reopen fence cardinality is inapplicable during
final accounting. The genuine causal RED uses ordinary creator issuance to
produce a legal additional join control; GREEN still rejects missing runtime
catalogs. Historical failures have not been relabeled as successful runs.

## One next action

Attribute the remaining 1,750,708-byte non-database graph-growth delta using the
preserved paired snapshots and dominator/constructor evidence, before authorizing
another cleanup or workload campaign. A new targeted allocation capture is a
follow-up only if the existing snapshots cannot establish its owner. Do not
change the memory reference, retention policy or heap limit to close this gap.
