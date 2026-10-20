# Track L: reopen admission failure and close race

**Outcome:** both bugs fixed in the product. The Grid now runs the final recipient lull again: the harness
skip is removed, and every acceptance run passed, including persisted close, reopen and continued gameplay.

- Branch: track-l-reopen-close-fixes, based on codex/phase3a1b-p6-golden-path at 9f606ce8. I fast-forwarded
  it to 1c6a8259, which changes docs only.
- `<evidence>` is the session scratchpad. Track L's logs, bench runs and scripts are under
  `<evidence>/track-l/`.
- Line numbers marked `base:` are at 1c6a8259, whose code is identical to 9f606ce8. Those marked `fix:` are at
  the final commit. `CCRD` is packages/node/src/internal/creator-closed-rollback-data.ts.
- Guarantee IDs refer to
  [specs/bounded-storage-lifecycle/golden-path-guarantees.md](../../../../specs/bounded-storage-lifecycle/golden-path-guarantees.md).

## Commits

| commit | kind | what |
|---|---|---|
| dcab6d12 | test (RED) | `tests/recipient-lull-reopen-close-native.test.ts`: reopen admission after a maintained recipient lull, and the orderly close racing the lull's retained repair |
| dd70af0c | test (RED) | same file: an orderly close whose own transport revocation refuses a retained send |
| f9828cd0 | fix, bug 2 | an orderly close cancels the retained publication it is serving |
| 2cb1a9fc | fix, bug 1 | a reopened recipient discharges its completed-retirement halt |
| 504e4035 | harness | runs the final recipient lull in the Grid bench again (removes the skip that 86dc4004 documented) |
| 9379fc48 | fix, bug 1 follow-up | skips the post-resume retained request once the room is closing |

## 1. Reproduction

**Node level.** All three tests are in `tests/recipient-lull-reopen-close-native.test.ts`. They use genuine
owners:

- SQLite through `createNodeV3RoomStorageHost`;
- `createNodeRoomHeadAuthority`, Keychain/Ed25519 and the creator-trusted-v1 profile;
- a scripted native-byte transport.

A creator and a receive-only recipient run the integrated Grid's rollover five times: moves, seal, adopt,
install, creator lull, recipient lull. `LULL_REOPEN_EPOCHS` overrides the count. The last recipient lull is
`maintained` and completes the recipient's own AHE retirement through epoch 4 at epoch 5. The test asserts
this from the stored retirement control.

| test | at base 1c6a8259 (RED) | at fix |
|---|---|---|
| 1. A recipient whose lull completed a retirement admits the creator's next move after a persisted reopen | fails: `LULL_REOPEN_REMOTE_ADMISSION_TIMEOUT`. The reopened recipient never admits the creator's `after-reopen` move (`<evidence>/track-l/red-base-final.log`) | passes. It also passes the next rollover with a non-deferred lull and a second move (`fix1-try1.log`, `fix1-targeted2.log`) |
| 2. An orderly close cancels the retained repair it is serving after a recipient lull | fails. The two publisher calls in flight during the creator's close reject with `publication-state-unknown` and `not-active` (`red-base-final.log`) | passes (`fix2-green.log`). Its guards still require `publish-failed` and `not-active` to reject outside a close |
| 3. An orderly close cancels a retained send that its own transport revocation refused | fails: `publish-failed` (`red-base-revoked.log`) | passes. It asserts that the plane was still current when the revoked transport refused the send |

**Grid.** Before this track, Track K's harness skipped the recipient lull after the last rollover, because
of these two bugs (comment in base `tests/fixtures/startup-discovery/healthy-grid.ts:545-551`). With the skip
removed and the fixes in place, every acceptance run passes (section 5).

## 2. Root cause

### 2.1 Bug 1: no reopened recipient admits the creator's next move

The failure is a chain of five steps:

1. **The lull completes a retirement at the current epoch.** The recipient lull at epoch E runs the original
   received turnover. It completes the AHE retirement control with `active = null` and
   `completed.throughEpoch = E-1`, and records a snapshot retirement fact on the current close scope.
   - Instrumented evidence (`<evidence>/track-l/evidence-lead-admit.log`): the in-session install at epoch 5
     shows `completedThrough: 3`. After the lull, the durable reopen shows `completedThrough: 4`.
2. **The durable reopen halts admission.**
   - Reopen reconstructs the request through `acquireCreatorSnapshotRetirementReconstructionRequest`
     (base creator-adoption.ts:2923) and gets a receipt.
   - Activation (base v3-live.ts:20908-20923) then sees `resumeCheckpoint`: epoch ≥ 2 and
     `completed.throughEpoch + 1 === currentEpoch`.
   - It sets `operationAdmissionHalted = true` and `retirementResumeControl`. The receipt also halts and sets
     `retirementReconstruction`.
   - Evidence: `TRACK_L_ACTIVATION {"origin":"durable-reopen","receiveOnly":true,"epoch":5,"resumeCheckpoint":true,"completedThrough":4,"receipt":true,"halted":true}`.
