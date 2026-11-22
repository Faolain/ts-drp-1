Investigation complete. Writing up the findings now.

## Bottom line

The timeout is most consistent with a process-wide slowdown that was already present before the wide case started, applied to a fixture whose genuine cost sits just under the 60 s budget. I found no production, artifact, dependency, or fixture drift that could add cost between the 56.9 s pass and the two timeouts, and no unbounded wait on the executed path. This is not proven. The root's proposed phase and CPU logging can settle it, but only if it also separates preemption from idle waiting, which CPU deltas alone cannot do.

## Observed facts

Durations from the three raw reporters, all in the same worker order:

| Test | Pass ab98cce6 | Timeout 71bca5d5 | Timeout 48f6877d |
|---|---|---|---|
| Pre-wide control, checkpoint-terminal cold recovery | 2,300 ms | 3,849 ms | 2,836 ms |
| Wide case | 56,860 ms pass | 60,034 ms timeout | 70,025 ms timeout |
| Case 1, first test after wide | 726 ms | 4,242 ms | 1,410 ms |
| Remaining 20 file-1 tests, summed | 20,494 ms | 24,558 ms | 24,366 ms |
| Second file, 21 tests | 7,432 ms | 8,325 ms | 8,663 ms |

- **Every test in both failing processes ran slower**, including the one that executes before the wide case. Ratios are about 1.2x across the board, and 1.67x and 1.23x on the pre-wide control. The wide case cannot have caused a slowdown that preceded it.
- **The 56.9 s base scaled by the pre-wide control's 1.23x is 70.1 s.** That matches the second timeout almost exactly. It is a consistency check, not proof.
- **Drift is excluded for seven of eight production owners.** Their source hashes in the pass run's `command.json` equal the current working tree, and the seven built artifacts have identical SHA-256 values across the pass run's runtime identity and both failing runs' custody files.
- **The eighth owner changed only by the room-guard repair.** The pass ran room source `9bbef5c2…`; both failures ran `391177c1…`, which is byte-identical to the current file. The evidence root at `.logs/d110c-0c1f5b-green-room-guard-db8a8615/room-only-final.patch` shows the whole delta is a reorder of the constructor prefix in `examples/v3-room/src/index.ts:1541-1625`. It decodes the invite once either way and adds no per-vertex, per-reopen, or per-epoch work.
- **Nothing the fixture imports changed in the range.** The only non-log source changes between the pass and HEAD are other test files and fixtures under `phase-3b`, `phase-5`, `phase-5e`, and `phase-6a`, plus the two-line watchdog literal. Lockfile and package manifests are unchanged. Runner hash matches the plan's recorded value.
- **Both timeouts were delivered 25 to 34 ms late**, so the event loop was not blocked by a long synchronous task at the deadline.
- **Earlier partial runs give a rough phase profile.** First close fired at about 10.7 to 12.8 s, and the epoch-1 checkpoint checks at about 25.7 s, under older bytes. That implies roughly 13 s for open plus epoch 0, and roughly 13 s per later transition cycle, with no sharp superlinear growth across epochs.
- **No other evidence-writing workstream touched `.logs` during either failing window.** Host contention from processes outside the repo cannot be excluded this way.

## Source-derived facts

- **Reported duration includes hooks.** The installed runner starts its clock before `beforeEach` and stops it after `afterEach` at `node_modules/.pnpm/@vitest+runner@3.1.1/node_modules/@vitest/runner/dist/index.js:1315`, `:1380`, and `:1413`. So `afterEach`, which closes every known session, finished within the 25 to 34 ms slack.
- **That bound constrains stall hypotheses.** `closeSession` at `examples/v3-room/src/index.ts:4411-4439` awaits the adoption task, the lifetime tail, the migration barrier, and a full drain of pending issues before shutdown. If any known session had been stuck in adoption or mid-issue, the hook would have taken seconds and a second hook-timeout error would appear. None does in either reporter.
- **No unbounded loop on the path.** The fixture's admission wait at `tests/phase-6b-d110c-0c1f5b-integration-red.test.ts:624-626` is capped at 256 IDB turns and throws on exhaustion. `publishAccepted` at `index.ts:2734-2741` terminates because `publishPendingRow` advances its cursor on every row at `packages/node/src/v3-live.ts:7279-7332`. The new replay loop at `index.ts:2318-2335` drains a buffer that only grows from ingress, and writers receive no ingress in this fixture.
- **No live wall-clock timer on the path.** The 250 ms lock timer in `packages/storage-browser/src/internal/primary-dispatch.ts:35` is inert because Node 22.15.0 has no `navigator.locks`; I verified that with a one-line probe. The blocked-open timer at `schema-idb.ts:284-288` rejects rather than waits and needs a version change that reopen never performs. The 10 s seal query timeout at `packages/node/src/creator-seal.ts:8` only fires for connected peers, and `fakeNetwork` reports none. The pacemaker is not imported by the room, creator-close, or v3-live.
- **Cost owners are real but unweighted.** Per transition the callback performs 63 concurrent authenticated reopens, each preceded by two whole-database copies with `structuredClone` per row, plus 64 fence-and-issue pairs routed through the creator, plus close, checkpoint, adoption, and cleanup. Which one dominates is unmeasured.
- **The timeout error can never show the await point.** Tests pass no stack-trace error into `makeTimeoutError`, so the stack is the timer's. Only in-callback logging can locate the phase.

