# D.110a-w — Retained-Heap Watchdog Feasibility Correction

## Demonstrated problem and disposition

D.110a-v closed at signed/pushed commit
`4ffa5429655ca2cde82ae4df55e479b5990003a0`. Its immutable one-object
profile measured 252.422167 seconds and 255 seconds of wall time. Every one of
five clock mappings assigned at least 216.913833 seconds to the genuine
`creator-close` interval, but no leaf-self owner met the unchanged
at-least-50-percent and at-least-two-times dominance rule.

The existing 2,700-second full watchdog permits at most 42.1875 seconds per
object across 64 objects even if every other phase were free. Meeting it would
therefore require more than a 5.14-times improvement in the mixed-owner
creator-close phase alone and about a 5.98-times improvement over the complete
measured lifecycle. A narrow product optimization cannot be selected from this
evidence. Opening a broad multi-package optimization investigation merely to
make a memory test fit its timer is not justified.

D.110a-w is the high-risk timing-contract correction selected by D.110a-v. It
changes only the parent-owned test watchdogs:

- preflight: 300,000 ms to 900,000 ms; and
- full worker: 2,700,000 ms to 21,600,000 ms.

Six hours preserves 20 percent headroom over both projections: 80 percent of
six hours is 17,280 seconds, while the profile-duration projection is
16,155.018688 seconds and the measured-wall projection is 16,320 seconds.
Fifteen minutes gives the two-object preflight ample room over its 510-second
measured-wall projection and matches the already accepted profile-mode outer
timeout.

This is a scheduling feasibility correction, not a product defect finding and
not a relaxation of any memory or semantic requirement.

## Exact scope

The only executable owners are:

- `tests/fixtures/phase-6c/retained-heap-contract.ts`;
- `tests/fixtures/phase-6c/retained-heap-child.mjs`; and
- `tests/phase-6c-retained-heap-red.test.ts`.

Planning and evidence may additionally update this specification,
`specs/phase-6c-memory-gates/README.md`, and
`specs/phase-6c-memory-gates/slices/00-retained-heap-gate.md`, and
`docs/production-hardening/production-hardening-tdd-plan-v2.md`, and create new
D.110a-w evidence roots under `.logs/`.

No product source, package manifest, lockfile, dependency, workflow, public or
internal product API, wire format, digest owner, activation authority,
retention behavior, memory ceiling, slope ceiling, workload count, vertex
count, object count, active-room window, OLS window, GC turn count, result
schema, semantic digest, browser configuration, or profile timeout may change.
If any such change appears necessary, stop and reslice.

## Deterministic RED

Add tests-only exported constants `D110A_PREFLIGHT_TIMEOUT_MS = 900_000` and
`D110A_FULL_TIMEOUT_MS = 21_600_000`, plus the exact token
`D110AW_TIMEOUT_FEASIBILITY_MISSING`. Extend the source-shape audit and focused
test so the current child fails only that token while it still owns the stale
300,000/2,700,000-ms branches. The RED must prove all pre-existing focused
assertions still pass and must not start a child, profiler, preflight, or full
worker.

As part of RED, migrate timeout-shape ownership out of the existing
`hardEntrypoint` predicate and into the new watchdog-feasibility predicate.
`hardEntrypoint` continues to validate the unchanged root command and child
entry point without requiring the superseded `45 * 60 * 1000` literal. The new
predicate alone requires the child to use `D110A_PREFLIGHT_TIMEOUT_MS` and
`D110A_FULL_TIMEOUT_MS` while retaining the literal `900_000` profile branch.
Consequently RED has one cause and the later child edit is the sole remaining
GREEN flip; no decoy 45-minute literal is permitted.

Run the focused test exactly once. Its complete result must contain exactly
one expected failure with `D110AW_TIMEOUT_FEASIBILITY_MISSING`, no other failed
or soft-failed assertion, no top-level error, and no selected test/file drift.
Record, manifest, sign, and push RED before GREEN.

## Narrow GREEN

Make `retained-heap-child.mjs` import and use the two tests-only timeout
constants in its existing parent timer expression. Keep profile mode exactly
900,000 ms, including the literal `900_000` token in the profile branch. The
GREEN source-shape check must require the two imported constant names and must
not restore or accept the old 45-minute expression. Do not add retries,
progress-resetting timers, adaptive deadlines, per-object timeouts, signal
changes, or a second watchdog owner.

Run the focused test exactly once after the edit. Then run the affected package
build/source typechecks, exact-owner ESLint, Prettier, child syntax, source-
shape, selected-title/file, `git diff --check`, retained 95-test Phase-6a/6b/
6c selection, protected-path, 26-stash, process, port, signed-commit,
pushed-ref, and self-excluding manifest checks. Sign and push GREEN before the
single final Grok/Kimi/Opus review. Because the timing contract is high risk,
the review must verify the arithmetic, scope, parent timer ownership, exact
unchanged workload/memory contracts, causal RED-to-GREEN closure, and the
execution release. Only P0/P1 findings block; at most one correction
confirmation is allowed if executable timing or scope changes.

## Reserved executions after GREEN review

The final review's empty P0/P1 union releases the already reserved executions
in this order:

1. run the genuine two-object preflight exactly once from the reviewed,
   signed/pushed GREEN using a fresh write-once
   `.logs/phase-6c-d110aw-preflight/` root;
2. require normal exit, exact two-object/two-lifecycle accounting, complete
   stdout/stderr/status/runtime identity, no memory verdict, and a validating
   self-excluding manifest; then
3. run the sole genuine 64-object full worker exactly once using a fresh
   write-once `.logs/phase-6c-d110a-full/` root.

Do not retry either execution. A preflight failure stops before the full
worker. A full-worker timeout or any other failure is consuming and stops with
complete evidence; it never authorizes another timeout, workload, threshold,
or product change. No long retained campaign is part of this slice.

On a full pass, retain all 64 during-execution samples, exact million-operation
accounting, semantic digest, three OLS slopes, absolute maxima, runtime
identity, child I/O, timestamps, command statuses, hashes, and a validating
self-excluding manifest. Then complete the remaining retained/static gates and
the single final D.110a evidence review before D.110b.

The six-hour D.110a watchdog is local-only until D.110b separately reviews CI
runner feasibility. GitHub-hosted jobs currently have a six-hour execution
limit, which cannot contain a six-hour child plus checkout, build, setup,
classification, and evidence upload. D.110b must therefore select a runner
whose job limit exceeds the complete outer budget, such as an explicitly
provisioned self-hosted runner, and validate its failure/reporting behavior; it
must not shorten the accepted child watchdog to fit a hosted runner. D.110a-w
does not edit or authorize a workflow or runner.
