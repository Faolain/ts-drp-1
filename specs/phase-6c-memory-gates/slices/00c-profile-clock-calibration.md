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

RED also lands the detached validator's exported signature and synthetic input
types as collection-safe scaffolding. The positive audit assertion executes
first and remains the sole causal failure while the implementation is absent;
missing imports or collection errors are not an accepted RED.

The desired-state audit requires all of the following:

- exact `process.hrtime` calibration fields `hrtimeBeforeStart`,
  `hrtimeAfterStart`, `hrtimeBeforeStop`, and `hrtimeAfterStop`, recorded
  immediately before/after `Profiler.start` and before/after `Profiler.stop` as
  microseconds using the same `Number(process.hrtime.bigint() / 1_000n)`
  derivation as the frozen `monotonicMicroseconds` phase schema;
- no absolute equality or ordering comparison between profiler timestamps and
  `process.hrtime` timestamps;
- the exact replacement root `.logs/phase-6c-d110au-green`, profile filename
  `d110au-main.cpuprofile`, fresh-directory prefix `profile-`, and root-level
  exclusive sentinel `capture-consumed.json`, plus root-level durable terminal
  record `capture-records.json`;
- the stable named async function `runD110auApplicationWorkload`, whose body is
  the unchanged exact 977-batch/15,625-operation loop, returns both
  `{ appliedWorkloadOperations, latest }`, and is called only from the shared
  `buildObjectEpoch` path used by profile, preflight, and full modes;
- same-clock proof that all seven progress timestamps occur after the profiler
  start bracket and before the profiler stop bracket; and
- exact function-name plus `retained-heap-worker.ts` URL matching across every
  CPU-profile node for the named workload function; and
- a closed profiler-time interval from the first through last sample whose
  ancestor chain contains any matching named-function node, attributing every
  sample in that interval—including GC/runtime leaves—by leaf self time.

The one added title positively asserts the complete audit field with
`D110AU_PROFILE_CLOCK_CALIBRATION_MISSING` as its assertion message and then
invokes the same exported detached validator that the real parent launcher
uses. Its valid synthetic control deliberately uses disjoint profiler and
`process.hrtime` absolute origins, includes multiple node ids for the same
exact named function, and must pass. The same title executes these exact
mutants and tokens:

- `phase-before-start` and `phase-after-stop` each throw
  `D110AU_PROFILE_PHASE_OUTSIDE_CAPTURE`;
- `missing-named-frame` throws `D110AU_PROFILE_WORKLOAD_FRAME_MISSING`;
- `zero-matching-samples` throws `D110AU_PROFILE_WORKLOAD_SAMPLES_MISSING`;
  and
- `single-sample-window` throws `D110AU_PROFILE_WORKLOAD_WINDOW_DEGENERATE`.

This behavioural matrix must execute before the replacement capture; a
negative grep or renamed-source predicate alone is insufficient. Keeping the
control and mutants in this single title preserves the frozen 21-title roster.

## GREEN and replacement capture

GREEN extracts the existing callback body into the named tests-only async
function `runD110auApplicationWorkload` without changing its operations,
order, signing, issue/publish calls, or counts. The function returns both the
final applied count and `latest`; the callback consumes both and evaluates the
existing 15,625 applied-operation invariant from that returned object and the
15,628 logical-time invariant as
`firstLogicalTime + appliedWorkloadOperations === 15_628`. The returned applied
count is also assigned to the outer lifecycle counter before any later phase or
result reads it. No profile-only workload copy is allowed.

The child records and reports raw `process.hrtime` stamps immediately before
and after `Profiler.start` and immediately before and after `Profiler.stop`,
stops the profiler, writes the raw profile with exclusive creation, and only
then sends its terminal IPC result containing those microsecond brackets. It
does not adjudicate calibration, containment, sample windows, or dominance.
On receipt and before any validation or adjudication, the parent writes the
complete terminal envelope—including the four brackets, seven phases, PID,
and executable path—to root-level `capture-records.json` with exclusive `wx`
creation. The parent performs every subsequent check from the already durable
profile and terminal record, so a validator defect cannot discard either
input required to adjudicate the sole artifact.

