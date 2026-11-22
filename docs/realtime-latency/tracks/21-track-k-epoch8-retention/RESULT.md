# Track K: recipient long-room journal retention (epoch-8 refusal)

Worktree: <worktree agent-a7dca3b495f91714f>/
Branch: worktree-agent-a7dca3b495f91714f (base de70325e)
Commits: see "Commits" at the end. Patch: scratchpad/track-k/fix.patch (git diff de70325e..HEAD).

Line numbers below are at base de70325e (cited as `base:`) or at the fix commit (cited as `fix:`).
`CCRD` = packages/node/src/internal/creator-closed-rollback-data.ts.

## 1. Reproduction

### Node level (deterministic, genuine SQLite/Keychain/canvas owners)

New test: `tests/recipient-long-room-journal-retention-native.test.ts`. It uses the same genuine
fixtures as the existing native recipient tests: one creator room and one receive-only recipient on separate
SQLite databases. Each epoch, the creator seals, exports, adopts, and the recipient installs the
successor through `receiveCreatorSuccessorAdoption`. After every epoch it reads the native journal
retirement image of both nodes:

- header scopes and rows;
- membership carriers;
- completed `throughEpoch`;
- completed protected scopes.

Run:

    node_modules/.bin/vitest run tests/recipient-long-room-journal-retention-native.test.ts \
      --exclude ".claude/**" --no-coverage --testTimeout=600000      # LONG_ROOM_EPOCHS=16 default, LONG_ROOM_VERBOSE=1 prints the census

Base sources (de70325e) are RED. The base sources ran in a copy-on-write clone of the worktree at
scratchpad/track-k/basetree, with storage dist rebuilt from base.

- **Recipient test, run without its per-install carrier assertion.** A copy,
  scratchpad/track-k/basetree/tests/recipient-long-room-red-symptom-native.test.ts, shows the reported symptom
  (log: scratchpad/track-k/regression-base-symptom.log).
  - The recipient journal grows by one header and two rows per epoch.
  - The completed protected set grows with room age.
  - The install after epoch 8 fails with `TypeError: journal retirement refused: malformed-input`
    (CCRD:19378, journal participant `prepareFence`).

  | after install of epoch | headers | rows | throughEpoch | protected | carriers |
  |---|---|---|---|---|---|
  | 4 | 5 | 9 | 2 | [0,1,2] | [] |
  | 5 | 6 | 11 | 3 | [0..3] | [] |
  | 6 | 7 | 13 | 4 | [0..4] | [] |
  | 7 | 8 | 15 | 5 | [0..5] | [] |
  | 8 | 9 | 17 | 6 | [0..6] (= 7, the limit) | [] |
  | 9 | refused: the next preparation needs 8 protected scopes |

- **Committed test as is.** The recipient test fails at epoch 1 on
  `recipient carrier at epoch 1: expected [] to include 0`: no recipient ever records a closed-membership
  carrier. The creator test fails at the seal after epoch 11 with
  `closed epoch retirement refused: native metadata source or phase changed`, a second, independent latent
  bug (section 2.4). Log: scratchpad/track-k/regression-base.log.
- **The creator's own journal at base** is already bounded through epoch 11: 8 headers, 6 rows, protected
  [k-3, k-2]. It leaks nothing.

### Grid benchmark

Bundle: `STARTUP_ENTRY=r8-source-binding pnpm exec tsx tests/fixtures/startup-discovery/build.ts <out>`.
The harness accepted only 4, 5 or 8 rollovers (healthy-grid.ts:304, r8-source-binding.pw.ts:166). Both now
accept 4, 5 or 8..32.

Base (de70325e code, harness range extended only), 10 rollovers, no lull:
**fails at `recipient-install-8:1`** (the 9th install) with `journal retirement refused: malformed-input`.
This happens on de70325e without any opt-in lull. Recipient install time was already climbing with room age:
258, 266, 273, 867, 1006, 1193, 1660, 1601 ms (t0..t7).

## 2. Root cause

### 2.1 Why the recipient's protected scopes grow

The live-journal fence takes a preparation `{throughEpoch, protectedScopes}`. Two rules bound the protected list:

- live-journal/src/retirement.ts:148-153 refuses more than `LIVE_JOURNAL_RETIREMENT_LIMITS.maxScopes`
  (= `AHE_BOUNDED_READ_LIMITS.maxObjectGenerations` = 7, retirement.ts:33-37) as `malformed-input`.