## Hypotheses, falsifiers, confidence

1. **Host or process slowdown of unknown origin on top of a base cost within 5 percent of the old budget.** Scope: unknown, likely host. Evidence: uniform slowdown on every test, including the pre-wide control. Falsifier: the instrumented run shows CPU time per phase close to wall time and a total near 57 s, or one phase with wall far above CPU and low loop utilization. Confidence: moderate to high as the leading explanation, low on the specific source of the slowdown.
2. **Un-cancelled callback contamination.** Scope: runner plus fixture. `withTimeout` at runner `:840-880` rejects without cancelling. The 5.8x slowdown of case 1 after the 60 s timeout is consistent with the wide callback still executing. This explains forward contamination of later results, not the timeout itself. The surviving callback dies at its next creator ingress once transport close deletes the handler, but reopens started in the parallel phase complete and their new sessions are added after `afterEach` cleared the set. Confidence: moderate.
3. **Deterministic product or fixture stall.** Two passes on the byte-identical callback with cost-identical production make this unlikely. Falsifier: a phase with near-zero CPU and near-zero loop utilization for seconds. Confidence that it is absent: high.
4. **Nondeterministic stall.** The only wall-clock dependency left is the quarantine sweep in `snapshot-transfer.ts`, which would produce a fast assertion failure rather than a hang. Confidence that it is absent: moderate.
5. **Product regression from the room prefix reorder.** Rejected by source inspection. Confidence: high.

## Assessment of the proposed logging

The plan is right-sized and tests-only. Four adjustments make it discriminating:

- **CPU deltas alone cannot separate preemption from idle waiting.** Add `performance.eventLoopUtilization()` deltas and a `monitorEventLoopDelay` histogram per phase. Wall far above CPU with utilization near 1 means the worker was runnable but not scheduled, which is host contention. Wall far above CPU with utilization near 0 means a genuine wait. CPU near wall means own work. Also record `process.resourceUsage().involuntaryContextSwitches` and `os.loadavg()` at phase boundaries.
- **One phase is parent-side work.** The per-peer module realm import at fixture `:147-161` round-trips to the Vite server in the parent process for transform. Worker CPU will look idle there. Time that import separately so it is not misread as a stall.
- **Running the wide case alone removes the in-process control.** Add a fixed deterministic compute calibration at callback start and end, for example a constant number of ed25519 verifies, so host speed is measurable inside the run.
- **Timeout hazards.** Write entries with synchronous appends, since the forks pool terminates the worker and async writes are lost. Log a marker from `onTestFailed` or `afterEach` with the same monotonic clock so post-timeout entries are distinguishable. Wrap the callback body so its eventual rejection reason and time are recorded, because after cleanup it will fail with custody or closed-session errors that are artifacts, not defects. Do not use the reporter duration as the phase clock, since it includes hooks. Also log the admission-wait turn count per ordinary issue at fixture `:624`, which is a cheap direct measure of creator pipeline latency.

## Smallest next action

Run the root's single instrumented wide invocation with the additions above and the unchanged 70 s watchdog. Compare the phase profile against the roughly 13 s per transition structure above. If CPU tracks wall and the total lands near 57 s, the earlier failures were host slowdowns and the pending decision is about budget policy, not a defect. If one phase shows low CPU and low loop utilization, inspect that phase's outstanding await. If reopen dominates CPU, the measured owner is either the fixture's whole-database copy or the authenticated reopen, and that split needs one more counter before any optimization is proposed. Do not raise the watchdog again.

## Identity and tools

Reported model is `claude-fable-5-1`. Tools used: Read, Grep, and read-only Bash for `git log`, `git diff`, `shasum`, `find` on mtimes, JSON parsing with `node -e`, and one probe of `navigator.locks`. No tests, profiles, workloads, agents, or external model calls were run. No repository file was modified. One failed reconstruction attempt created an empty git directory at `/tmp/f5b-room-recon` outside the repository, which is inert.