3. **Halted ingress is dropped.** Ingress with `!alreadyAccepted && operationAdmissionHalted` is rejected
   (base v3-live.ts:7562). Evidence: `::v3-ingress admission-rejected` and
   `TRACK_L_INGRESS_HALTED {"receiveOnly":true,"epoch":5,"resume":true,"control":4,"receipt":true}`, followed by
   the test's timeout.
4. **Only a creator has a discharge path.** `prepareCurrentCreatorOrdinaryReadiness` returns immediately for
   `receiveOnly || creatorCloseHandle === undefined` (base v3-room.ts:5645-5646). Only the creator's close owner
   asks `needsOrdinaryReadinessRecovery()` (base creator-close.ts:4716) and runs
   `runCreatorOrdinaryReadinessMaintenance` (base v3-live.ts:11273). That function's completed-resume path
   clears the halt after the original reconstruction has joined (base v3-live.ts:11390-11400).
5. **A recipient has none, and its install is refused too.**
   - Its resolver (base v3-live.ts:5119-5121) calls `creatorCloseRegistration(registration, "recipient")`.
     That refuses a halted plane unless the purpose is `"close"` (base v3-live.ts:19573-19574).
   - So the next install fails with "creator recipient current authority is unavailable" (base
     creator-adoption.ts:1029; evidence `DEBUG_INSTALL_FAILED ...` in `evidence-lead-install.log`), and the
     lull reports `deferred/unsupported` (base creator-adoption.ts:967).
   - Even with a resolved registration, `runCreatorReceivedRecoveryMaintenance` requires
     `!operationAdmissionHalted` (base v3-live.ts:19493).
   - Nothing on the recipient ever clears the halt, so play stops for good.

**Verdict on K's lead: the trigger is right; the mechanism and the "next install clears it" claim are wrong.**

- Right: a completed control with `throughEpoch + 1 === currentEpoch` does satisfy
  `creatorRetirementResumeRequested` (base v3-live.ts:19239), and the reopen halts.
- Wrong: `needsOrdinaryReadinessRecovery` (base v3-live.ts:19738) is only the creator's readiness hook. On a
  recipient nothing calls it.
- Wrong: the next install does not clear the halt. It is refused, because the recipient resolver will not
  resolve a halted plane.
- Not the cause: the creator. Its durable reopen in the same test is not halted (`completedThrough: 3` at
  epoch 5).

The halt itself is correct. The completed retirement must be re-verified through the original reconstruction
before the reopened copy admits anything. What is missing is the recipient's way to run it.

### 2.2 Bug 2: the persisted close fails on the final lull's retained repair

1. **The lull fires an unawaited repair.** A `maintained` recipient lull calls
   `roomTransport.requestRetainedHistory()` without awaiting it (base v3-room.ts:6716). Every peer's transport
   serves the request by calling that room's retained publisher.
2. **The publisher throws on every non-ok result** (base v3-room.ts:4103-4112):
   `throw new TypeError("v3 room retained publication failed: ${result.kind}")`.
3. **An orderly close produces non-ok results by construction.**
   - `closeSession` (base v3-room.ts:6902) sets `closed`, then `revokeTransport()` synchronously (base 3525:
     "close revokes/cancels synchronously; its promise joins admitted work").
   - Only after awaiting its barriers does it run `shutdown()` (base 3540). That calls
     `creatorCloseHandle.stop()` / `deactivateV3LivePlaneJoined` (base v3-live.ts:21405), and then
     `deactivateRegistration` (base v3-live.ts:7152), which sets the plane inactive, unsubscribes and joins
     `joinedWork`.
   - A publication in flight across that sequence ends in one of three ways:
     - `not-active`: the plane was already retired, or the target is gone (base v3-live.ts:21074,
       `republishRetained` at 16303);
     - `publication-state-unknown`: the plane was retired around the send;
     - `publish-failed`: a send the revoked transport refused while the plane was still current (test 3).
4. **The integrated transport counts the rejection as a fault.** The bench worker transport records
   publisher rejections as operation failures. Its `join()` then throws "original transport operations
   failed", so the persisted close fails.

The production `NodeRoomNetworkAdapter` swallows publisher errors. So the visible failure is in the strict
transport, but the product's publisher reported a close-caused outcome as a fault in both cases.

**Decision: cancel.**

During this session's own orderly close, the publication the close is serving is cancelled, not reported as a
fault. Why not the alternatives:

- **Join** would need the close to keep the transport alive until remote requesters are served. That inverts
  the established revoke-first close order, which is what keeps delayed callbacks and packets out of a
  terminal session (G4). It could also hang a close on a remote peer. And if the requester is closing too, the
  join fails anyway.
- **Treating `not-active` as never a fault** would hide genuine faults outside a close: an absent target, or a
  plane retired by something else.

The repair is a best-effort, authenticated catch-up. A requester that misses it requests retained history
again when it next opens (base v3-room.ts:4194), so nothing is lost by cancelling.

## 3. Fix

### 3.1 Bug 2, commit f9828cd0 (v3-room.ts only)

In the retained publisher (fix: v3-room.ts:4104-4127), the change is:

