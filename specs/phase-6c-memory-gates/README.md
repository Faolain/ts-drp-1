# Phase 6c — Enforceable Memory Gates

## Next Agent Prompt

Status (2026-09-01): Phase 6b is closed at signed/pushed anchor
`955e72f4d1a6cd70d07639708712f58b0808bb17`. Its accepted 128-step durable
differential, complete proof-kind registry, exact durable censuses, one genuine
close/adopt/reclaim lifecycle, fresh-process proof, and immutable evidence are
the Phase-6c structure-census artifact. Do not reopen, duplicate, or wrap them
in a second census owner.

The D.110a causal RED is signed/pushed at
`b85875c3e0448b65a5d262cbc1ca7c38fdcb331a`. Its authoritative focused GREEN
passes 20/20. The two-object preflight then demonstrated that creator durable
replay requests one 979-row journal page even though the public journal
contract accepts at most 128 rows per page. The million-operation worker has
not run. Do not weaken or reinterpret D.110a.

D.110a-p is closed through signed/pushed GREEN anchor
`f03b97f6e3a06e7c1caae6aeb8bc3e0d2da33189` and its final review. The genuine
129-row close now pages against one readiness snapshot in chunks no larger than
128; focused GREEN passed 2/2 and the retained selection passed 95/95. Grok,
the standard direct Kimi CLI, and Opus all approved with an empty P0/P1 union.

The corrected D.110a path then exposed two tests-only infrastructure limits.
The inherited D.109d receipt helper read only the default 64-row issuance page;
bounded pagination closed that mismatch. Afterward the two-object preflight
completed one exact 15,625-operation lifecycle but hit its five-minute
diagnostic watchdog during the second. D.110a-t preserved one complete
one-object CPU profile, and D.110a-u repaired its tests-only clock-custody
defect without rerunning or weakening the workload. The accepted replacement
profile is valid but mixed: canonical is largest at 47.8533096832 percent,
below the unchanged 50-percent dominance threshold. No product defect has been
demonstrated. The two-object preflight and 64-object full worker remain
unspent.

D.110a-v is closed through signed/pushed evidence anchor
`5ce2e7957656b0092a1dbccbe1eaa492ee592279` and its final review. Its single
offline analysis conserved every sample and microsecond under all five clock
mappings. Every mapping selected `creator-close` at 85.93--85.94 percent, but
no owner met the unchanged dominance rule; canonical was largest at about
46.61 percent. The result is `stable-phase-mixed-owners`, not a demonstrated
product or memory defect. The serial 4.4875-hour 64-object value is a
projection, not a measured full run.

D.110a-w is implemented and its sole two-object preflight is consumed. That
preflight passed every semantic and accounting check with status zero but took
585.233 seconds, exceeding the frozen 540-second release predicate. The full
worker remains unspent. The next executable work is
[D.110a-x retained-heap preflight variance correction](slices/00f-preflight-variance-correction.md).
It prospectively raises only the tests-only full watchdog to seven hours and
the matching 80-percent-headroom release bound to 630 seconds. It reuses the
immutable successful preflight evidence without retry and preserves every
workload, memory, semantic, and measurement contract. No product defect has
been demonstrated. Before the sole full run it also closes the narrow failure-
forensics gap with parent-owned write-once identity, fsynced progress/raw-I/O
journals, explicit watchdog/exit status, and bounded synthetic fault tests;
partial evidence remains diagnostic only. Do not invoke Fable or collaboration
subagents.

The D.110a-x forensics GREEN is implemented: its one focused run passed 9/9,
the frozen retained suite passed 95/95, and all affected build-source/static
gates passed without creating the real full-run root. Signed evidence and the
final three-model GREEN review remain the execution gate for the sole
64-object run.

Global TODO:

- [x] Structure-census artifact inherited from D.109f and D.109d.
- [x] D.110a-p paginate creator durable replay across the public 128-row page seam.
- [x] D.110a-t/u produce and validate one exact one-object attribution profile.
- [x] D.110a-v disposition the full lifecycle without another capture.
- [x] D.110a-w correct the tests-only watchdog feasibility contract and record
      its consumed preflight result.
- [ ] D.110a-x correct the demonstrated preflight variance bound without retry.
- [ ] D.110a genuine million-operation retained-heap hard gate.
- [ ] D.110b CI memory-trend fail-closed backstop.

No Phase-6c RED, GREEN, workflow mutation, product change, or long workload is
authorized by this plan alone.

## Goal

Make retained-memory regressions block instead of merely producing a trend
report. The hard acceptance path combines the inherited exact owner censuses
with a fresh-process post-GC heap slope, an absolute heap ceiling, an exact
admitted-and-applied operation count, and an independently derived final
semantic digest.

## Audited starting point

The repository currently has three materially different memory surfaces:

1. `.github/workflows/benchmark-memory.yml` runs the object and node RSS
   benchmarks, compares them to cached history, and explicitly sets
   `fail-on-alert: false`. It is a reports-only trend and cannot be the hard
   Phase-6c gate.