The parent calls the same exported detached contract validator exercised by
the synthetic control and mutants. It proves every phase lies in the
same-clock closed interval
`[hrtimeAfterStart, hrtimeBeforeStop]`. It compares no profiler timestamp to an
hrtime absolute value. Duration custody is one-sided only:
`0 < profile.endTime - profile.startTime <= hrtimeAfterStop -
hrtimeBeforeStart`, with the existing 900,000,000-microsecond ceiling; there is
no lower-bound agreement requirement because inspector stop/materialisation
latency and clock-rate skew need not be symmetric. The parent derives the
workload window solely in profiler time using exact function-name plus URL
matches across all matching node ids, fails with distinct exact tokens for no
matching frame, no matching sample, and a degenerate/single-sample window, and
attributes every sample in the first-to-last closed interval by leaf self time.

The exact D.110a-u root, filename, `profile-` directory prefix, and
`capture-consumed.json` sentinel; root-level `capture-records.json`; exclusive
`wx` profile and terminal-record writes; exact one-file profile-directory
custody; built-package hashes; PID/executable identity; and cleared inherited
`NODE_OPTIONS`, 900,000 ms diagnostic timeout, normal-exit, phase-order,
operation/vertex/lifecycle counts, and no-memory-verdict checks remain. Static
GREEN must pass exact-owner lint/format/diff, child syntax, the three package
build-source typechecks, all-package build, focused 21/21, and the inherited
retained 95/95 selection before any replacement capture. The preserved
D.110a-t profile hash
`f7b0de49a5a364304acc9f8c5838d6ef6bdb8903ee92c7098c4b6cf3c9e25d99`
must verify immediately before and after the replacement capture.

After those gates, D.110a-u permits exactly one separately labelled replacement
one-object profile under the user's existing express debugging authorization.
It is not a retry of the consumed D.110a-t name or evidence root. It uses a new
fresh directory, never overwrites the preserved D.110a-t profile, and stops on
the first signal, exception, timeout, nonzero exit, missing/extra file, or
semantic mismatch. The two-object preflight and 64-object worker remain
unspent.

A failed replacement capture closes D.110a-u as unavailable, keeps D.110a
paused, and grants no further profile invocation authority. The write-once
sentinel makes a second launcher invocation fail before spawn even if the first
replacement fails. The parent creates that sentinel only after expected built
imports, internal-module URLs, and the fresh target have validated, immediately
before `spawn`, so a pre-spawn validation defect does not consume the capture.

Apply the unchanged dominance rule to self time in the named workload sample
window: at least 50% and at least twice the next owner group. D.110a-u only
reports mixed, unavailable, or dominant; it performs no optimization. If the
result is mixed or unavailable, close the slice and keep D.110a paused. A
clearly dominant tests-only owner must be inside the D.110a-t roster frozen in
`00b-workload-feasibility-attribution.md`; otherwise stop for a new slice. A
clearly dominant product owner requires a separately reviewed
product-optimization slice before any product edit.

A mixed or unavailable result also receives an explicit successor rather than
an indefinite attribution loop: a separately planned/reviewed D.110a-v may
perform read-only whole-lifecycle phase/owner disposition from the already
durable D.110a-u profile and terminal record. It receives no process, profile,
preflight, full-worker, product-edit, threshold-change, or retry authority.
D.110a-u does not pre-authorize cross-clock phase mapping as an acceptance
predicate; D.110a-v must state and review any diagnostic mapping method before
using it.

## Review

Because this authorizes one replacement capture adjacent to the scarce full
worker, the signed/pushed plan receives one Grok 4.6/high, standard direct Kimi
CLI K3 with `KIMI_LOOP_MAX_STEPS_PER_TURN=100`, and Opus xhigh review. Correct
P0/P1 findings once. Because the accepted correction materially pins
executable causal acceptance, permit one confirmation review of the corrected
plan and no further plan-review recursion. Signed RED receives deterministic
local validation. One final Grok/Kimi/Opus review covers the accepted plan,
causal RED, GREEN, raw profile, attribution, and disposition. No Fable,
Codex-Sol substitution, collaboration subagent, recursive prose review, or
long/full worker is allowed.