- The node builds the list monotonically (base: CCRD:19324-19335). It keeps every closed journal scope that
  is not a collectible prefix and is either above the prior `throughEpoch` or was protected before:
  "A later intent must never resurrect a permanently fenced old hole."

So a scope that is never classified collectible stays protected forever, and the list grows by one per epoch.
On a recipient, every closed scope was such a scope. Three independent leaks caused this; all three had to be
closed:

1. **Received certificate forced "unclassified replay" for the whole journal** (base: CCRD:21226-21231).
   - Every recipient install stores a received recovery certificate. When reconciliation finds one, it sets
     `unclassifiedReplay = true` unconditionally.
   - `prepareClosedJournalDetails` (base: CCRD:9632-9634) then treats the source as `incomplete`.
   - Every closed scope that is not a protected replay scope is retained as `source-coverage-incomplete`
     (base: CCRD:9718-9720).
   - The comment states the intent: "This first supported class does not classify installed or received
     replay closures."
   - The creator never stores a received certificate, which is why only recipients leak.
2. **Recipients never wrote a closed-membership carrier.**
   - A journal prefix is collectible only through `prepareClosedJournalMembershipPrefix` (base: CCRD:9359).
     It needs a native `closed_membership_bytes` carrier on the scope header, verified by
     `openCreatorCloseMembership` against an authenticated Cut from the current role proofs.
   - The creator records that carrier at close (creator-close.ts:4035-4064).
   - The recipient install path had no equivalent. Even with (1) fixed, every recipient scope fell through to
     `unclassified-prefix` (base: CCRD:9757), because the scope has non-local rows.
3. **The single received turnover pass was spent on a generation drain.**
   - Journal prefixes are suppressed whenever a generation source drains in the same pass (base:
     CCRD:19145-19149).
   - A fresh pass is requested only when more than 5 AHE generations remain (base: CCRD:20096-20099).
   - Membership authorities exist only for the closes in the current role window: current decision,
     predecessor, and source closures (CCRD:2473-2506). So scope k-3 is classifiable only at floor k.
   - On a recipient, the generation drain and the journal drain coincide at floor k, and no later
     maintenance happens inside that window, so scope k-3 is stranded forever.
   - The creator does not hit this. Its close-time maintenance and its later stage passes give the journal
     its own pass.

### 2.2 Is 7 the wrong bound?

No. The protected set is defined at BSL:251-255 (specs/bounded-storage-lifecycle/README.md): the current head,
two usable rollbacks, and bounded pending. The leak-free creator's journal holds exactly two protected closed
scopes, k-3 and k-2, at every epoch 8..16, which fits that definition; the fixed recipient now holds the same. 7 is far above the lawful steady state.
The refusal was correct, fail-closed behavior on a leak. No limit was changed.

### 2.3 Does the creator have the same latent issue?

Not the journal leak. The creator's journal is bounded at every epoch through 16:

- 8 header scopes (genesis plus k-6..k), 6 rows;
- completed protected epochs [k-3, k-2], throughEpoch k-2;
- carriers k-6..k-1.

### 2.4 Second latent bug found on the way: protected-hole order at the 9 -> 10 boundary (creator and recipient)

- Driving the creator further failed at the seal after epoch 11 with
  `closed epoch retirement refused: native metadata source or phase changed`.
- The cause is in the storage contract's `retirementPreparation` (packages/storage/src/snapshot-transfer.ts,
  base:1395-1430). It sorted protected snapshot holes by
  `JSON.stringify([epoch, anchor, digest, incarnation]).localeCompare`.
- That text order puts epoch 10 before epoch 9.
- The node builds the preparation in native image order. That is SQLite `ORDER BY epoch, anchor,
  manifest_digest`, the IndexedDB key order, and the numeric order of the live journal's own
  `scopeKey` (retirement.ts:132).
- So the stored active preparation was [10, 9] and the next pass passed [9, 10].
  `validateClosedEpochRetirementMetadataDomain` (packages/node/src/internal/closed-epoch-cleanup.ts:850-875)
  compares them with the order-sensitive `retirementEqual` and refuses.
- Every room hits this the first time its two protected snapshot holes straddle a decimal-digit boundary
  (9|10, 99|100, ...). The creator hits it at epoch 11; with the journal fix, recipients reach it too.

