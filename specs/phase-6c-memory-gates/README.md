# Phase 6c — Enforceable Memory Gates

## Next Agent Prompt

Status (2026-09-01): Phase 6b is closed at signed/pushed anchor
`955e72f4d1a6cd70d07639708712f58b0808bb17`. Its accepted 128-step durable
differential, exact durable censuses, one genuine close/adopt/reclaim lifecycle,
fresh-process proof, and immutable evidence remain inherited. Do not reopen or
duplicate them.

The next executable work is
[D.110a structure-census foundation](slices/00-structure-census.md). It is a
tests/build-infrastructure slice only. Its plan must be signed, pushed, and
reviewed by Grok 4.6/high, the standard Kimi CLI with K3/high and an exact
100-step cap, and Opus xhigh before RED. If Grok cancels, resume that exact
session. Do not substitute Codex Sol for Kimi. Do not invoke Fable or
collaboration subagents.

Global TODO:

- [ ] D.110a deterministic structure-census foundation.
- [ ] D.110b genuine long-horizon workload and exact heap-threshold freeze.
- [ ] D.110c fresh-process heap-slope hard gate and CI trend backstop.

No Phase-6c RED, GREEN, threshold, workflow mutation, product change, or long
workload is authorized by this source audit alone.

## Goal

Make retained-memory regressions block instead of merely producing a trend
report. The hard acceptance path must combine exact owner censuses with a
fresh-process post-GC heap slope, an absolute heap ceiling, an exact admitted
and applied operation count, and a final semantic digest.

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
3. Phase 6b now supplies genuine bounded-pruning evidence: D.109f executes 128
   same-object durable AHE maintenance steps and exact AHE/issuance censuses;
   D.109d observes all 22 installed-v3/creator-close runtime owners across one
   genuine close, adoption, durable pruning, and receipt-gated release.

Two roadmap phrases cannot be copied literally into a new test:

- The installed-v3 successor is currently `snapshot-closed`. The product does
  not expose a genuine repeated same-object close/adopt path after epoch 1.
  D.109f already proved and recorded this limitation. A 32-epoch or
  million-operation test must not fake repeated product lifecycle authority.
- `HashGraph.vertices`, `forwardEdges`, private `vertexDistances`, and legacy
  `FinalityStore.states` belong to the legacy/general object plane. Phase 6b
  deliberately left that plane unchanged, and Phase 6d owns legacy-finality
  retention. Phase 6c may retain those tests as controls, but may not silently
  move Phase-6d product behavior into a local-safe memory-test slice.

The historical first-pass plan mentioned approximately 100 MB after one
million lifetime vertices. The governing v2 plan promises at most 512 MB for
20 open Profile-D rooms and gives no numeric heap-slope epsilon. Therefore
neither an exact absolute budget nor epsilon is currently frozen. D.110a does
not invent either number.

## Slice graph

1. [D.110a structure-census foundation](slices/00-structure-census.md) adds one
   deterministic, mutation-sensitive tests-only census runner. It reuses the
   real D.109f 128-step durable path and the real D.109d one-transition runtime
   path, and reports exactly what each owner can genuinely observe. It changes
   no production source and closes no heap threshold.
2. D.110b freezes one honest workload topology, its exact admitted/applied
   operation count, final digest, epoch/object interpretation, sample window,
   absolute heap bytes, and slope epsilon. If satisfying the intended
   same-object lifetime claim requires repeatable successor close/adopt
   product behavior, stop and reslice that prerequisite under its product,
   identity, activation, and protocol risks before changing source.
3. D.110c implements the fresh Node `--expose-gc` worker, mutation controls,
   hard test entry point, and only then changes the existing benchmark workflow
   to `fail-on-alert: true` as a trend backstop. The hard deterministic test,
   not historical cache availability, owns acceptance.

## Sacred contracts

- Phase-4c's signed `<2 x chunk-body` 64 MiB fresh-process snapshot proof is a
  separate peak-live-ownership contract and remains byte-for-byte retained.
- Memory success is invalid unless the exact workload was admitted and applied
  and the final semantic digest matches an independent oracle.
- Exact census and heap measurements are complementary. Neither may substitute
  for the other.
- A test helper may observe an existing tests-only hook or private fixture, but
  Phase 6c adds no product API, inspection API, production dependency, wire
  field, digest owner, activation authority, or cleanup authority.
- The 128 durable steps and one genuine installed-v3 lifecycle must be labeled
  separately. Their results may not be summarized as 128 genuine runtime
  close/adopt cycles.
- Legacy finality remains Phase-6d debt. A Phase-6c control may prove it is
  unchanged; it may not delete or hide it.
- Heap ceilings, workload counts, epoch counts, sampling windows, watchdogs,
  and CI behavior are high-risk acceptance contracts. Any slice that freezes
  or changes them receives explicit plan and final implementation review.

## Review and evidence

Each unclosed slice follows one signed/pushed bounded plan review, deterministic
causal RED, narrow GREEN with focused/static/retained gates, and one final
Grok/Kimi/Opus review over the signed plan -> RED -> GREEN history. Only P0/P1
blocks. The standard local `kimi` binary is used directly for the Kimi slot,
with K3, high thinking, and `KIMI_LOOP_MAX_STEPS_PER_TURN=100`.

Evidence records exact commands and statuses, selected test/file counts,
complete result sets, owner/source hashes, runtime identity, child arguments,
process and port predicates, protected untracked paths, all existing stashes,
signed commit identity, pushed-ref identity, and a validating self-excluding
manifest. No retained campaign is part of Phase 6c unless separately planned,
reviewed, and authorized.