```ts
if (result.ok) return;
if (sessionCloseTask !== undefined && terminalFailure === undefined &&
    (result.kind === "not-active" || result.kind === "publication-state-unknown" || result.kind === "publish-failed"))
  return;
throw new TypeError(`v3 room retained publication failed: ${result.kind}`);
```

- **What it covers.** `sessionCloseTask` is set only by this session's explicit `closeSession`
  (fix: v3-room.ts:6981-7013).
- **What still rejects:**
  - automatic terminal `shutdown()` and every failure after `terminalFailure`;
  - every failure outside a close (test 2 asserts `publish-failed` and `not-active` there);
  - `store-failed` and `record-rejected`, even during a close.
- **Calls that start after close.** A publisher call that begins after close starts still throws "session is
  closed" from its first line, `assertSessionOpen()`, as before.

### 3.2 Bug 1, commits 2cb1a9fc and 9379fc48

This is the recipient twin of the creator's completed-resume discharge. It runs the same original received
reconstruction, once, at reopen, before startup reports ready.

**v3-room.ts, `createV3RoomSessionOwned`** (fix: v3-room.ts:6738-6801 and startup waiter 7462-7468):

- When the session has no finality signer and `creatorRecipientRetirementResumeRequested(activeHandle)`
  holds, it does three things:
  - sets `poolMaintenanceBarrier` synchronously, so local issues are held, exactly as during a lull;
  - enqueues one transition in the lifecycle FIFO;
  - makes the diagnostics startup waiter await that transition.
- The transition:
  1. waits for rebase, migration, a fresh room-head read and drained issues;
  2. requires an open session, the same plane and transport, and no pending room-head advance;
  3. calls `maintainCreatorRecipientRecoveryPool({..., resume: true})`.
- If the result is `maintained` and the room is not closing (9379fc48), it requests retained history. That
  repairs ingress dropped while halted, through the authenticated path a reconnect uses.
- Any failure after the transition starts is terminal (`terminalFailure` plus `shutdown`). This is the same
  shape as the creator's rebase transition (fix: v3-room.ts:5669-5689).
- A plane without the request is untouched.

**creator-adoption.ts:**

- `creatorRecipientRetirementResumeRequested` (fix: 950-958) is new. It is observation only and grants no
  admission.
- `maintainCreatorRecipientRecoveryPool` (fix: 974-1012) takes `resume?: true`:
  - it resolves with the resume purpose;
  - it is requested by `needsOrdinaryReadinessRecovery()`, not by pool pressure;
  - it passes `requireClosedWorkflowCompletion` through `runReceivedRecoveryTurnoverPasses` (fix: 901-948).
- The pinned call counts are unchanged: 3 `receivedRecoveryTurnoverDue(` and 3
  `runReceivedRecoveryTurnoverPasses(`.

**v3-live.ts:**

- **Resolver** (fix: 5119-5124): `resume === true` resolves with the purpose `"recipient-resume"`.
- **`creatorCloseRegistration`** (fix: v3-live.ts:19593-19605, the halt term): a halted plane resolves for
  `"close"` and `"recipient-resume"` only when `creatorRetirementResumeRequested(registration)`. Installs
  (`"recipient"`) and lulls still find a halted plane unavailable.
- **`runCreatorReceivedRecoveryMaintenance`** (fix: 19479-19590). With `resume`:
  - It is never deferrable.
  - It captures `retirementResumeControl` and `retirementReconstruction`.
  - `completedRequestMatches` is the creator's predicate (fix: v3-live.ts:11294-11298), term for term:
    - `active === null`, the same objectId and defined `completed.domains`;
    - `throughEpoch + 1 === currentEpoch`;
    - the reconstruction is absent, or has the same head and room head;
    - `creatorRetirementResumeRequested`.
  - If the plane is not halted on such a request, it returns `"deferred"` before entry, with no hold, gate or
    native work.
  - After entry, `available()` requires the same captured fields, still halted and still matching. Without
    resume it requires `!halted`, as before.
  - `consume(seal, true)` must return `"complete"` with at least one sealed census (`lifetimes.length > 0`).
  - Only after every admitted hold and release has joined, with no await in between, does it clear
    `retirementResumeControl`, `retirementReconstruction` and `operationAdmissionHalted`. This mirrors
    fix: v3-live.ts:11398-11402.

**Supporting signature changes, no behaviour change on existing paths:**

- **creator-close.ts:** the `V3CreatorCloseRegistration.runReceivedRecoveryMaintenance` type. `consume`
  receives `requireClosedWorkflowCompletion: boolean`, and `options.resume` is added.
- **internal/creator-closed-rollback-data.ts:** `reconcileCreatorReceivedSnapshotRecoveryRoles` takes
  `requireClosedWorkflowCompletion = false` and forwards it as `reconcileSnapshotRecoveryRoles`' fourth
  argument, where the creator's resume already passes it. With `true`, an inherited/not-ready inventory
  (CCRD:20427) or a no-op with no retirement source (CCRD:21602) refuses with `snapshot-unavailable` instead
  of reporting complete. A resume cannot discharge the halt on a no-op.
- **internal/creator-recipient-provenance.ts:** the resolver type and
  `resolveCreatorRecipientRegistration(plane, resume = false)`.