## 3. Fix

### 3.1 Changes

1. **Classify a received certificate's replay narrowly** (fix: CCRD:21237-21251).
   - A received certificate still sets `unclassifiedReplay` when either:
     - its generation consumers are not covered (`closedReceivedGenerationConsumersCovered`, the existing
       check); or
     - its own scope is not one of the authenticated protected role scopes (`closeUnion.snapshotScopes`).
   - When both hold, its single journal consumer, the replay of its own scope, is already kept by
     `closedJournalProtectedReplayScopes` as `replay-required`. It therefore no longer poisons every older scope.
   - `unclassifiedGenerationReplay` is unchanged.
2. **Record the recipient's own closed-membership carrier at install**:
   - creator-adoption.ts:1389-1394 calls `source.recordReceivedClosedMembership(offer.exactCanonicalCutValueBytes)`
     inside the held received gate, before turnover;
   - the new registration method is v3-live.ts:19254-19317 (`recordCreatorReceivedClosedMembership`), with the
     interface in creator-close.ts:513-516;
   - `captureCreatorCloseGraph` and `readCreatorClosedArchiveSource` accept a received, gate-frozen,
     unfolded plane.
   - It decodes the authenticated Cut and checks kind, objectId, epoch and previousAnchor against the scope.
   - It derives the close-set/history commitment from the recipient's **own** complete epoch graph
     (`deriveCloseSetHistoryCommitment`) and records only on exact equality of closeSetRoot, closeSetCount,
     historyRoot and historySize.
   - The carrier is encoded with `encodeCreatorCloseMembership`, as the creator does. The write is a CAS
     against the read native image.
   - Any mismatch or failure records nothing and returns false, so the scope keeps its old retention.
   - The carrier is evidence, never authority. Eligibility still requires `openCreatorCloseMembership` to verify
     it against a Cut that the current role proofs authenticate.
3. **One extra fresh pass when a generation drain suppressed collectible journal prefixes**
   (fix: CCRD:20097-20104).
   - It is requested only through the new `reconcileCreatorReceivedSnapshotRecoveryRoles` (fix:
     CCRD:21572-21590), which `runReceivedRecoveryTurnoverPasses` calls (creator-adoption.ts:931-940). That is
     the recipient's install and lull turnover.
   - The public `reconcileCreatorSnapshotRecoveryRoles` keeps its original 5-parameter signature and its
     forwarding, which two existing source-shape tests pin.
   - Creator paths never request the extra pass.
   - The extra pass is requested only when generations actually shrank in this pass
     (`postAheRows.length < source.rows.length`), so it cannot loop.
   - It runs inside the existing bound `maxPasses = 2 + signing epochs + 7`, so no new bound is introduced.
4. **Canonical numeric protected-hole order** in `retirementPreparation`
   (packages/storage/src/snapshot-transfer.ts, fix:1397-1410, 1439).
   - The order is numeric epoch, then code-unit anchor, digest and incarnation: exactly the native image
     order and the journal's order.
   - `retirementScopeKey` is kept for duplicate detection.

### 3.2 Guarantee argument

Checklist: scratchpad/track-r/GUARANTEES.md. The spec line numbers were re-verified in this worktree:
BSL:161-164, 182-187, 207-211, 240, 251-267.

- **G1, no growth with room age.**
  - The regression test asserts that from epoch 8 to 16 the recipient's and the creator's journal header
    count, row count and completed protected scopes are constant, and that every non-genesis header is younger
    than 8 epochs.
  - Recipient and creator now have the identical census at every epoch: 8 headers, 6 rows, protected
    [k-3, k-2], throughEpoch k-2.
  - Grid: per-rollover recipient install and lull costs are flat from t5 through t15 (section 5).
- **G18, protected set = head + two usable rollbacks + bounded pending + shared bytes.**
  - The journal's protected list in steady state is exactly the two closed scopes that the two usable rollbacks
    still reference (k-3, k-2).
  - A received certificate whose own scope is NOT among the authenticated protected role scopes, or whose
    generation consumers are not covered, still marks the whole source unclassified and retains everything,
    as before.
  - When it is covered, its scope stays protected as `replay-required` through
    `closedJournalProtectedReplayScopes`. If any protected role scope lacks replay coverage, the classifier's
    `incomplete` term still retains everything (base: CCRD:9632-9635).
  - BSL:240 "Unknown or over-budget debt remains held" is preserved: only a fully covered, authenticated
    received closure stops poisoning older scopes.