2. `packages/object/tests/drpobject.memory.bench.ts` and
   `packages/node/tests/node.memory.bench.ts` report process `maxRSS` for small
   legacy/object or network workloads. They do not use `--expose-gc`, sample
   post-GC `heapUsed` per epoch, calculate a least-squares slope, assert an
   absolute budget, or pair memory with accepted-operation and final-digest
   checks.
3. Phase 6b already supplies the deterministic structure artifact: D.109f
   executes 128 same-object durable AHE maintenance steps, exact AHE/issuance
   censuses, and one sorted proof-kind registry; D.109d observes all 22
   installed-v3/creator-close runtime owners across one genuine close,
   adoption, durable pruning, and receipt-gated release.

Two roadmap phrases cannot be copied literally into a new test:

- Creator handoff activates the adopted successor as `genesis-active`, so it
  accepts the retained successor operation. The repository still exposes no
  second creator-close/adopt entry for that same object after epoch 1. The heap
  worker therefore uses 64 distinct object-epochs, each exercising the
  supported genuine epoch-0 to epoch-1 lifecycle once. It does not relabel them
  as 64 epochs of one object. The inherited 128-step same-object durable
  differential covers the long-lived durable-owner dimension.
- `HashGraph.vertices`, `forwardEdges`, private `vertexDistances`, and legacy
  `FinalityStore.states` belong to the legacy/general object plane. Phase 6b
  deliberately left that plane unchanged, and Phase 6d owns legacy-finality
  retention. Phase 6c retains those tests as controls but does not silently
  move Phase-6d product behavior into a local-safe memory-test slice.

## Frozen workload and thresholds

D.110a uses exactly 64 genuine object-epochs. Each object applies exactly
15,625 application operations: 976 maximum 16-operation batches plus one
9-operation batch, producing 977 workload batch vertices. Together with the
fixture's existing anchor and two setup vertices, that stays below both the
4,096-vertex close-set helper bound and the authenticated 8,192-vertex product
limit, and totals exactly 1,000,000 admitted and applied workload operations
without changing either limit.

The default Phase-6a latched-ACL artifact cannot accept a multi-operation
`issueLocal` call. D.110a therefore mints one opt-in tests-only catalog variant
whose artifact and manifest contain both `acl` and the already shipped
`applicationBatch` operation. The default artifact bytes, package bytes,
digests, and callers remain byte-for-byte unchanged. A generic tests-only
pre-close callback drives the batches; it does not add a product API.

Each object's reducer is a deterministic additive counter. The inherited setup
applies `add(1)` and `add(2)` before the workload, so the worker checks exact
pre-close state 15,628 and post-successor-`add(1)` state 15,629. An independent
aggregate digest covers ordered `(objectId, appliedWorkloadCount,
preCloseState, postSuccessorState)` tuples. Each object then follows the real
creator close, verified adoption, durable pruning, receipt-gated predecessor
release, and next-successor operation. The worker retains a rolling window of
exactly 20 active successors after warm-up, fully tears down the displaced
oldest fixture before each replacement sample, and closes the remaining window
only after the final accepted sample. A tests-only option may feed the
pre-close workload through
the existing genuine Phase-6a fixture; it may not bypass `issueLocal`, signing,
admission, journaling, blueprint folding, close, adoption, or reclamation.

The parent uses `workspacePackageImportHook` with asynchronous `spawn`, not the
synchronous subprocess convenience function. After affected package builds it
authenticates exact public export targets and the two built internal owners
that intentionally have no product export, then starts the `.mjs` bootstrap
with `--expose-gc`, the existing `tsx` loader, and `fake-indexeddb/auto`. The
bootstrap imports a tests-only TypeScript worker, so the genuine
IndexedDB-bound fixture runs in plain Node without Vite aliases. Internal built
URLs are supplied by the parent; the child does not derive production paths or
invent a second package resolver. Every value import on that path uses the same
built `v3-live` module instance. The Phase-6b fixture reuses the pure fake
network exported by the owned Phase-6a fixture instead of importing the
Phase-4b `vi.fn()` helper, so neither `vitest` nor a source `v3-live` copy enters
the measured process. The worker also installs the retained Phase-6a
`navigator.storage.estimate()` mock before browser-store construction.

The worker launches fresh Node with `--expose-gc` and samples the complete raw
`process.memoryUsage()` record during execution after each complete
object-epoch/window replacement, using three explicit GC + event-loop turns per
sample. It calculates ordinary least-squares slopes over the last 32 of 64
samples, when the rolling window already contains 20 active rooms, for
`heapUsed`, `arrayBuffers`, and `ownedBytes = heapUsed + arrayBuffers`.
`external` and `rss` remain diagnostic evidence. Each slope must be at most
165,161 bytes per object-epoch. Every `heapUsed` and `ownedBytes` sample must be
below the exact 512,000,000-byte ceiling carried from the governing Profile-D
`512 MB` contract. This keeps the original JS-heap contract and also prevents
retained `Uint8Array`/`Buffer` storage from escaping it. Across the 31 intervals
represented by the last 32 samples, epsilon permits at most 5,119,991 predicted
bytes, strictly below one percent of the absolute budget. All bounds must pass;
negative slope does not excuse an absolute-budget breach.