Evidence that it discharges by the original path: `TRACK_L_RESUME_CLEARED {"epoch":5,"lifetimes":1,"through":4,"receipt":true}`
(`<evidence>/track-l/fix1-evidence.log`; the instrumentation was reverted).

### 3.3 Harness, commit 504e4035

`tests/fixtures/startup-discovery/healthy-grid.ts`, `runHealthyGrid`: `recipientLull = lull`. It was
`lull && transition < rollovers - 1`. The comment now says why every rollover, including the last, runs the
lull.

### 3.4 Guarantee argument

Each guarantee is checked against
[golden-path-guarantees.md](../../../../specs/bounded-storage-lifecycle/golden-path-guarantees.md), and each
claim names the test or evidence behind it. One brief rule is argued first:

> "never let a reopened room admit moves before its readiness and recovery state is genuinely re-established"

- The halt is not bypassed. Admission reopens only by the original received reconstruction:
  - under `requireClosedWorkflowCompletion = true`;
  - through at least one sealed census;
  - after every admitted hold and release has joined;
  - with `completedRequestMatches()` re-checked at every boundary.
- Ingress refused while halted is not admitted late from memory. It is re-fetched through the authenticated
  retained path.
- Test 1 shows admission happens only after the resume, and that the next rollover's lull is not deferred.

**G2: backpressure, admission stops if maintenance cannot drain, accepted work stays finishable.**

- The halt stays in force until the resume completes.
- A resume that cannot match, or fails after entry, leaves the plane halted or the session terminal. It never
  leaves it admitting.
- Local issues are held behind `poolMaintenanceBarrier` during the resume, as during a lull, and drained
  afterwards.

**G3: golden path (all writers, rebase, crash recovery, next issuance).**

- Test 1 covers reopen, continued gameplay, the next rollover and the next move.
- Every Grid acceptance run covers persisted close, reopen and continued gameplay with the final lull
  included (section 5).
- The related suites pass:
  - r9-canvas-receive-only-native, 14/14: rollover, reopen and continued gameplay;
  - recipient-long-room-journal-retention-native, 2/2 (`fix1-related.log`).

**G4: terminal sessions are not resurrected.**

- The bug 2 cancellation only stops reporting. It sends nothing, and the close order is unchanged:
  `closed`, then revoke, then retire. A call starting after close still throws at `assertSessionOpen()`.
- The resume's repair request is skipped once `closed` (9379fc48).
- The resume checks `assertSessionOpen()` and the plane and transport identity before entry.

**G5: durable bytes are untrusted and re-verified on every open.**

- The resume is the re-verification. It re-runs the original reconstruction against the stored control and
  receipt instead of trusting `completed`.
- `completedRequestMatches()` requires the receipt's head and room head to equal the live trust.

**G7: one retirement decision owner, no sweeper.**

- No new decision path is added. The resume calls the same `runReceivedRecoveryTurnoverPasses` →
  `reconcileCreatorReceivedSnapshotRecoveryRoles` → `reconcileSnapshotRecoveryRoles` path that the lull and the
  install use.
- The governance counts pinned by `creator-recipient-recovery-pool.test.ts` are unchanged (3 and 3), and that
  test passes 6/6.
- Epoch age and counts grant nothing. The trigger is the stored halt, and the effect is the original
  reconciliation.

**G9: each owner rechecks its own facts transactionally before deletion.**

- No participant fence or commit was changed.
- The resume runs inside the same received gate as the lull, with `available()` re-checked around every await.

**G10: native currency and authority do not outlive a stage.**

- The resume captures nothing across stages except the identity of the halt request. It re-checks that
  request against live registration fields.
- It opens a fresh signing recovery owner and stops it in `finally`, as the lull does.

**G14: one bounded resumable intent; absent receipt means retain.**

- An active intent still halts and is not discharged: `active === null` is required, so the resume returns
  `"deferred"` and the plane stays halted, as at base.
- `requireClosedWorkflowCompletion` means a reconstruction that cannot prove terminal completion refuses
  instead of reporting complete.

**G15: crash atomicity, old XOR new.**

- The halt fields live only in memory. They are cleared only after the joined success, with no await in
  between.
- A crash at any point leaves the durable control and receipt as they were, so the next open halts again and
  re-runs the resume. This retains too much; it never deletes too much.

**G21: bounded work.**

- One resume per open: one queued transition with the lull's pass bound. No new limits.

**G22: proof budget.**

- The same signing owner and charged passes as the lull. No refunds, and no budget sharing beyond the
  existing pass.

**G23: lull ingress queues FIFO, nothing dropped.**

- The resume is not a deferrable lull; it is the reopen halt. Ingress arriving while halted is rejected as at
  base, exactly as for a halted creator.
- After a maintained resume, the room requests retained history, so those moves are re-fetched and admitted
  through full authentication. Test 1's delivery and the Grid's continued gameplay rely on this.
- Deferrable-lull FIFO queueing is unchanged.

**G24: the floor is a trusted expectation, never repaired.**

- Before entry the resume requires a fresh room-head read with no pending advance (`openedRoomHeadState.pending
  === null`). It passes the stable head as `expectedRoomHead`, and `sameCreatorRoomHead` must match.

