# Phase 6c — Enforceable Memory Gates

## Next Agent Prompt

Status (2026-09-01): Phase 6b is closed at signed/pushed anchor
`955e72f4d1a6cd70d07639708712f58b0808bb17`. Its accepted 128-step durable
differential, complete proof-kind registry, exact durable censuses, one genuine
close/adopt/reclaim lifecycle, fresh-process proof, and immutable evidence are
the Phase-6c structure-census artifact. Do not reopen, duplicate, or wrap them
in a second census owner.

The next executable work is
[D.110a retained-heap hard gate](slices/00-retained-heap-gate.md). It is a
tests/build-infrastructure slice only. Its corrected plan must be signed,
pushed, and reviewed by Grok 4.6/high, the standard Kimi CLI with K3/high and
an exact 100-step cap, and Opus xhigh before RED. If Grok cancels, resume that
exact session. Do not substitute Codex Sol for Kimi. Do not invoke Fable or
collaboration subagents.

Global TODO:

- [x] Structure-census artifact inherited from D.109f and D.109d.
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

- The installed-v3 successor is currently `snapshot-closed`. The product does
  not expose a genuine repeated same-object close/adopt path after epoch 1.
  D.109f already proved and recorded this limitation. The heap worker therefore
  uses 64 distinct object-epochs, each exercising the supported genuine epoch-0
  to epoch-1 lifecycle once. It does not relabel them as 64 epochs of one
  object. The inherited 128-step same-object durable differential covers the
  long-lived durable-owner dimension.
- `HashGraph.vertices`, `forwardEdges`, private `vertexDistances`, and legacy
  `FinalityStore.states` belong to the legacy/general object plane. Phase 6b
  deliberately left that plane unchanged, and Phase 6d owns legacy-finality
  retention. Phase 6c retains those tests as controls but does not silently
  move Phase-6d product behavior into a local-safe memory-test slice.

## Frozen workload and thresholds

D.110a uses exactly 64 genuine object-epochs. Each object applies exactly
15,625 application operations: 976 maximum 16-operation batches plus one
9-operation batch, producing 977 workload batch vertices. Together with the
fixture's existing anchor and two setup vertices, that stays below the existing
4,096-vertex fixture ceiling and totals exactly 1,000,000 admitted and applied
workload operations without changing product limits.

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

The worker launches fresh Node with `--expose-gc` and samples `heapUsed` during
execution after each complete object-epoch/window replacement, using three
explicit GC + event-loop turns per sample. It calculates ordinary least-squares
slope over the last 32 of 64 samples, when the rolling window already contains
20 active rooms. The exact absolute ceiling is 512,000,000 bytes,
carried from the governing Profile-D `512 MB` heap contract. The exact slope
epsilon is 165,161 bytes per object-epoch: across the 31 intervals represented
by the last 32 samples, that permits at most 5,119,991 predicted bytes, strictly
below one percent of the absolute budget. Both bounds must pass; negative slope
does not excuse an absolute-budget breach.

The first-pass approximate 100 MB statement is retained as historical
motivation, not silently converted into a binary-megabyte contract. D.110a
records the fresh-process baseline and every raw sample, but does not subtract
baseline from the absolute ceiling.

The single full worker has a hard 45-minute parent watchdog, matching the
existing longest retained object-memory gate. Timeout is a consuming failure,
not permission to rerun or weaken the workload. D.110b must give its CI job
enough outer time to preserve that child watchdog plus setup and evidence
upload; it may not silently shorten the D.110a contract.

## Slice graph

1. [D.110a retained-heap hard gate](slices/00-retained-heap-gate.md) adds the
   fresh-process worker, exact workload/digest assertions, slope arithmetic,
   hard limits, and mutation-sensitive focused test. It changes no production
   source or existing benchmark workflow.
2. D.110b runs the accepted D.110a hard command from CI and changes the existing
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
