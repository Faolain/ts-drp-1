# Non-blocking bounded-recovery retirement

## Problem

From t4 on, every creator close runs bounded-recovery turnover inline (`recoveryScopes >= 4 || resume || capacityMaintenance`, after `lifecycle = "sealed"`), costing 3.5–4.7 s. Recipients run the same engine during install (`prepareReceivedRecoveryTurnover`, 1.3–2.1 s). The work is needed, but nothing requires it inside the rollover. Prior art (RocksDB soft/hard write stalls, the Go GC pacer, CometBFT retain-height pruning) separates a **soft watermark**, which schedules work early off the critical path, from a **hard watermark**, which stalls only as a backstop.

## 1. Trigger: soft watermark, hard-cap backstop

- **Soft (new):** `creatorRecoveryPoolPressure` returns true when `recoveryScopes >= maxRecoveryScopes || generations > maxObjectGenerations - 2`. In words: the next close would have to turn over inline, or generation pressure would force its capacity drain. It is a scheduling hint only. It grants nothing; the original planner still classifies, authenticates and bounds every retirement.
- **Hard (unchanged):** close-time inline maintenance stays exactly as it is. If the soft path never runs (busy, unsupported, crashed or not called), the close does the same work it does today. Correctness never depends on the early path.

## 2. Where retirement can safely run

Early turnover at epoch E retires through cut E-1, the same work close E would do. It needs the same quiescent boundary that ordinary readiness maintenance already uses: `runCreatorOrdinaryReadinessMaintenance`. That boundary requires:
- no pending ingress, rebase, received transition, migration, terminal transition or bootstrap hold;
- an exact owner, trust and source binding;
- `blueprintClosing === entered`.

It then freezes admission (`blueprintClosing = true`), seals dependencies, runs `reconcileCreatorBoundedRecoveryMaintenance(..., requireClosedWorkflowCompletion)`, and joins every hold before reopening admission.

**Prototype API.** `V3RoomSession.maintainRecoveryPool(): Promise<{kind: "maintained" | "not-needed" | "deferred"}>`.
- It runs in the room's lifecycle FIFO, so it is serialized with seal, export and adopt.
- It sets an issue barrier, drains already-queued issues, and only then enters.
- The owner method does observational reads first (generation page, `recoveryStatus`). Without pressure it returns `not-needed` and touches nothing.
- It detaches the retained ordinary source and enrolls in `maintenanceJobs`, so the original maintenance consumer refuses concurrent quotes.
- After the join it recaptures the cold readiness source.
- It is gated on the same domain as readiness: `promotionContext`, no archive, a resource-bound reader, and epoch ≥ 3.

**Deferral, not halt.** The opt-in path passes `{deferrable: true}`. If the boundary is unavailable before the call, or changes while queued but before entry, it returns `deferred` without minting a hold, freezing admission or halting. After entry, the original semantics are unchanged: any change revokes, joins and halts. That is why callers must invoke the API only in a lull. A late remote append after entry is recovery work under the existing rule, not a new hazard.

**Idle auto-trigger (not prototyped).** An opt-in room idle timer (e.g. `requestIdleCallback` after N ms with no issue, ingress or rebase) can call the same API, which rechecks pressure and quiescence itself. Games know their lulls (loading screens, round ends) better than heuristics, so the explicit API stays primary.

## 3. Close-side resume-token fix

After an early turnover, the durable control reads `completed.throughEpoch = E-1` at epoch E. Under the original rule that is a boundary resume, so close E would rerun reconciliation and do a full second pass. `captureCreatorEarlyTurnoverToken` stores the exact canonical control bytes after the early job has fully joined. It requires a completed, idle control with domains and no pending `generationDrain`. `creatorCloseRetirementResumeRequired` skips the resume only when that token is for the same epoch and is byte-equal to the durable control. Pending reconciliation, a reconstruction receipt, an active intent, any other revision or sequence, or an undecodable control all still resume.

The token is process-local, so a crash falls back to the original durable rule. Consequence: a durable reopen at epoch E after early turnover finds `throughEpoch + 1 === E`, so activation halts admission with a resume request. Without a finishing window, the original `prepareOrdinaryReadiness` had no discharge path, and the Grid bench's persisted reopen failed ("readiness owner is unavailable"). The prototype now runs the original readiness maintenance whenever `needsOrdinaryReadinessRecovery()` holds at epoch ≥ 3, discharging the halt through the existing strict `completedResume` reconstruction. Pool pressure alone never enters this path. This also covers the pre-existing crash between a close's retirement and its seal.

## 4. Recipients (`prepareReceivedRecoveryTurnover`, creator-adoption.ts ~971-1034)

The recipient triggers on `recoveryScopes >= max || classifiedPresent`. Here `classifiedPresent` means the current cut, E-1, still names classified scopes that sit in local inventory. All of those inputs are current during epoch E, so turnover is decided by state alone, not by an epoch-relative resume, and an early run needs no token. Once the scopes are retired, the predicate is false at install. The work needed:

- A recipient boundary like the creator's: freeze recipient admission, call `sealReceivedRecoveryDependencies`-equivalent census, run `reconcileCreatorSnapshotRecoveryRoles`, and join. The install's own sealing is not tied to a received transition, so this needs a non-transition seal variant and signing-recovery custody (`createCreatorSigningRecoveryOwner`).
- No promotion handling: install releases/reacquires the received promotion around turnover; an early run has none yet.
- The same deferrable, issue-barrier `maintainRecoveryPool()` on recipient sessions.

## 5. Longer-term options

1. **Durable "retired ≤ N" record plus a time-sliced pruner.** Replace the epoch-relative resume inference with an explicit durable `{throughEpoch, decisionDigest, phase}` record. Run the native delete phase as bounded slices (k rows per task, yielding between slices) under a cursor in the retirement control. The `generationDrain` cursor and `residualImageDigest` already point this way. Removes the token and the reopen discharge pass, and bounds any single stall to one slice.
2. **Per-epoch stores.** Retiring an epoch becomes an O(1) store drop instead of authenticated row-by-row deletion; needs a schema migration and per-epoch IndexedDB lifetimes.
3. **Worker-hosted maintenance.** Run census, hashing and verification in a Worker (`worker-host` exists) with its own IndexedDB connection; the main thread only arbitrates admission. Cost: cross-realm row transfer and a single native exclusion owner.
4. **Trust own writes / verify once.** Most per-pass CPU goes to re-authenticating bytes this process wrote and already verified. Examples of the pattern are Bitcoin's signature cache and Kubo with `HashOnRead=false`. Cache verification results by (store incarnation, digest) inside one native exclusion. This is complementary: it shrinks the work wherever it runs.

**Security and proof accounting.**
- The early path calls the same planner, the same `reconcileCreatorBoundedRecoveryMaintenance`, and the same strict completion check. It cannot retire anything the close could not.
- `composeProspectiveCreatorMaintenancePrefixesForSizing` branches on `turnover.required`, which is read from actual durable state at quote time. After early turnover, the close's quote takes the no-preclose branch over the real post-turnover state, which is sound because:
  - no quote can straddle the turnover: the job detaches `ordinaryProofSource` and blocks the maintenance consumer, then recaptures after the join;
  - the token only removes a *resume* of already-completed work; it never removes a turnover the sizing still requires;
  - if the pool is full again, the close's inline trigger fires as before.
- For option 1, the durable record must carry the decision digest and source proof digest so reconstruction stays authenticated.
- For option 4, cache entries must be scoped to one native exclusion and incarnation, so that a foreign writer or a rollback cannot satisfy a cached verification.