**G26: latency never relaxes safety.**

- Nothing was relaxed. Bug 2 narrows which outcomes count as faults to exactly those the close itself causes.
- The resume adds about 0.4–0.6 s to a recipient reopen, and only after a final lull (section 5).

**G28: native evidence.**

- The tests use native SQLite, Keychain and the room-head authority. The Grid runs native browser storage.
- No three-engine or SIGKILL claim is made; nothing durable changed.

G1, G6, G8, G11–G13, G16–G20, G25 and G27 are untouched. No storage format, retention rule, lock, migration or
game-specific path changed.

## 4. Tests

### 4.1 Targeted

These logs are under `<evidence>/track-l/`:

| run | result | log |
|---|---|---|
| new test file | 3/3 | `fix1-targeted2.log`, `fix2-green.log` |
| creator-recipient-recovery-pool (governance) | 6/6 | `fix1-targeted2.log` |
| creator-recovery-pool-gameplay | 12/12 | `fix1-targeted2.log` |
| r9-canvas-receive-only-native and recipient-long-room-journal-retention-native | 16/16 | `fix1-related.log` |
| creator-ordinary-readiness-producer | all pass except "uses the genuine same-head pair...", which also fails at base | `producer-base.log` |

### 4.2 Before/after suite diff (node, storage-node retirement tests, root room tests)

**Method.**

- "after" ran at 9379fc48. "before" ran on the same worktree with packages/ and tests/fixtures/ temporarily
  reverted to 1c6a8259 (`git apply -R` of `bench/bug1-fix-b.patch` and `bench/base-to-fix.patch`). The
  script checked that the diff against 1c6a8259 was empty, ran the suites, re-applied both patches, and
  checked that the diff against HEAD was empty (`<evidence>/track-l/tests/base-suite.log`).
- Command: `vitest run <set> --exclude ".claude/**" --exclude "**/.logs/**" --no-coverage --testTimeout=120000`
  with a JSON report (`bin/suite.sh`, `bin/root-room.sh`, `bin/diff-tests.py`).
- The sets:
  - **node**: packages/node.
  - **storage-node-retire**: retirement-image-cas, snapshot-recovery-retention-red, phase-6b-ahe-reclamation-red,
    phase-6b-issuance-retention-red, phase-3a1b-p4-node-live-journal-red and room-head-native.
  - **root-room**: 19 root `tests/` room files, including r9-canvas-receive-only-native,
    recipient-long-room-journal-retention-native, r9-grid-outcome-transfer-native and the new file.
- Output: `<evidence>/track-l/tests/diff-base-head.txt`.

| set | before: pass / fail / skip | after: pass / fail / skip | passed → failed |
|---|---|---|---|
| node | 1023 / 48 / 0 | 1022 / 48 / 0 | 0 (see note) |
| storage-node-retire | 158 / 49 / 2 | 158 / 49 / 2 | 0 (identical per test) |
| root-room | 58 / 135 / 4 | 61 / 132 / 4 | 0; 3 fixed, the new tests |

- **Note on node.** The one difference is `interval-reconnect.test.ts`. In the "after" run it failed to load
  with "Failed to resolve entry for package @ts-drp/node". Most likely a test in the same run was building
  `packages/node/dist` at that moment: the dist's timestamps fall inside both node runs, and I did not
  build it myself until afterwards. Rerun alone at HEAD it passes 1/1
  (`tests/head-rerun-interval-root-room.log`).
- **Pre-existing failures.** Every other failure in the three sets fails identically at base. These are RED and
  governance files of other phases, plus two root files that fail to load for missing package entries
  (`@ts-drp/storage-node/room-head`, `@grpc/grpc-js`).
- **A hang that was not this change.** The first "after" root-room run (JSON reporter only) hung with idle
  workers after about 11 minutes, so I stopped it. A rerun with a verbose reporter completed normally. The
  hung log is kept at `tests/hung/head-root-room-hung-1.log`.

### 4.3 Typecheck and guards

- **`pnpm -r typecheck`** at 9379fc48: exit 0, 0 `error TS` (`<evidence>/track-l/typecheck-final2.log`).
  - Two dists had to be built first: node (`pnpm --filter @ts-drp/node build`, whose types storage-node
    imports) and network-spike (`pnpm --filter @ts-drp/network-spike build`).
  - Without the network-spike dist, `examples/network-spike` reports 71 module-resolution errors
    (`typecheck-final.log`). That is environmental, and none are in files this track touches.
- **`node scripts/check-shadowed-sources.mjs`**: exit 0.
- **Prettier.** The new test file and `creator-recipient-provenance.ts` are prettier-clean.
  `healthy-grid.ts` and `v3-room.ts` were not prettier-clean at base either; I left their formatting
  unchanged.
- **`git status`**: clean apart from the untracked `.logs/` bench inputs, which are not committed.

## 5. Grid benchmark

**Setup.**

- Scripts are in `<evidence>/track-l/bench/`: build.sh, run.sh, acceptance.sh, nolull-pair.sh, spans.py,
  compare.py and table.py. Runs are in `bench/run-<name>/` with `.log`, `.summary.txt` and `.spans.txt`.
