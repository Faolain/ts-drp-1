# D.110a-x — Retained-Heap Preflight Variance Correction

## Demonstrated problem and conservative interpretation

D.110a-w's sole two-object preflight ran once from signed/pushed source
`fdc75dcc2ac689a04ecd12d0acd90e2d8de78dd4`. It exited zero after 585,233 ms
with exact two-object/two-lifecycle accounting, 31,250 applied operations, two
during-execution memory samples, complete built-package runtime identity, and
empty stderr. It emitted no memory verdict. The deterministic audit classified
the result `SEMANTIC_PASS_TIMING_RELEASE_FAIL`: every semantic predicate passed
and only the reviewed at-most-540,000-ms release predicate failed, by 45,233
ms. The write-once preflight name is consumed and must not be retried.

This does not demonstrate a product or retained-memory defect. It demonstrates
that the six-hour full watchdog's 20-percent-headroom release test was too
tight for the observed scheduling/runtime cost. Linear projection of the
complete observed wrapper time is `585.233 / 2 * 64 = 18,727.456` seconds.
Preserving the rule that this projection occupy no more than 80 percent of the
full watchdog requires at least 23,409.32 seconds. The smallest whole-hour
watchdog satisfying that evidence is seven hours (25,200,000 ms); its matching
two-object release bound is 630,000 ms because `630 * 32 = 20,160` seconds,
exactly 80 percent of seven hours. The observed preflight is 44,767 ms inside
that bound, while the full watchdog retains 6,472.544 seconds above the linear
projection.

D.110a-x is a high-risk tests-only timing-contract correction. It does not
claim linear scaling as a measured full result, and it does not weaken any
workload, memory, semantic, sample, or evidence requirement.

## Exact scope

The only executable owners are:

- `tests/fixtures/phase-6c/retained-heap-contract.ts`; and
- `tests/phase-6c-retained-heap-red.test.ts`.

The child remains unchanged and continues to consume the single parent-owned
`D110A_FULL_TIMEOUT_MS` constant. Planning/evidence may additionally add this
specification and update `specs/phase-6c-memory-gates/README.md`, the earlier
D.110a slice documents, and
`docs/production-hardening/production-hardening-tdd-plan-v2.md`.

No product source, package manifest, lockfile, dependency, workflow, child
launcher, retry behavior, profile timeout, preflight child timeout, workload,
object/vertex/operation count, GC turn, sample window, result schema, memory
ceiling, slope ceiling, semantic digest, runtime identity, or D.110b runner
choice may change. If any such change appears necessary, stop and reslice.

## Deterministic RED

Add the tests-only constant
`D110A_PREFLIGHT_RELEASE_MAX_MS = 630_000`, the exact token
`D110AX_PREFLIGHT_VARIANCE_MISSING`, and an isolated `preflightVariance` audit
predicate requiring the existing full-timeout owner to equal 25,200,000 ms and
the release bound to equal 630,000 ms. Keep the active full timeout at
21,600,000 ms during RED, so every inherited assertion remains green and only
the new exact token fails. The RED must not start a child, profiler, preflight,
or full worker.

Run the focused test exactly once with coverage disabled. Require exactly one
selected file, the frozen assertion count plus one new assertion, exactly one
failure containing the complete new token, no other failure or soft failure,
and no top-level error. Validate source shape, changed paths, protected paths,
26 stashes, relevant processes, fixed ports, and a self-excluding manifest;
then sign and push RED.

## Narrow GREEN

Change only `D110A_FULL_TIMEOUT_MS` from 21,600,000 to 25,200,000 and update
the inherited focused arithmetic expectation from six to seven hours. The
existing child import makes that one constant the sole executable timer change.
Do not edit the child or add a second timer owner.

Run the focused test exactly once, then the affected package build/source
typechecks, exact-owner ESLint and Prettier, child syntax, source-shape,
selected-title/file, `git diff --check`, retained 95-test Phase-6a/6b/6c
selection, protected-path, stash, process, port, signed-commit, pushed-ref, and
self-excluding-manifest gates. Sign and push GREEN before the single final
Grok, standard direct Kimi K3/100-step, and Opus xhigh review. Because this is
a timing/resource-contract change next to a scarce run, the plan and final
GREEN each receive the normal high-risk three-model review; only P0/P1 blocks.
No Fable or collaboration subagent is authorized.

## Reserved execution after final review

The completed D.110a-w preflight is immutable input, not a rerunnable gate.
After an empty final-review P0/P1 union, revalidate its parent/audit/manifest
hashes and require its exact semantic pass plus `585,233 <= 630,000`. Also
require the full evidence root to remain absent, signed source and pushed ref
to match, `NODE_OPTIONS` to be unset, protected paths and all 26 stashes to be
present, no relevant process to be active, and ports 4174, 4175, 51000, and
51002 to be clear.

Those checks release the sole 64-object full worker once under fresh write-once
root `.logs/phase-6c-d110a-full/`. It retains the exact 64 samples, 1,000,000
operations, 62,528 batch vertices, semantic digest, three at-most-165,161-byte
OLS slopes, 512,000,000-byte absolute ceiling, runtime identity, timestamps,
stdout/stderr/status, first-failure stop, hashes, and self-excluding manifest.
A timeout or any other failure consumes the invocation and stops. No retry,
substitution, adaptive deadline, threshold change, or additional profile is
authorized.

The seven-hour child remains local-only through D.110a. D.110b must separately
select and prove an outer CI runner budget greater than seven hours plus setup
and evidence upload; no current hosted-runner assumption is inherited.