- **G21, bounded work with reviewed limits.**
  - No limit was changed: journal `maxScopes` = 7, AHE limits, and the `maxPasses = 2 + signing epochs + 7`
    turnover bound.
  - The extra fresh pass is requested only when the pass strictly reduced AHE generations
    (`postAheRows.length < source.rows.length`). It always pays with progress, so it cannot loop, and it stays
    inside the existing pass bound.
  - Carrier encoding is bounded by `maxEpochVertices` (`encodeCreatorCloseMembership`, the same encoder and
    bounds as the creator).
- **G7, one retirement owner.**
  - There is no new sweeper or decision path. Every deletion is still decided by
    `reconcileSnapshotRecoveryRoles` -> `installClosedRetirementSource` -> `applyClosedEpochRetirementIntent`.
  - The new recipient carrier is evidence only. Eligibility still requires `openCreatorCloseMembership` to verify
    it against a Cut that the current role proofs authenticate (CCRD:2473-2506). Epoch age, counts or labels
    grant nothing.
- **G9, transactional recheck.**
  - Participant `prepareFence`/`commitPrepared` are unchanged.
  - The carrier write is a native CAS against the image digest and control bytes just read, exactly as at creator
    close.
  - The recorder re-checks plane currency, gate, fold state and authorization around every await.
- **G14, one bounded resumable intent.**
  - Unchanged. The order fix makes the re-derived preparation equal the stored active one across a digit
    boundary. Before, resuming an intent whose protected holes straddled 9|10 was always refused.
- **G15, crash old XOR new.**
  - The carrier write is one native transaction. A crash before it leaves no carrier, and the scope is retained
    (retain too much). A crash after it leaves the carrier, and a later pass classifies the scope.
  - The drain flag only schedules passes; it carries no state.
  - Stored snapshot retirement controls are re-canonicalized on decode and compared as bytes. Only a room that
    already wrote a straddling active preparation in the old order could hold one, and every such room was
    already refused by this bug. That control now decodes as poisoned: it still refuses and never deletes.
- **G17, no resurrection.**
  - The monotone "previously protected or above prior throughEpoch" rule (CCRD:19324-19335) is untouched, so a
    fenced old hole is never re-protected or re-created.
  - The recipient carrier is written only for the scope closing now: epoch, objectId and previousAnchor must
    equal the live scope, inside the held received gate, on the current active plane, and CAS'd against the
    current image.
- **G26, latency never relaxes safety.** No safety check was relaxed for speed. The one classification change
  narrows an over-broad retention to the authenticated, covered case, and every unknown case still retains
  everything.

## 4. Tests

### 4.1 Regression test (16 epochs, recipient and creator)

The test is `tests/recipient-long-room-journal-retention-native.test.ts`. It has two tests and defaults to
16 epochs (`LONG_ROOM_EPOCHS`).

- **Recipient.** Each install must record the recipient's own carrier for the epoch it just closed. From
  epoch 8 on, the recipient's and the creator's journals must stay constant:
  - `throughEpoch === k-2`;
  - at most 2 protected scopes, all >= k-3;
  - every non-genesis header younger than 8 epochs;
  - header and row counts equal to the first steady epoch.
- **Creator.** Seals and adopts 16 epochs. The same journal bounds apply, which also exercises the 9|10
  protected-hole boundary.

It is GREEN at a00c0e91 (exit 0, 2 passed in 130 s, log scratchpad/track-k/regression-head.log) and again at
the final HEAD 53d1a43e (exit 0, 2 passed in 146 s, log scratchpad/track-k/regression-final.log). Neither run
hit a vitest worker error. Recipient census from the a00c0e91 run (creator columns identical from
epoch 5 on):

| epoch | headers | rows | throughEpoch | protected | carriers |
|---|---|---|---|---|---|
| 4 | 5 | 6 | 2 | [1,2] | [1,2,3] |
| 8 | 8 | 6 | 6 | [5,6] | [5,6,7] |
| 12 | 8 | 6 | 10 | [9,10] | [9,10,11] |
| 16 | 8 | 6 | 14 | [13,14] | [13,14,15] |

Base de70325e is RED, as described in section 1.