- Two bundles:
  - `build-fix` is HEAD 504e4035, the fixes plus the harness change. 9379fc48 came after it and only adds the
    `!closed` guard on the resume's repair request. The runs never reach that request with the room closing,
    because reopen finishes long before the final close.
  - `build-final` is the final HEAD, 9379fc48. One LULL=1 run at 8 rollovers confirms it (acc-final-r8-lull).
  - `build-base` is packages/ and tests/fixtures/ at 1c6a8259, so the base harness still skips the final
    recipient lull (`bench/base-to-fix.patch`, `build-base.log`).
- Load average was 14–157 throughout (logged per run).
- Each cell is the maximum over roles for that transition. Close and reopen are split by role (C = creator,
  R = recipient).

### 5.1 Acceptance: skip removed, final recipient lull included

Every run passed, including persisted close, reopen and continued gameplay. "final recipient lull" is the
outcome of the lull after the last rollover, which the harness skipped before this track.

| run | env | result | test s | final recipient lull | seal mean / max | adopt mean / max | install mean / max | creator lull mean (t≥4) | recipient lull mean (t≥3) / final | close C / R ms | reopen C / R ms |
|---|---|---|---|---|---|---|---|---|---|---|---|
| acc-fix-r5-lull | LULL=1, 5 rollovers | passed | 65 | maintained | 265 / 511 | 471 / 617 | 347 / 405 | 2706 | 1000 / 1423 | 7.5 / 8.3 | 1084 / 963 |
| pair1-fix-r8-lull | LULL=1, 8 | passed | 66 | maintained | 238 / 370 | 453 / 613 | 368 / 586 | 2483 | 1163 / 1498 | 4.0 / 3.7 | 1164 / 1057 |
| pair2-fix-r8-lull | LULL=1, 8 | passed | 57 | maintained | 225 / 308 | 454 / 686 | 306 / 445 | 2188 | 1035 / 1190 | 2.7 / 3.1 | 905 / 833 |
| acc-fix-r12-lull | LULL=1, 12 | passed | 114 | maintained | 275 / 429 | 527 / 786 | 436 / 550 | 2640 | 1417 / 1725 | 7.5 / 8.3 | 1283 / 1143 |
| acc-fix-r8-concurrent | LULL=concurrent, 8 | passed | 87 | maintained | 283 / 405 | 571 / 776 | 372 / 422 | 2998 | 1331 / 1516 | 3.1 / 3.8 | 1155 / 1218 |
| acc-fix-r8-presentation-lull | PRESENTATION=1, LULL=1, 8 | passed | 68 | maintained | 261 / 454 | 488 / 674 | 366 / 522 | 2579 | 1186 / 1676 | 3.3 / 3.3 | 1195 / 1174 |
| acc-fix-r8-presentation | PRESENTATION=1 only, 8 | passed | 53 | no lull configured | 1376 / 2886 | 428 / 558 | 966 / 1755 | - | - | 0.9 / 0.6 | 528 / 790 |
| acc-final-r8-lull (bundle `build-final`, HEAD 9379fc48) | LULL=1, 8 | passed | 59 | maintained | 220 / 285 | 431 / 509 | 333 / 473 | 2191 | 1093 / 1372 | 2.8 / 3.6 | 976 / 915 |

Per-rollover costs (ms, max per transition):