The first-pass approximate 100 MB statement is retained as historical
motivation, not silently converted into a binary-megabyte contract. D.110a
records the fresh-process baseline and every raw sample, but does not subtract
baseline from the absolute ceiling.

D.110a-w superseded the original 45-minute parent watchdog with a six-hour
local parent watchdog and the five-minute preflight timeout with 15 minutes.
Its single successful 585.233-second preflight then demonstrated that the
separate 540-second release predicate did not preserve its intended variance
margin. D.110a-x prospectively uses the smallest whole-hour watchdog that
retains 20-percent headroom over that immutable observation: seven hours, with
a matching 630-second two-object release bound. Timeout remains a consuming
failure, not permission to rerun or weaken the workload. D.110b must separately
review a runner whose limit exceeds seven hours plus setup and evidence upload;
it may not silently shorten D.110a to fit a hosted runner.

## Slice graph

1. [D.110a-p durable-replay pagination prerequisite](slices/00a-durable-replay-pagination.md)
   closes the newly demonstrated `rowCount > 128` creator-close defect without
   changing journal limits, close semantics, or Phase-6c workload contracts.
2. [D.110a-t workload feasibility attribution](slices/00b-workload-feasibility-attribution.md)
   identifies the exact CPU owner behind the impossible preflight throughput
   without changing the accepted workload or watchdog.
3. [D.110a-v whole-lifecycle profile disposition](slices/00d-whole-lifecycle-disposition.md)
   applies a deterministic five-mapping sensitivity analysis to the already
   durable D.110a-u artifact and selects branch 3, a creator-close phase-level
   feasibility slice, without another capture.
4. [D.110a-w watchdog feasibility correction](slices/00e-watchdog-feasibility-correction.md)
   raises only the tests-only preflight/full parent timers to evidence-backed
   15-minute/six-hour values under high-risk review.
5. [D.110a-x preflight variance correction](slices/00f-preflight-variance-correction.md)
   dispositions the one consumed semantic-pass/timing-release-fail preflight
   and prospectively raises only the tests-only full timer and release bound.
6. [D.110a retained-heap hard gate](slices/00-retained-heap-gate.md) adds the
   fresh-process worker, exact workload/digest assertions, slope arithmetic,
   hard limits, and mutation-sensitive focused test. Its own implementation
   remains tests/build infrastructure; it depends on D.110a-p.
7. D.110b runs the accepted D.110a hard command from CI and changes the existing
   benchmark comparison to `fail-on-alert: true` as a separate trend backstop.
   It reviews timeout, cadence, cache-absence, and failure-reporting behavior
   without changing D.110a's workload or thresholds. Historical trend cache is
   never the hard-gate oracle.

## Sacred contracts

- Phase-4c's signed `<2 x chunk-body` 64 MiB fresh-process snapshot proof is a
  separate peak-live-ownership contract and remains byte-for-byte retained.
- Memory success is invalid unless exactly 1,000,000 operations were admitted
  and applied and the final semantic digest matches the independent oracle.
- The inherited exact census and new heap measurements are complementary.
  Neither may substitute for the other.
- The worker samples throughout execution after each object-epoch/window
  replacement. A single measurement after process completion is not a slope
  proof.
- A test helper may extend an existing tests-only fixture option, but Phase 6c
  adds no product API, inspection API, production dependency, wire field,
  digest owner, activation authority, cleanup authority, or resource limit.
- The 64 genuine object-epochs and 128 same-object durable maintenance steps
  remain separately labeled. Neither is described as repeated same-object
  runtime close/adopt support.
- Legacy finality remains Phase-6d debt and stays unchanged.
- Heap ceilings, workload counts, sample windows, watchdogs, and CI behavior
  are high-risk acceptance contracts. Any correction that changes them receives
  the review required for that executable change.

## Review and evidence

Each unclosed slice follows one signed/pushed bounded plan review, deterministic
causal RED, narrow GREEN with focused/static/retained gates, and one final
Grok/Kimi/Opus review over the signed plan -> RED -> GREEN history. Only P0/P1
blocks. The standard local `kimi` binary is used directly for the Kimi slot,
with K3, high thinking, and `KIMI_LOOP_MAX_STEPS_PER_TURN=100`.

Evidence records exact commands and statuses, selected test/file counts,
complete result sets, all 64 raw samples, slope inputs and arithmetic, exact
workload and digest results, owner/source hashes, runtime identity, child
arguments, process and port predicates, protected untracked paths, all existing
stashes, signed commit identity, pushed-ref identity, and a validating
self-excluding manifest. No retained campaign is part of Phase 6c unless
separately planned, reviewed, and authorized.