The earlier run of this test (scratchpad/track-k/run-fix1.log) printed
`Error: [vitest-worker]: Timeout calling "onTaskUpdate"` after both tests passed. The same worker-RPC
timeout also appears in the base run (regression-base.log), and it did not recur at HEAD. It is a
load-induced vitest infrastructure timeout, not a test outcome.

### 4.2 Before/after suite diff (node, storage, storage-browser, storage-node)

Method:

- Both runs use `vitest run packages/<pkg> --exclude ".claude/**" --exclude "**/.logs/**" --no-coverage
  --testTimeout=120000 --reporter=json`, with scripts at scratchpad/track-k/bin/suite.sh, suite-clone.sh and
  diff-tests.py.
- "after" ran on the worktree at d9f55ea9. "before" ran on the clone scratchpad/track-k/basetree, which holds
  de70325e versions of the 5 product files and a storage dist rebuilt from them.
- Both ran concurrently under heavy machine load. Reports are in scratchpad/track-k/tests/.
- The `packages/storage` filter also matches the storage-browser and storage-node files.

| package | before (pass / fail / skip) | after (pass / fail / skip) | new failures |
|---|---|---|---|
| storage (filter also matches storage-*) | 934 / 305 / 5 | 934 / 305 / 5 | 0 (identical per test) |
| storage-browser | 293 / 3 / 0 | 295 / 1 / 0 | 0 |
| storage-node | 360 / 319 / 5 | 375 / 304 / 5 | 0 |
| node | 1007 / 48 / 0 | 1003 / 47 / 5 | 2, both fixed in 53d1a43e (below) |

Notes on the differences:

- **The two new node failures** are source-shape guards on the public wrapper:
  - `creator-recovery-maintenance-job.test.ts` › "...leaves the public one-shot signature unchanged" expects
    `reconcileCreatorSnapshotRecoveryRoles` to have 5 parameters; d9f55ea9 added a sixth.
  - `creator-ordinary-readiness-producer.test.ts` › "forwards the exact optional readiness trust through the
    original public reconciliation wrapper" expects exactly 5 forwarded arguments.

  Commit 53d1a43e restores the wrapper byte-for-byte. The flag now enters through a dedicated recipient
  entry. A targeted rerun of these two files, plus creator-recipient-recovery-pool and
  creator-ordinary-settlement-capacity, passes both tests (log: scratchpad/track-k/targeted-after2.log). The
  same run still has 3 failures, all of which also fail at base:
  - creator-ordinary-readiness-producer "uses the genuine same-head pair...";
  - two creator-ordinary-settlement-capacity source-shape tests.
- **The 15 storage-node and 2 storage-browser tests that fail only in "before"** are not regressions:
  - The storage-node ones are multi-process, SIGKILL and custody tests, which are load- and timing-sensitive.
    The "before" storage-node file ran at load 22-55, the "after" one at 136.
  - The storage-browser ones are package-publication shape tests sensitive to the clone's build artifacts.