```text
acc-fix-r5-lull
  seal     t0:166 t1:135 t2:219 t3:294 t4:511
  adopt    t0:340 t1:385 t2:474 t3:537 t4:617
  install  t0:343 t1:293 t2:309 t3:405 t4:384
  lull C   t1:0.3 t2:0.0 t3:3.7 t4:2547 t5:2865
  lull R   t1:0.9 t2:14 t3:814 t4:764 t5:1423
pair1-fix-r8-lull
  seal     t0:149 t1:128 t2:165 t3:258 t4:370 t5:278 t6:262 t7:292
  adopt    t0:306 t1:314 t2:480 t3:451 t4:494 t5:466 t6:496 t7:613
  install  t0:254 t1:263 t2:302 t3:352 t4:495 t5:379 t6:313 t7:586
  lull C   t1:0.2 t2:0.0 t3:3.6 t4:2134 t5:2296 t6:2473 t7:2681 t8:2833
  lull R   t1:0.6 t2:18 t3:712 t4:731 t5:1176 t6:1351 t7:1513 t8:1498
pair2-fix-r8-lull
  seal     t0:200 t1:116 t2:160 t3:236 t4:278 t5:264 t6:308 t7:241
  adopt    t0:686 t1:316 t2:377 t3:386 t4:424 t5:444 t6:526 t7:476
  install  t0:244 t1:286 t2:250 t3:280 t4:294 t5:303 t6:445 t7:348
  lull C   t1:0.2 t2:0.0 t3:3.1 t4:1784 t5:1993 t6:2308 t7:2566 t8:2290
  lull R   t1:0.7 t2:13 t3:618 t4:583 t5:1149 t6:1358 t7:1313 t8:1190
acc-fix-r12-lull
  seal     t0:175 t1:180 t2:201 t3:252 t4:429 t5:294 t6:290 t7:294 t8:281 t9:269 t10:338 t11:297
  adopt    t0:369 t1:413 t2:576 t3:447 t4:491 t5:511 t6:558 t7:553 t8:552 t9:541 t10:525 t11:786
  install  t0:306 t1:309 t2:375 t3:367 t4:392 t5:550 t6:500 t7:472 t8:448 t9:526 t10:449 t11:543
  lull C   t1:0.1 t2:0.1 t3:3.7 t4:2402 t5:2732 t6:2582 t7:2498 t8:2444 t9:2924 t10:2608 t11:2935 t12:2635
  lull R   t1:0.7 t2:15 t3:756 t4:653 t5:1350 t6:1353 t7:1486 t8:1483 t9:1500 t10:1464 t11:2399 t12:1725
acc-fix-r8-concurrent
  seal     t0:187 t1:148 t2:184 t3:284 t4:356 t5:369 t6:334 t7:405
  adopt    t0:456 t1:384 t2:501 t3:508 t4:776 t5:735 t6:592 t7:613
  install  t0:330 t1:339 t2:302 t3:350 t4:422 t5:422 t6:406 t7:408
  lull C   t1:0.2 t2:0.0 t3:1.2 t4:2625 t5:3316 t6:3246 t7:3255 t8:2545
  lull R   t1:1.5 t2:18 t3:705 t4:966 t5:1557 t6:1656 t7:1586 t8:1516
acc-fix-r8-presentation-lull
  seal     t0:134 t1:106 t2:147 t3:229 t4:378 t5:454 t6:317 t7:326
  adopt    t0:286 t1:294 t2:370 t3:447 t4:618 t5:674 t6:592 t7:627
  install  t0:234 t1:273 t2:263 t3:308 t4:420 t5:522 t6:450 t7:461
  lull C   t1:0.1 t2:0.0 t3:3.0 t4:2235 t5:2706 t6:2615 t7:2262 t8:3077
  lull R   t1:0.7 t2:12 t3:608 t4:814 t5:1231 t6:1378 t7:1411 t8:1676
acc-fix-r8-presentation
  seal     t0:149 t1:126 t2:221 t3:267 t4:2173 t5:2452 t6:2886 t7:2735
  adopt    t0:301 t1:309 t2:388 t3:452 t4:435 t5:476 t6:558 t7:504
  install  t0:252 t1:251 t2:259 t3:848 t4:1063 t5:1755 t6:1608 t7:1691
acc-final-r8-lull
  seal     t0:130 t1:116 t2:197 t3:243 t4:285 t5:269 t6:264 t7:258
  adopt    t0:274 t1:337 t2:425 t3:441 t4:460 t5:498 t6:501 t7:509
  install  t0:220 t1:274 t2:264 t3:322 t4:319 t5:322 t6:472 t7:473
  lull C   t1:0.1 t2:0.0 t3:3.7 t4:1856 t5:2276 t6:2338 t7:2240 t8:2246
  lull R   t1:0.8 t2:19 t3:650 t4:662 t5:1219 t6:1381 t7:1273 t8:1372
```

**The no-lull configuration.** The PRESENTATION-only run configures no lull, so retirement runs inline in seal
and install from t3/t4. That is why its seal is about 2.2–2.9 s and its install 0.8–1.8 s. My changes don't
cause this: a no-lull pair (5.2) shows the same costs at base.

### 5.2 Paired comparisons (base vs fix, interleaved)

**LULL=1, 8 rollovers, two interleaved pairs, mean of each side** (`bench/compare-pairs.txt`, compare.py). The
base harness skips the final recipient lull, so the comparison covers the transitions both sides ran.

| measure | base total ms | fix total ms | fix / base |
|---|---|---|---|
| sealing t0–t7 | 2092 | 1853 | 0.89 |
| creator adoption t0–t7 | 4257 | 3627 | 0.85 |
| recipient install t0–t7 | 2937 | 2698 | 0.92 |
| creator lull t1–t8 | 12574 | 11682 | 0.93 |
| recipient lull t1–t7 | 5884 | 5268 | 0.90 |
| recipient lull t8 (fix only; skipped at base) | - | 1344 | - |

No regression. The fix side is lower on every total, but that is load noise. None of these paths run code this
track changed: the resume runs only at reopen, and the close cancellation only during a close.

**Close and reopen after the final lull**, maxima per role, same four runs:

| | base pair1 / pair2 | fix pair1 / pair2 |
|---|---|---|
| persisted close, creator | 0.9 / 0.9 ms | 4.0 / 2.7 ms |
| persisted close, recipients | 0.7 / 0.7 ms | 3.7 / 3.1 ms |
| persisted reopen, creator | 1021 / 1069 ms | 1164 / 905 ms |
| persisted reopen, recipients | 436 / 398 ms | 1057 / 833 ms |

- The recipient reopen is about 0.4–0.6 s slower on the fix side. That is the resume (the original received
  reconstruction), which happens only because the final recipient lull now runs; at base that lull was
  skipped.
