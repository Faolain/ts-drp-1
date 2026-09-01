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

Run the one-object diagnostic exactly once after focused/static gates pass.
Authenticate the profile PID, executable, built-module hashes, result schema,
exact operation/vertex/lifecycle counts, normal exit, phase timeline, and CPU
profile hash. Determine the dominant JavaScript owner conservatively:

- if a tests-only owner is clearly dominant, implement only that narrow
  optimization and rerun focused gates plus one corrected two-object preflight;
- if a product owner is clearly dominant, stop and freeze a separate product
  optimization slice before editing it;
- if attribution remains mixed or unavailable, stop and report the feasibility
  blocker rather than changing workload or timing contracts.

The 64-object worker does not run in D.110a-t.

## Review and closure

Because this slice handles timing feasibility adjacent to a scarce consuming
run, its signed/pushed plan receives one Grok 4.6/high, standard direct Kimi CLI
K3 with `KIMI_LOOP_MAX_STEPS_PER_TURN=100`, and Opus xhigh review. Correct P0/P1
findings once; do not recursively review bookkeeping. Signed RED receives
deterministic local validation. After diagnostic GREEN, one final
Grok/Kimi/Opus review covers plan, RED, GREEN, attribution, scope, and the next
owner decision. Only P0/P1 blocks. If Grok cancels, resume the exact session.
Do not use Codex Sol for Kimi, Fable, or collaboration subagents.
