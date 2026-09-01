# D.110a — Genuine Retained-Heap Hard Gate

## Purpose and inherited anchor

D.110a inherits signed/pushed Phase-6b closure
`955e72f4d1a6cd70d07639708712f58b0808bb17`. D.109a-D.109f and their evidence
remain immutable. D.109f/D.109d already satisfy the deterministic structure-
census half of Phase 6c. This slice adds the missing genuine fresh-process heap
gate without changing product behavior or the existing trend workflow.

## Exact scope

RED and GREEN are confined to tests and test/build infrastructure under this
prospective owner set:

- `tests/fixtures/phase-6c/retained-heap-contract.ts`;
- `tests/fixtures/phase-6c/retained-heap-child.mjs`;
- `tests/phase-6c-retained-heap-red.test.ts`;
- the existing tests-only
  `tests/fixtures/phase-6a-v3/creator-adoption-contract.ts` for one bounded
  pre-close workload option; and
- the smallest root/package test-script entry needed to invoke exactly the
  hard gate.

Reuse `tests/fixtures/shared/workspace-package-subprocess.mjs` to resolve exact
freshly built workspace exports. Do not add a Vite alias, `NODE_PATH`, root
shim, source-relative production import, stale-dist assumption, or a second
subprocess resolver.

No production file or workflow is authorized. If the worker needs a
production-source change, public or internal product inspection API, changed
retention behavior, different workload/threshold, or another dependency, stop
and reslice before editing it.

## Frozen workload

Run exactly 64 ordered, distinct object-epochs. For each object:

1. create the genuine genesis-active installed-v3 fixture;
2. apply 15,625 deterministic `add(1)` operations through `issueLocal`, as 976
   batches of 16 and one batch of 9;
3. require every batch vertex to be genuinely issued, signed, admitted,
   journaled, indexed, applied by the blueprint reducer, and published;
4. assert exactly 15,625 applied workload operations and pre-close counter
   15,628, including the inherited setup's `add(1)` and `add(2)`;
5. execute genuine close, verification, adoption, durable AHE/issuance pruning,
   receipt-gated runtime reclamation, and one next-successor `add(1)`, yielding
   exact counter 15,629;
6. assert the independent ordered semantic digest; retain the successor in a
   rolling 20-room window, fully deactivate/close/release the displaced oldest
   fixture once the window is full, and collect the post-GC sample.

Across all objects, assert exactly 1,000,000 admitted and applied operations,
62,528 workload batch vertices, 64 successful close/adopt/reclaim lifecycles,
64 successful next-successor operations, and the independently frozen
aggregate digest. The fixed setup vertices are observed but are not counted as
workload vertices or workload operations. The object identifiers are
deterministic and distinct. No operation, vertex, object, or failed attempt may
count twice.

The sample records exactly `min(completedObjectEpochs, 20)` active successors;
the last 44 samples therefore contain exactly 20 open rooms. Close the final
20-room window only after recording and validating the terminal sample.

This is 64 genuine single-transition object-epochs, not 64 epochs of one
object. The inherited D.109f 128-step same-object durable differential remains
the long-lived durable-owner proof.

## Frozen measurement

The parent launches one fresh Node child with `--expose-gc` from freshly built
workspace exports. The child rejects absent `global.gc`. After each
object-epoch/window replacement, it performs exactly three `global.gc()` calls,
each followed by one event-loop turn, then records raw
`process.memoryUsage().heapUsed`.

The result contains exactly 64 samples. Ordinary least-squares uses sample
indices 32 through 63 inclusive, all with 20 active rooms, and their raw heap
bytes; it must not sort, trim, smooth, clamp, use endpoints only, or subtract a
fitted baseline. Require:

- slope `<= 165_161` bytes per object-epoch; and
- every raw sample, including the terminal sample, `< 512_000_000` bytes.

The epsilon limits predicted growth across the 31 last-half intervals to
5,119,991 bytes, strictly less than one percent of the Profile-D 512,000,000-
byte ceiling. Negative slope never excuses an absolute breach. Record the
initial pre-workload baseline separately for diagnosis only.

The worker also tracks its current object-epoch and applied-operation count at
every sample. This proves the samples were taken during execution, not
reconstructed from memory remaining after the complete workload.

The parent enforces one 45-minute watchdog over the full child. A timeout is a
consuming GREEN failure with complete stdout/stderr and the last completed
object-epoch retained as evidence; it is never interpreted as a heap verdict.

## Deterministic causal RED

RED adds the contract and focused test against the current memory runner and
test entry points. It executes lightweight arithmetic/mutant controls and fails
only the exact missing hard-gate assertions:

- `D110A_POST_GC_SLOPE_GATE_MISSING`;
- `D110A_PAIRED_WORKLOAD_GATE_MISSING`; and
- `D110A_HARD_ENTRYPOINT_MISSING`.

The RED must not start the million-operation workload, skip on readiness, fail
at module loading, or treat a faulty grep/regex as a product failure. It must
prove the current RSS benchmark and `fail-on-alert: false` trend workflow do
not already satisfy these hard-gate contracts.

The contract freezes lightweight validator mutants for missing GC, endpoint-
only slope, sorted samples, baseline subtraction, retained 1 MiB per epoch,
absolute-budget bypass, dropped operations, double-counted operations,
substituted digest, after-completion-only sampling, and a false repeated-same-
object claim. Every mutant must fail with its exact token in GREEN.

Any other failed assertion, top-level error, flaky result, timeout, or retained
test regression invalidates RED. Sign and push the causal RED evidence before
GREEN.

## Narrow GREEN and gates

GREEN adds the tests-only worker, contract validator, bounded fixture option,
and hard test entry point. It does not edit the existing benchmark workflow.

Run in order:

1. focused validator and source-shape GREEN once;
2. the genuine 64-object-epoch/1,000,000-operation fresh-process hard gate
   exactly once;
3. retained D.109f non-browser tests and the D.109d lifecycle tests;
4. retained Phase-6a close/adoption/activation tests affected by the fixture
   option;
5. the unchanged Phase-4c 64 MiB fresh-process memory child;
6. the Phase-0k legacy-finality and compact-history controls;
7. affected package builds and source typechecks;
8. exact-owner ESLint, Prettier, `git diff --check`, source-shape, result-key,
   selected-file/title, child-syntax, and workspace-resolution checks; and
9. protected-path, stash, process, port, signed-commit, pushed-ref, and
   evidence-manifest checks.

Do not repeatedly rerun the million-operation worker to tune the threshold. A
failed consuming GREEN run stops for evidence-based diagnosis. If product CPU,
fixture cost, scheduling variance, or an impossible watchdog dominates rather
than retained heap, preserve the result and reslice; do not weaken workload,
GC, sample count, limits, or semantics in place.

No browser matrix is added merely to repeat Node heap arithmetic. The retained
Phase-6b browser results remain inherited unless the tests-only fixture option
actually affects them.

## Completion and next boundary

D.110a closes only when the focused controls, one genuine long worker, retained
gates, and static/build checks pass; the signed GREEN is pushed; and the final
Grok/Kimi/Opus review confirms causal RED, genuine workload accounting,
correct slope arithmetic, threshold preservation, tests-only scope, and
retained behavior.

D.110b then wires the accepted hard command into CI and flips the historical
benchmark comparison to fail closed as a trend backstop. It may not change the
D.110a workload, thresholds, or result interpretation.