- **node `sync-state-heap-recharacterization-1o-f-ii-red.test.ts`** went from 3 failed + 2 passed to 5
  skipped. In "before", its heap workers failed with `ERR_MODULE_NOT_FOUND` (the clone's worker resolution);
  in "after", the file failed at suite level with no message, and its tests were skipped. It measures
  sync-state heap and imports nothing this change touches. A standalone rerun at HEAD (scratchpad/track-k/heap-after-rerun.log) gives exactly the base pattern: the same 3
tests fail with `ERR_MODULE_NOT_FOUND` for packages/node/dist/src/sync-state.js, because the worktree has no node
dist, and the same 2 pass. This is environmental, not a regression.

### 4.3 Typecheck

`pnpm -r typecheck` at 53d1a43e: exit 0, 0 `error TS` (log: scratchpad/track-k/typecheck-final.log).

The Grid harness has its own `tsc -p tests/fixtures/startup-discovery/tsconfig.json`, which sets noEmit. It
reports 123 pre-existing errors (unrelated: `.ts` import extensions, missing dist types); none are on lines
this change touches. The root `tests/` regression file is not in any typecheck project; vitest runs it.

## 5. Grid benchmark

Scripts are in scratchpad/track-k/bench: build.sh, run.sh, summary.py. Runs are under bench/run-<name>.

- Builds:
  - `fix1` is commit d9f55ea9.
  - `fix1-skip` is d9f55ea9 with the final-recipient-lull skip restored, which is what a00c0e91 commits.
  - `final` is HEAD 53d1a43e. Its product behavior equals `fix1-skip`; it only moves the fresh-pass flag to a
    dedicated entry.
  - `base1` is de70325e plus only the harness rollover-range extension.
- The machine was heavily loaded throughout, with load average 25-250 on 10 cores. Absolute milliseconds are
  noisy; look at the shape across rollovers.

| run | build | rollovers | lull | result |
|---|---|---|---|---|
| base-r10-nolull | base1 | 10 | no | **FAIL** at `recipient-install-8:1`: `journal retirement refused: malformed-input` |
| fix1skip-r10-nolull | fix1-skip | 10 | no | **PASS** (all assertions, persisted reopen and continued gameplay), 103 s |
| fix-r12-lull-skip | fix1-skip | 12 | yes, final recipient lull skipped | **PASS**, 111 s |
| final-r12-lull | `final` = HEAD 53d1a43e | 12 | yes, final recipient lull skipped | **PASS**, 120 s; every lull e4..e12 and recipient lull e4..e11 `maintained`; recipient install 260-620 ms and seal 130-440 ms, flat |
| final-r10-nolull | `final` = HEAD 53d1a43e | 10 | no | **PASS**, 82 s; all 10 rollovers, persisted reopen and continued gameplay; recipient install about 1.8-3.0 s from t5 on (no lull, so turnover runs inside install), no growth trend |
| fix-r16-nolull | fix1 | 16 | no | all 16 rollovers, reopen and continued gameplay ok; fails only `proofEventsTruncated` (harness proof-event observer cap of 50,000 at critical-observer.ts:297; about 3.8k events per rollover; not product) |
| fix-r16-lull | fix1 (skip removed) | 16 | yes, every rollover | all 16 rollovers ok; **every recipient lull e4..e16 `maintained`**, including e8..e16; fails later at `persisted-close` (see below) |
| fix-r12-lull | fix1 (skip removed) | 12 | yes, every rollover | same as r16: all lulls maintained; fails at `persisted-close` |
| fix2-r12-lull | fix1 plus harness join of the final repair | 12 | yes, every rollover | persisted close and reopen ok; times out in continued gameplay: recipients never admit the first live move |
| base2b-r5-lull | **de70325e** plus the same harness | 5 | yes, every rollover | **same timeout as fix2-r12-lull**: pre-existing, independent of room age and of this fix |

Per-rollover cost:

- Base without lull: recipient install climbed from 258 to 1660 ms through t6 (journal and protected set
  growing), then refused at t8.
- Fix without lull, fix-r16-nolull: recipient install is flat at about 1.6-2.1 s from t5 to t15. The
  seal is about 2.2-3.9 s, flat.
- Fix with lull, fix-r12-lull-skip and fix-r16-lull: recipient install is about 450 ms and the seal about
  340-390 ms, both flat to t15. The creator's lull is about 2.0-3.4 s per rollover from e4 on, also flat.
  Track R2 owns that cost.

### The recipient-lull skip

After the last rollover the skip is still needed, so I restored it with an accurate comment (a00c0e91).
Its epoch-8 reason is gone: with the skip removed, every recipient lull through e16 is `maintained`. Two
other failures remain, and neither depends on room age.

1. **Close race.**
   - A `maintained` recipient lull fires an unawaited `roomTransport.requestRetainedHistory()`
     (packages/node/src/v3-room.ts:6541-6544).
   - After the final lull, peers serve that request while the harness closes them. Their queued
     `republishRetained` finds the plane deactivated and fails with `not-active` (v3-live.ts:16304,
     v3-room.ts:3941).
   - The transport counts this as a join fault, so the persisted close fails.
2. **Reopen admission failure** (pre-existing; reproduced on de70325e at 5 rollovers).
   - I joined that repair before the close, test-only, by polling transport quiescence: variant at
     scratchpad/track-k/bench/healthy-grid.quiesce-variant.ts, not committed.
   - The close and the reopen then pass, and the world matches.
   - But no recipient ever receives or admits the creator's first continued-gameplay move: no delivery-branch
     events at all, and the test times out.
   - Unverified lead: a recipient lull that completes an AHE retirement leaves a completed control with
     `throughEpoch + 1 === currentEpoch`. On reopen that satisfies `creatorRetirementResumeRequested`
     (v3-live.ts:19170-19183), which makes `needsOrdinaryReadinessRecovery` true (v3-live.ts:19669-19672).
     In the healthy flow, only the next install clears it.
   - This belongs to recovery-pool maintenance (Track R2's area), not to the journal leak, so I did not fix it.

## 6. Residuals (not fixed here)

1. **A carrier is recorded only on exact close-set agreement.**
   - If a recipient's own epoch graph does not derive the Cut's exact close set, no carrier is written. That
     happens when the graph is missing a closed vertex, or holds one that the Cut excluded at the moment of
     install. The scope then stays protected under the monotone rule. This is fail-closed, never unsafe.
   - Eight such epochs over a room's life would bring the refusal back. A complete fix needs the close-set
     member order or digests delivered with the offer, so a recipient could build the carrier from the
     subset it holds. That is a protocol change, so I did not make it.
   - In the 16-epoch test and the Grid runs, every install recorded its carrier.
2. **Crash-recovery install paths do not record the carrier.** These are creator-adoption-recover and the
   resumed received turnover. A recipient that crashes between the received gate and turnover leaves that one
   scope permanently protected. Each such crash costs one of the 7 slots.
3. **Existing recipient stores are not repaired.** A recipient store that already accumulated leaked
   protected scopes before this fix keeps them: they are "previously protected" and never collectible,
   because their carriers and authorities are gone. A room already at the 7-scope ceiling stays refused, and a
   room below it keeps only the headroom it has left. A room already refused by the hole-order bug keeps a
   stored active preparation that now decodes as poisoned. Both fail closed and need an explicit,
   authenticated repair or migration (BSL:216-221, 236-241).
4. **The creator's journal never leaked.** The new fresh-pass flag is passed only by the recipient turnover.
   The creator's close-time and stage passes already give its journal its own pass.
5. **The final-lull failures in section 5 are pre-existing and out of scope.** The close race with the lull's
   unawaited retained repair, and recipients never admitting live moves after a lull and a persisted reopen,
   both belong to recovery-pool maintenance (Track R2). The second one breaks gameplay after a restart that
   follows a lull, which is a golden-path issue worth its own track.
6. **Harness proof-event cap.** The Grid harness caps proof events at 50,000
   (tests/fixtures/startup-discovery/critical-observer.ts:297). At about 3.8k events per rollover, 16-rollover
   runs trip `proofEventsTruncated`, so the harness's verified maximum is about 12 rollovers. I did not
   change the cap.

## Files touched

Product:

- packages/node/src/internal/creator-closed-rollback-data.ts: received-certificate replay classification;
  the fresh pass after a suppressed journal drain; the new `reconcileCreatorReceivedSnapshotRecoveryRoles`
  entry (the public wrapper is unchanged).
- packages/node/src/creator-adoption.ts: records the recipient carrier at install; the received turnover
  calls the received entry.
- packages/node/src/v3-live.ts: `recordCreatorReceivedClosedMembership`; received-gate support in
  `captureCreatorCloseGraph` and `readCreatorClosedArchiveSource`; registration wiring.
- packages/node/src/creator-close.ts: the `recordReceivedClosedMembership` interface member.
- packages/storage/src/snapshot-transfer.ts: numeric protected-hole order. The storage dist was rebuilt in
  the worktree; dist is untracked.

Tests and harness:

- tests/recipient-long-room-journal-retention-native.test.ts (new)
- tests/fixtures/startup-discovery/healthy-grid.ts: rollover range 4, 5 or 8..32; corrected skip comment.
- tests/fixtures/startup-discovery/r8-source-binding.pw.ts: the same rollover range, plus a comment.

Not touched:

- the main checkout;
- recovery-pool maintenance structure;
- any limit constant.

The worktree's untracked `.logs/bounded-storage-lifecycle/r8-warm-capacity-01/` (bench inputs) is not
committed.

## Commits

On branch worktree-agent-a7dca3b495f91714f (parent de70325e):

- d9f55ea9 fix: bound recipient journal retention and snapshot hole order past epoch 8
- a00c0e91 test: keep the final recipient lull skipped in the Grid bench, with the real reason
- 53d1a43e refactor: keep the public role-reconciliation wrapper signature unchanged

Patch: scratchpad/track-k/fix.patch (`git diff de70325e..HEAD`).
