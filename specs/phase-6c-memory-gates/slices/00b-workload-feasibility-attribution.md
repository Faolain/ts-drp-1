# D.110a-t — Workload Feasibility Attribution

## Concrete blocker

D.110a-p repaired the only demonstrated product correctness defect. The next
fresh two-object preflight reached genuine close, adoption, pruning,
reclamation, successor issue, and sampling for its first exact object, then the
unchanged five-minute diagnostic watchdog killed the second object. The last
progress record proves 15,625 admitted/applied workload operations and one
successful lifecycle; no memory threshold ran or failed.

The D.109d receipt fixture also exposed a bounded-page assumption at 979 rows.
Its tests-only correction reads exact 128-row pages through the final issuance
boundary, validates contiguous author sequence and cursor progress, and marks
and re-reads every row. It changes no product source or store limit.

A 55-second macOS Time Profiler capture attached to the exact worker PID while
the first object ran. It recorded 60,282 running samples with about 115 percent
CPU observed separately. Top-frame classification was 28.37 percent typed-
array/allocation work, 18.13 percent unnamed JIT JavaScript, 9.65 percent GC,
7.12 percent BigInt arithmetic, 6.13 percent string/codec work, and only 1.84
percent SQLite/I/O. This is CPU-active genuine-workload cost, not a wedged or
idle fixture. A follow-up inherited `NODE_OPTIONS=--cpu-prof` attempt produced
only the parent and loader-thread profiles because SIGKILL prevented the child
from flushing its profile; it is an invalid owner-attribution diagnostic.

At the observed completed-object throughput, spending the sole 64-object run
would predictably collide with the frozen 45-minute watchdog. D.110a-t closes
that feasibility blocker before the consuming worker.

## Scope

D.110a-t may change only:

- `tests/fixtures/phase-6b/runtime-reclamation-contract.ts` for the already
  demonstrated bounded issuance-outbox pagination;
- `tests/fixtures/phase-6c/retained-heap-worker.ts` for phase progress and one
  exact one-object diagnostic result;
- `tests/fixtures/phase-6c/retained-heap-child.mjs` for a diagnostic-only parent
  and child mode that exits normally and preserves the exact package hook;
- `tests/fixtures/phase-6c/retained-heap-contract.ts` and
  `tests/phase-6c-retained-heap-red.test.ts` for deterministic source/result
  validation; and
- the root test entry only if a named diagnostic command is necessary.

Before D.110a-t RED, land one separately labelled signed/pushed pre-RED
baseline commit for the already parked D.110a GREEN scaffold and the
demonstrated D.109d helper correction. Its exact tracked roster is:

- `package.json`;
- `tests/fixtures/phase-3a1b-p3/live-fixture.ts`;
- `tests/fixtures/phase-6a-v3/creator-adoption-contract.ts`;
- `tests/fixtures/phase-6a-v3/creator-successor-activation-contract.ts`;
- `tests/fixtures/phase-6a-v3/creator-successor-handle-identity-contract.ts`;
- `tests/fixtures/phase-6a-v3/creator-successor-oracle.ts`;
- `tests/fixtures/phase-6b/runtime-reclamation-contract.ts`;
- `tests/fixtures/phase-6c/retained-heap-contract.ts`;
- `tests/fixtures/phase-6c/retained-heap-child.mjs`;
- `tests/fixtures/phase-6c/retained-heap-worker.ts`; and
- `tests/phase-6c-retained-heap-red.test.ts`.

That baseline preserves the already accepted D.110a 20-case focused GREEN and
records the later D.109d bounded-page correction, but it does not close D.110a,
run the scarce worker, or contain D.110a-t profile behavior. No other parked or
protected path may enter it. D.110a-t RED then changes only
`retained-heap-contract.ts` and the existing focused test, so a clean checkout
audits the same signed launcher bytes as the working tree. The activation/
identity/oracle split is inherited tests-only import-graph plumbing: it keeps
one pure oracle owner and prevents the fresh child from loading the broader
TypeScript source-audit fixture graph.

No product source, dependency, package export, Vite alias, wire format, digest
owner, activation authority, store implementation, application operation,
workload count, vertex count, object count, sample window, slope, memory
ceiling, GC turn, 45-minute full-worker watchdog, or full-worker invocation
authority may change.

## RED and diagnostic GREEN

RED adds desired-state assertions to the existing focused D.110a test without
changing its selected file or title count. It proves the current launcher has
no graceful one-object profile mode, no exact phase-progress schema, and no
child-profile identity/result custody. RED must not run an object workload.