- The creator reopen is about 1 s on both sides in lull runs, against 0.5–0.6 s without a lull. This track
  does not touch the creator's reopen path, and I did not attribute that difference.
- The close grows by about 2–3 ms, because a lull's retained repair is now in flight to be cancelled.

**No lull, 8 rollovers, one interleaved pair** (`bench/nolull-pair.log`). This checks that nothing changed
when no final lull ran.

| | base | fix |
|---|---|---|
| result | passed | passed |
| seal mean / max | 1525 / 3120 | 1544 / 3310 |
| install mean / max | 1149 / 1940 | 1116 / 2095 |
| persisted close C / R | 0.9 / 0.6 ms | 0.8 / 0.6 ms |
| persisted reopen C / R | 566 / 507 ms | 603 / 476 ms |

Without a final lull the reopen does not resume, and close and reopen costs are the same on both sides. The
pair ran at load 29–157.

## 6. Residuals (not fixed here)

1. **A separate reopen refusal after four rollovers: RECOVERY_CERTIFICATE_UNPROVEN_ABSENCE.** This belongs to
   Track R3.
   - With `LULL_REOPEN_EPOCHS=4`, the last recipient lull is maintained at epoch 4. The recipient's durable
     reopen is then refused before any session code from this track runs: "v3 room successor reopen failed:
     internal-invariant: creator successor reopen failed unexpectedly" (v3-room.ts:4053).
   - The cause, from base instrumentation (`<evidence>/track-l/red-base-3.log`), is
     `RECOVERY_CERTIFICATE_UNPROVEN_ABSENCE`. It is raised under
     `acquireCreatorSnapshotRetirementReconstructionRequest` (CCRD ~1818-1879), which passes no
     `previousCertificate` to `captureSnapshotRetirementInventoryState` (CCRD ~1687).
   - It is unchanged at HEAD (`epochs-4-head.log`). The same test passes with 5 epochs (default) and with 8
     epochs at HEAD (`epochs-8-head.log`).
   - It fails closed (the room does not open). I did not fix it because it is inside the retirement
     reconstruction that R3 is rewriting. The Grid never hits it: the Grid's final lull is after 5, 8 or 12
     rollovers, all of which pass.
2. **An active retirement intent at recipient reopen still halts the recipient permanently, as at base.**
   - The resume discharges only a completed request (`active === null`, as the creator's completed resume
     requires). With an active intent it returns `"deferred"` before entry, and the plane stays halted.
   - The creator resumes an active intent through its close owner. A receive-only recipient has no equivalent.
   - No test or Grid run produced this state. A lull or install that crashes mid-intent could.
3. **Ingress that arrives while the reopened recipient is halted is dropped, then repaired.**
   - Moves arriving during the resume (roughly 0.4–0.6 s after reopen) are rejected, as for a halted creator.
     They are recovered by the post-resume `requestRetainedHistory()`, not queued FIFO as during a deferrable
     lull.
   - Correct, but in a real game a move sent in that window shows up one retained round trip late.
4. **A close that interrupts a reopened room's startup transition is recorded as a terminal failure.**
   - The recipient resume follows the creator rebase transition's established shape (v3-room.ts:5669-5689):
     a failure, including `assertSessionOpen()` finding the session closed before entry, sets
     `terminalFailure`. The bug 2 cancellation then does not apply to a retained send that is in flight during
     that same close.
   - The close itself still resolves. Only a strict transport counting publisher rejections would see a fault.
   - The Grid never closes during startup. Treating a pre-entry orderly close as a cancellation would have to
     change the creator rebase transition too, so I left both as they are.
5. **The resume makes a reopened recipient's startup about 0.4–0.6 s slower**, only after a lull completed a
   retirement at the current epoch (section 5.2). It is off the gameplay path.
6. **Pre-existing failure:** creator-ordinary-readiness-producer "uses the genuine same-head pair..." fails at
   base and at HEAD (`producer-base.log`).

## Files and functions touched

| file | functions |
|---|---|
| packages/node/src/v3-room.ts | import; retained publisher callback in `createV3RoomSessionOwned`; new recipient retirement resume block (after `maintainRecipientRecoveryPool`); diagnostics startup waiter |
| packages/node/src/v3-live.ts | recipient resolver installation; `runCreatorReceivedRecoveryMaintenance`; `creatorCloseRegistration` |
| packages/node/src/creator-adoption.ts | `runReceivedRecoveryTurnoverPasses` (input field); new `creatorRecipientRetirementResumeRequested`; `maintainCreatorRecipientRecoveryPool` |
| packages/node/src/creator-close.ts | `V3CreatorCloseRegistration.runReceivedRecoveryMaintenance` type |
| packages/node/src/internal/creator-closed-rollback-data.ts | `reconcileCreatorReceivedSnapshotRecoveryRoles` |
| packages/node/src/internal/creator-recipient-provenance.ts | `installCreatorRecipientResolver` type; `resolveCreatorRecipientRegistration` |
| tests/fixtures/startup-discovery/healthy-grid.ts | `runHealthyGrid` (`recipientLull`) |
| tests/recipient-lull-reopen-close-native.test.ts | new |
