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

The two-object preflight observes only one and then two active successors; it
does not reach the full worker's 20-room steady-state window. The projection
therefore does not prove linear steady-state cost. Fixed wrapper overhead makes
part of it conservative, while any superlinear steady-state behavior remains
covered only by the preserved watchdog reserve and the consuming full result.

## Exact scope

The executable owner set is limited to:

- `tests/fixtures/phase-6c/retained-heap-contract.ts`;
- `tests/phase-6c-retained-heap-red.test.ts`;
- `tests/fixtures/phase-6c/retained-heap-child.mjs`;
- `tests/fixtures/phase-6c/retained-heap-worker.ts`;
- new parent-only `tests/fixtures/phase-6c/retained-heap-forensics.mjs`;
- new bounded `tests/fixtures/phase-6c/retained-heap-forensics-child.mjs`; and
- new `tests/phase-6c-retained-heap-forensics-red.test.ts`.

The timing GREEN changes only the contract/test pair. The material amendment
below permits the smallest parent-launcher and worker-progress changes needed
for failure forensics before the full run. Planning/evidence may additionally
update this specification, `specs/phase-6c-memory-gates/README.md`, the earlier
D.110a slice documents, and
`docs/production-hardening/production-hardening-tdd-plan-v2.md`.

No product source, package manifest, lockfile, dependency, workflow, retry
behavior, profile timeout, preflight child timeout, workload,
object/vertex/operation count, GC turn, sample window, terminal proof schema,
memory ceiling, slope ceiling, semantic digest, or D.110b runner choice may
change. If any such change appears necessary, stop and reslice.

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

## Timing GREEN

Change only `D110A_FULL_TIMEOUT_MS` from 21,600,000 to 25,200,000 and update
both inherited focused arithmetic expectations: six hours to seven hours and
17,280,000 to 20,160,000 for the derived 80-percent value. The
`preflightVariance` predicate uses direct value comparisons and also requires
`D110A_PREFLIGHT_RELEASE_MAX_MS * 32 === D110A_FULL_TIMEOUT_MS * 0.8`; it must
not use a source regex that can match its own expected literal. The existing
child import makes that one constant the sole executable timer change. Do not
add a second timer owner.

The timing focused GREEN already ran once and passed 23/23 before the
failure-forensics amendment. Preserve it; do not rerun it merely because the
forensics work adds a separate focused file.

## Material failure-forensics amendment

Before the sole full worker, close the demonstrated asymmetry between complete
success proof and memory-only failure context. This amendment does not reopen
D.110a-w, rerun its consumed preflight, or change the seven-hour/630-second
arithmetic. It adds no new long invocation.

For full mode only, the parent must create fresh write-once root
`.logs/phase-6c-d110a-full/` and `invocation-consumed.json` before spawning the
worker. It then writes authenticated source identity (signed commit/tree and
exact child/worker/contract hashes), Node identity, every resolved public import
and internal URL/hash, command, and 25,200,000-ms deadline to a write-once
identity record before spawn. The root must already be absent; no overwrite or
reuse path is accepted.

The parent opens distinct raw child stdout, child stderr, progress JSONL, and
launcher-event JSONL files with exclusive creation. Every received chunk or
journal record is synchronously appended and flushed before custody advances.
The launcher journal records start wall/monotonic time, identity persistence,
child PID/spawn, terminal-message receipt, watchdog firing, child exit, finish
time, and elapsed time. A final write-once status record explicitly contains
the deadline, watchdog-fired boolean, PID, exit code, exit signal, terminal-
result-received boolean, and parent success/failure status. On successful full
completion the parent also writes the exact JSON it returns to `parent.json`;
the public stdout remains the same complete parent result.

The measured worker performs no evidence I/O. It may send bounded IPC progress
facts. Each lifecycle phase record contains a worker monotonic timestamp,
object index, completed-object count, applied-operation count, active-successor
count, and one exact phase from `fixture-open`, `workload-complete`,
`creator-close-complete`, `reclamation-complete`, or `successor-published`.
After the existing post-GC measurement it sends one `completed-sample` record
containing the same counters plus the already-created complete memory reading.
The parent assigns one contiguous journal sequence and flushes each record.
These facts are diagnostic only and never become or substitute for a memory
verdict.

Add exact token `D110AX_FAILURE_FORENSICS_MISSING` and a deterministic source-
shape owner. The new focused RED runs once without the real worker and fails
only that token while every timing assertion remains green. After signing and
pushing RED, GREEN adds the parent-only recorder, enriched bounded worker IPC,
and a tiny synthetic child used only by the focused fault matrix. The matrix
covers normal miniature completion; controlled failure after several phase/
sample records; watchdog termination; child error; partial stdout/stderr;
missing, duplicate, malformed, and out-of-order records; and terminal-proof/
journal mismatch. It proves evidence survives process death and every
non-success classification remains fail closed.

The success validator requires exactly 64 `completed-sample` records with
indices 0 through 63, operation counts `(index + 1) * 15,625`, completed counts
`index + 1`, active counts `min(index + 1, 20)`, complete nonnegative memory
readings equal to the terminal proof samples, contiguous journal ordering, and
valid per-object lifecycle order. Only after that equality check does the
existing `validateD110aProof` remain authoritative for accounting, digest,
slopes, absolute ceiling, and during-execution sampling. A partial journal has
diagnostic validity only and cannot satisfy full success.

Because this materially amends launcher/evidence behavior adjacent to a sole
consuming run, sign and push the amended plan and run exactly one confirmation
with Grok 4.6/high, standard direct Kimi K3/100-step, and Opus xhigh before the
new RED. Only P0/P1 blocks. Do not restart the completed plan review; retain the
existing final GREEN review over the complete timing plus forensics history.
P2 findings receive a disposition without recursive review. No Fable or
collaboration subagent is authorized.

## Completed GREEN gates

After the separate forensics focused GREEN passes once, run the affected
package build/source typechecks, exact-owner ESLint and Prettier, child and
synthetic-child syntax, source-shape, selected-title/file, `git diff --check`,
retained 95-test Phase-6a/6b/6c selection, protected-path, stash, process, port,
signed-commit, pushed-ref, and self-excluding-manifest gates. Sign and push
complete GREEN before the single final Grok, standard direct Kimi K3/100-step,
and Opus xhigh review. Only P0/P1 blocks.

## Reserved execution after final review

The completed D.110a-w preflight is immutable input, not a rerunnable gate.
After an empty final-review P0/P1 union, open the D.110a-w preflight root
read-only and write all D.110a-x revalidation output to fresh write-once root
`.logs/phase-6c-d110ax-release/`. Revalidate the inherited parent/audit/manifest
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