GREEN adds a `profile` mode that reuses the same `buildObjectEpoch`, exact
15,625-operation/977-batch-vertex workload, genuine stores, package hook,
close/adopt/prune/reclaim/successor path, three GC turns, and teardown as the
preflight/full modes. It runs exactly one object, emits no slope, ceiling, or
memory verdict, and exits normally under a diagnostic-only outer timeout long
enough to flush the child profile. Progress timestamps cover fixture open,
workload completion, close, receipt/reclamation, successor publication,
sampling, and teardown. They are monotonic diagnostics and do not become
performance thresholds.

Profile capture uses a `node:inspector` `Profiler` session connected inside
the profile-mode child main thread, never inherited parent `NODE_OPTIONS`.
The child writes exactly one named profile with exclusive creation into a
parent-created fresh empty directory and stops the session before normal exit.
The fixed profile-mode outer timeout is 900,000 ms and is emitted in the parent
result; the existing 300,000 ms preflight and 2,700,000 ms full-worker values
remain byte-for-byte unchanged. A signal, exception, missing profile, extra
profile file, or nonzero exit is invalid evidence and stops the slice without
an implicit retry.

Run the one-object diagnostic exactly once after focused/static gates pass.
Authenticate the profile PID, executable, built-module hashes, result schema,
exact operation/vertex/lifecycle counts, normal exit, phase timeline, and CPU
profile hash. The profile must contain main-thread
`retained-heap-worker.ts` frames whose sampled interval overlaps the recorded
workload phase; parent-only, loader-only, sibling-thread, stale `CPU.*`, and
duration-inconsistent artifacts are rejected. Determine the dominant
JavaScript owner conservatively from self time inside that workload-phase
window. One owner group is clearly dominant only when it accounts for at least
50 percent of attributed self time and at least twice the next owner group;
anything weaker is mixed or unavailable.

- if a tests-only owner within the D.110a-t file roster is clearly dominant,
  implement only that narrow optimization and rerun focused gates plus one
  corrected two-object preflight; a tests-only owner outside that roster stops
  for a separately frozen follow-up;
- if a product owner is clearly dominant, stop and freeze a separate product
  optimization slice before editing it;
- if attribution remains mixed or unavailable, stop and report the feasibility
  blocker rather than changing workload or timing contracts.

The 64-object worker does not run in D.110a-t.

The corrected two-object preflight is only a readiness diagnostic. D.110a-w
prospectively supersedes the timer but preserves this 80-percent release rule:
the complete wrapper elapsed time for two objects must be at most 540 seconds,
which projects to at most 17,280 seconds across 64 objects and reserves 20
percent of the reviewed six-hour watchdog. Otherwise D.110a remains paused
even if the preflight exits zero. This is an invocation-safety predicate, not a
new product or memory-performance contract.

D.110a-w's sole later preflight exited zero with exact semantics at 585.233
seconds, so it correctly stopped under that predicate. D.110a-x prospectively
owns the resulting variance correction; this historical slice neither retries
nor reinterprets the consumed invocation.

## Review and closure

Because this slice handles timing feasibility adjacent to a scarce consuming
run, its signed/pushed plan receives one Grok 4.6/high, standard direct Kimi CLI
K3 with `KIMI_LOOP_MAX_STEPS_PER_TURN=100`, and Opus xhigh review. Correct P0/P1
findings once; do not recursively review bookkeeping. Signed RED receives
deterministic local validation. After diagnostic GREEN, one final
Grok/Kimi/Opus review covers plan, RED, GREEN, attribution, scope, and the next
owner decision. Only P0/P1 blocks. If Grok cancels, resume the exact session.
Do not use Codex Sol for Kimi, Fable, or collaboration subagents.

## Initial plan-review disposition

The signed plan anchor `fe675ce20d04b5130e24ce5e809a11dc78dd4527`
received the one bounded Grok 4.6/high, standard direct Kimi K3/100-step, and
Opus xhigh review. All three accepted the conservative full-worker hold, exact
one-object lifecycle, no-memory-verdict rule, and D.109d page arithmetic. The
blocking union was the missing signed baseline custody and insufficient
main-thread profile discrimination. This corrected text closes both once by
freezing the exact pre-RED baseline roster and in-child inspector capture.

The nonblocking findings are also dispositioned here: the 900,000 ms diagnostic
timeout is fixed and recorded; dominance has a prospective numeric rule; the
two-object resume projection reserves 20 percent of the unchanged full-worker
watchdog; the shared D.109d file receives the retained 95-case gate at final
GREEN; and an owner outside the closed tests-only roster requires a new slice.
No confirmation round, workload run, product edit, threshold edit, Fable, or
collaboration subagent is authorized by this correction.
