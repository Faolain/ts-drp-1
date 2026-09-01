# D.110a-u — Profile Clock Calibration

## Demonstrated blocker

The sole D.110a-t one-object profile completed the exact lifecycle, emitted the
seven ordered progress records, stopped the in-child inspector, and wrote one
exclusive CPU profile. The parent then rejected that otherwise complete
capture with `D110AT_PROFILE_WINDOW_INVALID` because it compared V8 profiler
timestamps directly with `process.hrtime` timestamps. On this macOS host those
clocks have different absolute origins. The error is tests-only attribution
infrastructure, not a product, workload, memory, or semantic failure.

The preserved profile is useful context but not an accepted attribution
verdict. A read-only callback-frame approximation found canonical at 46.98%
of self time, below the frozen 50% dominance threshold, with the remainder
distributed across GC, codecs, issuance storage, cryptography, and runtime
owners. Because the accepted cross-clock custody gate failed, D.110a-u must not
promote that approximation to a product finding.

## Scope

D.110a-u may change only:

- `tests/fixtures/phase-6c/retained-heap-worker.ts`;
- `tests/fixtures/phase-6c/retained-heap-child.mjs`;
- `tests/fixtures/phase-6c/retained-heap-contract.ts`;
- `tests/phase-6c-retained-heap-red.test.ts`; and
- this specification and the production-hardening plan ledger.

It may not change product source, dependencies, package exports, Vite or
workspace configuration, workload counts, application operations, stores,
wire formats, digest ownership, activation authority, object/window counts,
GC turns, memory thresholds, the 300,000 ms preflight watchdog, the 2,700,000
ms full watchdog, or full-worker invocation authority.

## RED

RED adds one exact `D110AU_PROFILE_CLOCK_CALIBRATION_MISSING` assertion to the
existing focused owner. Listing must select exactly one file and 21 titles.
The focused run must return exactly 20 passed and one failed, with the sole
failure carrying that token. RED runs no object, preflight, profile, or full
worker.

The desired-state audit requires all of the following:

- explicit before/after `Profiler.start` and before/after `Profiler.stop`
  `process.hrtime` calibration brackets;
- no absolute equality or ordering comparison between profiler timestamps and
  `process.hrtime` timestamps;
- one stable named workload callback frame whose body is the unchanged exact
  977-batch/15,625-operation loop;
- same-clock proof that all seven progress timestamps occur after the profiler
  start bracket and before the profiler stop bracket; and
- profiler-clock sample-window derivation from the named workload frame and
  its sampled ancestry.

## GREEN and replacement capture

GREEN extracts the existing callback body into one named tests-only workload
function without changing its operations, order, signing, issue/publish calls,
or counts. The child records four calibration timestamps around inspector
start/stop. It validates duration consistency using elapsed durations and
brackets, never absolute cross-clock values. It proves the progress timeline
was recorded while profiling using only `process.hrtime`, and derives the CPU
sample window using only profiler timestamps from the named workload frame.

The existing fresh-directory, exclusive `wx` write, exact one-file custody,
built-package hashes, PID/executable identity, cleared inherited
`NODE_OPTIONS`, 900,000 ms diagnostic timeout, normal-exit, phase-order,
operation/vertex/lifecycle counts, and no-memory-verdict checks remain. Static
GREEN must pass exact-owner lint/format/diff, child syntax, the three package
build-source typechecks, all-package build, focused 21/21, and the inherited
retained 95/95 selection before any replacement capture.

After those gates, D.110a-u permits exactly one separately labelled replacement
one-object profile under the user's existing express debugging authorization.
It is not a retry of the consumed D.110a-t name or evidence root. It uses a new
fresh directory, never overwrites the preserved D.110a-t profile, and stops on
the first signal, exception, timeout, nonzero exit, missing/extra file, or
semantic mismatch. The two-object preflight and 64-object worker remain
unspent.

Apply the unchanged dominance rule to self time in the named workload sample
window: at least 50% and at least twice the next owner group. If the result is
mixed or unavailable, close the slice without optimization and keep D.110a
paused. A clearly dominant tests-only owner must be inside this closed roster;
otherwise stop for a new slice. A clearly dominant product owner requires a
separately reviewed product-optimization slice before any product edit.

## Review

Because this authorizes one replacement capture adjacent to the scarce full
worker, the signed/pushed plan receives one Grok 4.6/high, standard direct Kimi
CLI K3 with `KIMI_LOOP_MAX_STEPS_PER_TURN=100`, and Opus xhigh review. Correct
P0/P1 findings once. Signed RED receives deterministic local validation. One
final Grok/Kimi/Opus review covers the accepted plan, causal RED, GREEN, raw
profile, attribution, and disposition. No Fable, Codex-Sol substitution,
collaboration subagent, recursive prose review, or long/full worker is allowed.
