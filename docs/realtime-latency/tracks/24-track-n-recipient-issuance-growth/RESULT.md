# Track N: a Writer recipient's issuance store grows with room age

Worktree: <worktree agent-aacbd4e4ceff4b065>/
Branch: track-n-recipient-issuance-growth (base 9ae59c2e, codex/phase3a1b-p6-golden-path)
Commits: see "Commits" at the end. Evidence: <evidence>/track-n/ (PROGRESS.md, logs/, grid/, tests/, bin/).

Line numbers are at HEAD unless cited as `base:`. Above line 20218 of v3-live.ts the two are identical.
`CCRD` = packages/node/src/internal/creator-closed-rollback-data.ts.

## Summary

- **Bug:** a Writer recipient kept every row it ever issued: its own moves and the settlement profile's author
  fences. Issued and outbox rows grew by 3 per epoch (26 at epoch 8, 50 at epoch 16), on both storage paths. The
  creator was flat. The leak is not only storage: at about 511 issued rows, the issuance owner's 1,024-row bound
  refuses the recipient's next move (section 2.6). That is about epoch 170 at Grid's rate, and epoch 24 at 20 moves
  per epoch.
- **Root cause:** the recipient's own retirement already classified those rows, and they were all published, paired
  and settled. The drain that the creator uses never ran on a recipient. `cleanupCreatorSettlementSuccessor`
  returned at its "cold material" guard before the issuance scan. The guard keys on a producer-private grant
  (`certifiedRecoverySourceGenerations`) that only the creator's own close, or a recipient's forward promotion,
  mints. A Writer recipient never closes, so from the second close on, every install returned there.
- **Fix:** one function, `cleanupCreatorSettlementSuccessor`. Cold material may now reach only the existing
  coordinated drain, and only when its own completed retirement decision matches the issuance control's
  completed decision, the same precondition the creator already uses. It then drains only rows that decision
  classified (admitted epoch at or below its `throughEpoch`) that are published. It reaches no generation or
  source reclamation. Warm (creator) material is unchanged.
- **Result:** the recipient is flat at 13 issued and 13 outbox rows from epoch 5 on, identical to the creator, in
  the node test, across lulls and a persisted reopen, and in 16-rollover Grid runs on both the default path and
  the room path.
- **Harness:** the Grid proof-event budget now scales with the configured rollovers (measurement only), so
  16-rollover runs pass `proofEventsTruncated === false`.

## 1. Reproduction

### 1.1 Node level

New test: tests/recipient-long-room-issuance-retention-native.test.ts (first `it`, committed RED in 60161b4a).

- Genuine SQLite, Ed25519, the Grid application (`createV3ZoneApplication`) and the
  `creator-trusted-settlement-v1` profile with ACL version 3, as the Grid bench runs.
- The creator and one Writer recipient each issue two moves per epoch, interleaved. Each move's signed rows reach
  the other peer before the next move. The profile adds one author fence per Writer per successor.
- Each epoch the creator seals and adopts. The recipient installs the successor from the creator's genuine export,
  served by the original signed material server over scripted native bytes.
- After each install it reads both peers' native issuance census: the bounded recovery image (issued and outbox
  counts, logical bytes), the pruning watermark and the outbox rows (pending count, oldest epoch, fences).
- From epoch 8 on, each peer must keep issuing, have no pending row, keep constant issued and outbox counts, and
  keep no row older than 8 epochs.

Run (LONG_ROOM_EPOCHS=16 is the default; LONG_ROOM_VERBOSE=1 prints the census):

    node_modules/.bin/vitest run tests/recipient-long-room-issuance-retention-native.test.ts \
      --exclude ".claude/**" --no-coverage

Base 9ae59c2e is RED (log: <evidence>/track-n/logs/red-base-16.log):

| after install of epoch | recipient issued / outbox | recipient watermark | recipient image bytes | creator issued / outbox | creator watermark |
| ---------------------- | ------------------------- | ------------------- | --------------------- | ----------------------- | ----------------- |
| 3                      | 11 / 11                   | null                | 11,111                | 7 / 7                   | 3                 |
| 5                      | 17 / 17                   | null                | 16,865                | 10 / 10                 | 6                 |
| 6                      | 20 / 20                   | null                | 19,742                | 13 / 13                 | 6                 |
| 8                      | 26 / 26                   | null                | 25,502                | 13 / 13                 | 12                |
| 12                     | 38 / 38                   | null                | 37,022                | 13 / 13                 | 24                |
| 16                     | 50 / 50                   | null                | 48,542                | 13 / 13                 | 36                |

Every recipient row is published (pending 0). The recipient grows by exactly 3 rows per epoch (two moves and one
fence) and its watermark is never set. These numbers match Track R3's 16-rollover Grid finding exactly (26 to 50
rows per recipient between adopted-8 and adopted-16).

### 1.2 Grid

Track R3's runs <evidence>/track-r3/grid/run-long16-base-1 (default path) and run-long16-room-1 (room path) show,
between adopted-8 and adopted-16 (<evidence>/track-r3/bin/growth_diff.py), for each of the three recipients:
issuanceOutbox and issuedRecords 26 to 50 rows, issuance image 32,960 to 55,616 logical bytes. Nothing else changes
row count on any client. Both of those runs fail the harness check `proofEventsTruncated === false` (section 5.1).

The paired base runs in section 5.2 reproduce this with the scaled budget, on both paths.

## 2. Root cause

### 2.1 Which rows

All of them are the recipient's own issued records, each with its outbox pair: its ordinary moves and its author
fences. No received record is stored in the issuance store. Every row is `published` (the recipient's outbox has no
pending row at any census) and paired (issued and outbox digests agree). Every row is settled: the creator's
settlement frontier for that author advances by 3 sequences per epoch (`terminalThrough` 3, 6, 9, ... in the trace,
<evidence>/track-n/logs/trace1.log). So no publication or acknowledgement fact is missing.

### 2.2 Where the recipient's drain stops

The only deleters of issuance rows are the native owners' `prunePublishedPrefix` and
`pruneAuthenticatedSettledPrefix` (packages/storage-node/src/internal/node-issuance-store.ts:1902-2060 and the
browser equivalent). On the settlement profile, both creator and recipient reach them only through
`cleanupCreatorSettlementSuccessor` (v3-live.ts:20218). `activateCreatorSuccessorLive` calls it at the end of every
successor activation (v3-live.ts:21002, base:20988): creator adoption and recipient install alike.

A temporary trace of that function (patch <evidence>/track-n/trace-instrumentation.patch, reverted; log
<evidence>/track-n/logs/trace1.log) shows the difference.

- **Creator, every epoch from closedEpoch 2 on:** `cut.recoveryRoles` is present and
  `certifiedRecoverySourceGenerations` is set ("certified": true).
  - At the adoptions of epochs 3 and 4 it has no completed retirement yet. It drains through
    `planClosedEpochCleanup` (the non-coordinated branch), with the watermark at 3, then 6.
  - From epoch 5 on, its AHE retirement control has a completed decision. The issuance control's completed decision
    matches it (same throughEpoch, decisionDigest and sourceProofDigest), with 6 to 9 protected holes.
  - The function then takes the coordinated branch (v3-live.ts:20528): it scans the outbox from the watermark, stops
    at the first hole, and calls `pruneAuthenticatedSettledPrefix`. The watermark advances by 3 per epoch.
- **Recipient, every epoch from closedEpoch 2 on:** the same cut, but "certified": false.

  - From epoch 4 on it has the same kind of completed, matching decision. For example, at epoch 5 it has
    throughEpoch 3, 9 holes, sameDecision true and sameSource true.
  - But it returned at the cold-material guard, base:20283-20290:

  ```ts
  // Cold material has no producer-private semantic role grant. Keep every
  // existing source until the next close reacquires its complete native proof;
  // signed role spelling alone must never authorize reclamation.
  if (
  	(Object.hasOwn(cutRecord, "recoveryRoles") || Object.hasOwn(cutRecord, "forwardPromotion")) &&
  	material.certifiedRecoverySourceGenerations === undefined
  )
  	return;
  ```

  The issuance scan (base:20457) is after this return. So no recipient row was ever drained. Before closedEpoch 2
  nothing was old enough anyway: the scan takes only rows admitted at or before `closedEpoch - 2`.

### 2.3 The missing fact

The missing fact is the one the guard keys on. `certifiedRecoverySourceGenerations` is a producer-private grant.
Only two things mint it:

- the creator's own close (creator-close.ts:4280 and 4408), carried into its adoption (creator-adoption.ts:2280);
- a recipient's verified forward promotion (creator-adoption.ts:1323, 1425, 2963, 3790, 4167).

A Writer recipient never closes and is not promoted in a healthy room. Its material is therefore always "cold". This
is the same shape as Track K, where a recipient lacked the close-membership carrier that only the creator's close
wrote.

The guard exists for source and generation reclamation: deciding which recovery sources and generations to retain
from signed role spelling alone. That reasoning does not apply to the issuance drain. The drain reads no source role.
It is authorised by the owner's own completed, classified retirement decision and by the native pruner's
transactional checks (section 3.2). The guard simply sits above both branches.

### 2.4 Not a spent turnover pass

The recipient's issuance classification does run. From epoch 4 on, every recipient install observed an issuance
control with `active: null` and a completed decision. That decision matched the AHE control's completed decision
(the trace's `issuance-control` lines). The classification
(`closedIssuanceProtectedRecordsForRetirement`, CCRD:19066-19111) had marked the old, settled, paired, published rows
as non-holes. Only the drain was unreachable.

### 2.5 Why the lull does not help

`maintainRecoveryPool` on a recipient completes its own retirement. That is the same decision the install already
observes, and it prunes no issuance. With lulls after every rollover the base recipient still holds 38 rows at epoch
12 and has never pruned (<evidence>/track-n/logs/reopen-base1.log). The Grid runs with LULL=1 grow the same way
(section 5.2).

### 2.6 Consequence: the leak ends in a refused move

The issuance owner bounds every unsigned postimage, and its retirement census, at
`ISSUANCE_RETIREMENT_LIMITS.maxRows` = 1,024 rows (packages/issuance-store/src/retirement.ts:28-31, 298-299 and
1431-1432). Those rows are lineages, issued rows, outbox rows and plans, so the cap is about 511 issued records.

A Writer recipient that never drains therefore stops being able to issue once it has issued about 511 rows in the
room:

- The census-bound probe (section 4.1) reaches that point at epoch 24, with 506 rows held. The recipient's next move
  is refused with `issuance-rejected: ... unsigned postimage exceeds row bound`.
- At the Grid's 3 rows per epoch, the same refusal would come at about epoch 170.

So the bug breaks gameplay (G2, G3), not only storage growth (G1). HEAD keeps the recipient at the same fixed window
as the creator.

## 3. Fix

### 3.1 Change (packages/node/src/v3-live.ts, `cleanupCreatorSettlementSuccessor` only)

Commits 94cef38a and af83570a:

1. Record the coordinated decision's `throughEpoch` next to its holes (`coordinatedThroughEpoch`, v3-live.ts:20263).
   It is set only on the existing path where the AHE control's completed decision and the issuance control's
   completed decision agree on throughEpoch, decisionDigest and sourceProofDigest, and no generation drain is
   pending.
2. Replace the guard's unconditional return (v3-live.ts:20288-20300):

   ```ts
   const coldRoles =
   	(Object.hasOwn(cutRecord, "recoveryRoles") || Object.hasOwn(cutRecord, "forwardPromotion")) &&
   	material.certifiedRecoverySourceGenerations === undefined;
   if (coldRoles && coordinatedIssuance === undefined) return;
   const classifiedThroughEpoch = coldRoles ? coordinatedThroughEpoch : undefined;
   ```

   Cold material without a matching completed coordinated decision still returns exactly as before.

3. For cold material, skip the two blocks that collect signed source references from `forwardPromotion` and
   `recoveryRoles` (v3-live.ts:20318 and 20331). They feed only `sourceRetention` and `planClosedEpochCleanup`, which
   cold material never reaches. Cold material is not certified, so it must not read role spelling at all.
4. In the outbox scan, cold material also stops at the first row admitted after the decision's `throughEpoch`, and
   at the first row that is not `published` (v3-live.ts:20496-20499).

For cold material, everything after that is the existing coordinated branch, unchanged:

- `frontier === undefined` (the no-settlement profile) returns, because `coordinatedIssuance` is set
  (v3-live.ts:20411-20412).
- Otherwise the settlement checkpoint is opened and checked against the cut. The scan stops at the first hole,
  at admitted epoch above `closedEpoch - 2`, and at the settlement frontier. It throws on any malformed or unpaired
  row.
- The coordinated branch (v3-live.ts:20528-20538) calls `pruneAuthenticatedSettledPrefix` and returns.
  `planClosedEpochCleanup` and `ahe.reclaimClosedEpoch` are never reached.

### 3.2 Guarantee argument

Spec: specs/bounded-storage-lifecycle/golden-path-guarantees.md (G1-G28), specs/phase-6b-bounded-pruning/slices/
01-issuance-retention.md (6B01).

- **G1, no growth with room age.**
  - Node test: from epoch 5 to 16 the recipient holds 13 issued and 13 outbox rows. Its watermark advances by 3 per
    epoch and its oldest kept row is 4 epochs old. That is identical to the creator.
  - The same holds across lulls and a persisted reopen (second test).
  - Grid, 16 rollovers, both paths: every recipient is flat at 13/13 rows from adopted-5 to adopted-16 (12,657 to
    12,665 logical bytes; the few bytes are decimal-width growth in sequence numbers), and nothing else changes
    row count (section 5.2).
- **G19, issuance retention keeps only paired, published, epoch-bound rows; pending or malformed rows block the
  owner with no writes.**
  - Every row cold material can drain has five properties:
    - its admitted epoch is at or below the coordinated decision's `throughEpoch`, so the decision classified it;
    - it is not one of that decision's protected holes;
    - its outbox row is `published` (checked in the scan, step 4);
    - its issued and outbox rows are byte-identical pairs (the scan throws on a mismatch, before any write);
    - it is settled: below the frontier's admission epoch or at or below its `terminalThrough`.
  - Classification adds that a non-hole is a row at or below `throughEpoch - 2`, covered by a signed settled
    census proof, paired with a published outbox row, outside every protected replay scope and absent from the
    physical journal (CCRD:19093-19105).
  - A pending row stops the scan. Nothing at or after it is drained, so a pending row is never deleted and never
    unblocked by age.
  - A malformed or unpaired row throws before any write. Activation then fails with "creator authenticated cleanup
    failed" (v3-live.ts:21008-21009), the same blocking the creator already has. Before this fix a recipient never
    read those rows, so a corrupt recipient row was silently kept instead of blocking.
  - The native pruner rechecks everything in one `BEGIN IMMEDIATE` transaction
    (node-issuance-store.ts:1910-2060):
    - lineage and watermark CAS;
    - the settlement plan permits pruning;
    - no protected retirement hole in the range (`assertIssuanceRetirementPruningAllowed`,
      packages/issuance-store/src/retirement.ts:1688-1701);
    - no inherited target;
    - every ordinal present once in both tables, with equal digests;
    - each preimage decodes to the scope, with epoch at or below `closedEpoch`;
    - exact delete counts, and the watermark update in the same transaction.
- **G18, protected set = head + two usable rollbacks + bounded pending work + shared bytes.**
  - Cold material touches no generation, source or snapshot. The coordinated branch has no generation effect, and
    `planClosedEpochCleanup` and `reclaimClosedEpoch` stay unreachable for it. The role-reference collection is skipped
    for it.
  - The scan stops at the first hole, at `closedEpoch - 2` and at the frontier. So the two epochs behind the current
    one, and every row of a scope that recovery or replay still protects, are kept.
  - Grid: the recipients' AHE, journal and snapshot stores are unchanged in row count from adopted-8 to adopted-16
    (36, 8 and 3 rows).
- **G7, one retirement owner; no sweeper; age, counts or labels are not deletion proof.**
  - There is no new deleter and no new decision. The decision is the recipient's own completed coordinated
    retirement. It is observed from the native controls and must agree between the AHE and issuance owners.
  - Epoch age only further restricts what the decision already allowed (`closedEpoch - 2` and `throughEpoch`). It
    never grants.
  - Role spelling is not read for cold material at all.
- **G9, transactional recheck.** Unchanged native owner (above). The scan's expected lineage and watermark go into
  the CAS. A concurrent change returns `ISSUANCE_RETRY_REQUIRED`, and nothing is deleted.
- **G15, crash: old XOR new; never deletion without the matching watermark.** One native transaction deletes both
  tables and moves the watermark. A crash before commit leaves the rows; a crash after leaves the new watermark. The
  drain is idempotent (the same-end retry is a no-op), and the next install recomputes it.
- **G17, no resurrection.** The watermark only advances (the CAS refuses an end at or below it). A pruned ordinal
  is never re-issued, because the lineage `next` is unchanged. After the persisted reopen in the second test, the
  census is identical, field for field, to the one before the close: no kept row is lost and no pruned row returns.
- **G21, bounded work, reviewed limits.** No limit was added or changed. The scan is the existing one: pages of 64,
  throwing past `maxEpochVertices * 3`. In steady state it drains 3 rows per install.
- **G26, latency never relaxes safety.** No check was relaxed. The new branch is the creator's existing coordinated
  drain with two extra stop conditions for cold material.

Unknown or unpaired rows still block (G19). Rows that the issuance rules keep are never retired: holes, pending rows,
rows newer than `closedEpoch - 2`, rows above the classified `throughEpoch`, and unsettled rows. No explicit bound
was needed. The rows are retirable by the existing rules; only the drain was unreachable.

### 3.3 Also affected: the creator with cold material

The guard keys on the material, not on the role. A creator whose adoption material lacked
`certifiedRecoverySourceGenerations` while holding a matching completed decision now also drains its classified
issuance prefix, under exactly the same restrictions. No test or Grid run produced such creator material. The safety
argument above does not depend on which role holds the material.

## 4. Tests

### 4.1 Track N tests (tests/recipient-long-room-issuance-retention-native.test.ts)

1. "a Writer recipient and the creator keep bounded local issuance through 16 successive successors" (RED on base,
   section 1.1). At HEAD it passes (<evidence>/track-n/logs/fix2-both.log):

   | after install of epoch | recipient issued / outbox | recipient watermark | recipient oldest kept epoch | creator issued / outbox | creator watermark |
   | ---------------------- | ------------------------- | ------------------- | --------------------------- | ----------------------- | ----------------- |
   | 4                      | 14 / 14                   | null                | 0                           | 7 / 7                   | 6                 |
   | 5                      | 13 / 13                   | 3                   | 1                           | 10 / 10                 | 6                 |
   | 6                      | 13 / 13                   | 6                   | 2                           | 13 / 13                 | 6                 |
   | 8                      | 13 / 13                   | 12                  | 4                           | 13 / 13                 | 12                |
   | 12                     | 13 / 13                   | 24                  | 8                           | 13 / 13                 | 24                |
   | 16                     | 13 / 13                   | 36                  | 12                          | 13 / 13                 | 36                |

2. "a Writer recipient whose settled issuance was retired keeps issuing with lulls across a persisted reopen"
   (eca9b1c2). It uses the Grid's LULL=1 order: gameplay, seal, adoption, install, census, then the creator's and
   the recipient's `maintainRecoveryPool`.

   - It runs 12 successors, asserts the recipient lull maintained, and asserts that the recipient had already
     pruned its own lineage.
   - It then closes and reopens both owners over the same SQLite databases and external floors. The reopened world
     and the recipient's issuance census must equal the pre-close values exactly.
   - 4 more successors with lulls follow; both peers keep issuing, and both stay bounded.
   - Base: fails, with 38 rows at epoch 12 and the watermark never set (<evidence>/track-n/logs/reopen-base1.log).
   - HEAD: passes. The recipient is flat at 13 rows from epoch 5 through 16 across the reopen
     (<evidence>/track-n/logs/reopen-fix1.log, fix2-both.log).

3. Census-bound probe (not committed: it takes about 9 minutes). <evidence>/track-n/probe/
   track-n-census-bound-probe.test.ts is the first test with 20 moves per Writer per epoch, over 30 epochs.
   - HEAD passes: the recipient keeps 85 rows from epoch 5 to 30 while issuing 632, identical to the creator
     (<evidence>/track-n/logs/probe-head-30.log).
   - Base fails at epoch 24, with 506 rows held, when the recipient's next move is refused with
     `unsigned postimage exceeds row bound` (<evidence>/track-n/logs/probe-base-30.log). See section 2.6.

### 4.2 Per-test suite diff against base

Method (scripts <evidence>/track-n/bin/suite.sh, base-suites.sh, swap.sh and vcompare.py; reports in
<evidence>/track-n/tests/):

- Both runs use `vitest run <set> --exclude ".claude/**" --exclude "**/.logs/**" --no-coverage --testTimeout=120000`
  with the JSON reporter, in this worktree.
- "HEAD" is af83570a. "Base" is the same tree with packages/node/src/v3-live.ts written from 9ae59c2e (`git show`),
  the only product file this track changes. It was restored afterwards.
- Sets:
  - node: `packages/node`.
  - storage-node retirement: retirement-image-cas, snapshot-recovery-retention-red, phase-6b-ahe-reclamation-red,
    phase-6b-issuance-retention-red, phase-3a1b-p4-node-live-journal-red, room-head-native.
  - root: Track R3's 92 root room and native files, which include Track K's and Track L's native tests,
    room-database-retirement-native and r9-grid-outcome-transfer-native, plus this track's test.
  - observer: the three startup-discovery observer unit tests.

| set                     | base (pass / fail / skip) | HEAD (pass / fail / skip) | new failures at HEAD                                                    |
| ----------------------- | ------------------------- | ------------------------- | ----------------------------------------------------------------------- |
| node                    | 1023 / 48 / 0             | 1023 / 48 / 0             | 0 (identical per test)                                                  |
| storage-node retirement | 158 / 49 / 2              | 158 / 49 / 2              | 0 (identical per test)                                                  |
| observer unit tests     | 23 / 0 / 0                | 23 / 0 / 0                | 0                                                                       |
| root                    | 676 / 338 / 24            | 669 / 345 / 24            | 9 in one file, all load artefacts (below); 2 fixed (this track's tests) |

- **Fixed at HEAD:** both Track N tests.
- **Track K, Track L, R3 and r9 native tests:** recipient-long-room-journal-retention-native,
  recipient-lull-reopen-close-native, room-database-retirement-native and r9-grid-outcome-transfer-native pass on
  both sides.
- **The 9 new root failures** are all in tests/d110c-0c1f5b0a-settlement-codec-red.test.ts:
  - 8 timed out at 120 s under load.
  - 1 failed with `ReferenceError: Cannot access '__vite_ssr_import_8__' before initialization` in
    packages/protocol-v3/src/anchor-trust-singleton.ts, a module-initialisation race.
  - The file is protocol-v3 codec and source-shape tests and does not reach the changed function.
  - Rerun alone:
    - base: 9 pass, 1 fail (codec-rerun-base.log).
    - HEAD, first run right after restoring the file: the same init-order ReferenceError on one test
      (codec-rerun-head.log).
    - HEAD, twice more: 9 pass, 1 fail, identical to base (codec-rerun-head2.log, codec-rerun-head3.log).
  - The remaining failure in both is the pre-existing "centralizes the settlement profile predicate", which
    reports `examples/v3-room/src/index.ts` as a missing consumer.
- **Everything else** in the root set fails identically on both sides: pre-existing RED, governance and environment
  failures, for example missing `@grpc/grpc-js` and `@ts-drp/storage-node/room-head` entries, and
  `ROLE_FROZEN_ARTIFACTS_AND_EVIDENCE_REQUIRED`.
- **Observer unit tests.** Both observer runs used the HEAD harness file; only v3-live.ts was swapped. A run with
  the base critical-observer.ts was not made: writing the base file over it was refused by the session's permission
  classifier. The default path is unchanged by construction: with no `__r8ProofEventBudget` global, the budget is
  the former literal 50,000.

### 4.3 Typecheck

- `pnpm -r typecheck` at HEAD: exit 0, 0 `error TS`, 46 projects (<evidence>/track-n/logs/typecheck-head.log).
- The Grid harness project, `tsc --noEmit -p tests/fixtures/startup-discovery/tsconfig.json`, reports 123 errors.
  That is the same pre-existing count Track K recorded (`.ts` import extensions, missing dist types). None is on a
  line this track touched (<evidence>/track-n/logs/tsc-harness-head.log).
- The root `tests/` files are not in any typecheck project; vitest runs them.
- `node scripts/check-shadowed-sources.mjs`: clean.

## 5. Grid at 16 rollovers

### 5.1 Harness: the proof-event budget scales with rollovers (8d00935d, measurement only)

- **Problem.** Each Grid frame realm kept at most 50,000 proof events (critical-observer.ts:297 at base), and the
  case asserts `proofEventsTruncated === false`. The creator's realm records a constant 3,730 events per rollover
  once steady (transitions 7 to 15; recipients 815). The cap therefore bounded the configured run length, at
  about 13 rollovers, rather than detecting growth. Track R3's 16-rollover runs failed this check at exactly
  50,000 events while every per-transition count was constant (<evidence>/track-n/bin/proof_events.py on
  <evidence>/track-r3/grid/run-long16-base-1).
- **Change.**
  - r8-source-binding.pw.ts sets a per-realm budget of `max(50,000, 4,000 x (rollovers + 1))` through a context init
    script, before any role frame loads. That is 50,000 for every existing 4, 5 and 8 rollover run, 68,000 at 16
    and 132,000 at 32.
  - critical-observer.ts reads the budget once at load; 50,000 stays the default and the floor.
  - healthy-grid.ts reports the budget each role observer used.
- **Why 4,000 per rollover.** It exceeds the steady 3,730. A constant per-rollover volume always fits, while a volume
  that grows with room age still exhausts the budget.
- **Checks kept.** The case still asserts `proofEventsTruncated === false` for the run and for every role observer.
  It also now asserts that every role observed with exactly the scaled budget, so a silent fallback to 50,000 fails.
- **Result.** At 16 rollovers the creator realm records 53,320 events on the default path and 53,372 on the room
  path (budget 68,000). Each recipient records 10,408 or 10,434. All six 16-rollover runs below pass the check.

### 5.2 Store counts per epoch, both paths

Builds: <evidence>/track-n/grid/build-base (v3-live.ts at 9ae59c2e, with the harness change) and build-fix2
(HEAD af83570a). Runs: `STARTUP_HEALTHY_GRID_ROLLOVERS=16 STARTUP_HEALTHY_GRID_POOL_LULL=1`, plus
`STARTUP_HEALTHY_GRID_ROOM_DATABASE=1` for the room path (<evidence>/track-n/bin/grid.sh). They were run as
interleaved pairs: base-default, head-default, base-room, head-room. All four pass the whole case: 16 rollovers
with lulls, persisted close and reopen, and continued gameplay.

Native issuance image (issued / outbox rows, logical bytes) at each measured checkpoint, from
<evidence>/track-n/bin/grid_table.py. The three recipients are identical at every checkpoint in every run.

| checkpoint         | base default: recipients | base default: creator | HEAD default: recipients | HEAD default: creator | base room: recipients | base room: creator | HEAD room: recipients | HEAD room: creator |
| ------------------ | ------------------------ | --------------------- | ------------------------ | --------------------- | --------------------- | ------------------ | --------------------- | ------------------ |
| adopted-1          | 5/5 (13,143 B)           | 5/5                   | 5/5 (13,143 B)           | 5/5                   | 5/5 (13,143 B)        | 5/5                | 5/5 (13,143 B)        | 5/5                |
| adopted-2          | 8/8 (15,972 B)           | 8/8                   | 8/8 (15,972 B)           | 8/8                   | 8/8 (15,972 B)        | 8/8                | 8/8 (15,972 B)        | 8/8                |
| adopted-3          | 11/11 (18,801 B)         | 7/7                   | 11/11 (18,801 B)         | 7/7                   | 11/11 (18,801 B)      | 7/7                | 11/11 (18,801 B)      | 7/7                |
| adopted-4          | 14/14 (21,632 B)         | 7/7                   | 14/14 (21,632 B)         | 7/7                   | 14/14 (21,632 B)      | 7/7                | 14/14 (21,632 B)      | 7/7                |
| adopted-5          | 17/17 (24,464 B)         | 10/10                 | 13/13 (12,657 B)         | 10/10                 | 17/17 (24,464 B)      | 10/10              | 13/13 (12,657 B)      | 10/10              |
| adopted-6          | 20/20 (27,296 B)         | 13/13                 | 13/13 (12,660 B)         | 13/13                 | 20/20 (27,296 B)      | 13/13              | 13/13 (12,660 B)      | 13/13              |
| adopted-7          | 23/23 (30,128 B)         | 13/13                 | 13/13 (12,663 B)         | 13/13                 | 23/23 (30,128 B)      | 13/13              | 13/13 (12,663 B)      | 13/13              |
| adopted-8          | 26/26 (32,960 B)         | 13/13                 | 13/13 (12,665 B)         | 13/13                 | 26/26 (32,960 B)      | 13/13              | 13/13 (12,665 B)      | 13/13              |
| adopted-9          | 29/29 (35,792 B)         | 13/13                 | 13/13 (12,665 B)         | 13/13                 | 29/29 (35,792 B)      | 13/13              | 13/13 (12,665 B)      | 13/13              |
| adopted-10         | 32/32 (38,624 B)         | 13/13                 | 13/13 (12,665 B)         | 13/13                 | 32/32 (38,624 B)      | 13/13              | 13/13 (12,665 B)      | 13/13              |
| adopted-11         | 35/35 (41,456 B)         | 13/13                 | 13/13 (12,665 B)         | 13/13                 | 35/35 (41,456 B)      | 13/13              | 13/13 (12,665 B)      | 13/13              |
| adopted-12         | 38/38 (44,288 B)         | 13/13                 | 13/13 (12,665 B)         | 13/13                 | 38/38 (44,288 B)      | 13/13              | 13/13 (12,665 B)      | 13/13              |
| adopted-13         | 41/41 (47,120 B)         | 13/13                 | 13/13 (12,665 B)         | 13/13                 | 41/41 (47,120 B)      | 13/13              | 13/13 (12,665 B)      | 13/13              |
| adopted-14         | 44/44 (49,952 B)         | 13/13                 | 13/13 (12,665 B)         | 13/13                 | 44/44 (49,952 B)      | 13/13              | 13/13 (12,665 B)      | 13/13              |
| adopted-15         | 47/47 (52,784 B)         | 13/13                 | 13/13 (12,665 B)         | 13/13                 | 47/47 (52,784 B)      | 13/13              | 13/13 (12,665 B)      | 13/13              |
| adopted-16         | 50/50 (55,616 B)         | 13/13                 | 13/13 (12,665 B)         | 13/13                 | 50/50 (55,616 B)      | 13/13              | 13/13 (12,665 B)      | 13/13              |
| reopened           | 50/50 (55,616 B)         | 13/13                 | 13/13 (12,665 B)         | 13/13                 | 50/50 (55,616 B)      | 13/13              | 13/13 (12,665 B)      | 13/13              |
| continued-gameplay | 51/51 (56,562 B)         | 14/14                 | 14/14 (13,611 B)         | 14/14                 | 51/51 (56,562 B)      | 14/14              | 14/14 (13,611 B)      | 14/14              |

- At HEAD, recipient issuance is flat from adopted-5 on (13/13, 12,657 to 12,665 B). That is the first steady
  epoch, and the recipients match the creator's 13/13 from adopted-6 on. Base grows by exactly 3 rows and 2,832 B
  per epoch on both paths.
- Persisted reopen keeps the HEAD census unchanged. Continued gameplay adds that game's one move per client.
- The physical stores agree. `growth_diff.py <run> adopted-8 adopted-16` on the HEAD runs (default path and
  room path) shows no row-count change in any store of any client; only byte-level noise in fixed-size rows (a few
  bytes in AHE blobs, journal scopes and the floor). On base, the only row-count changes are each recipient's
  issuanceOutbox and issuedRecords, 26 to 50.
- The two earlier HEAD runs at 94cef38a (run-long16-fix-default-1 and run-long16-fix-room-1, before the
  published-row stop) give the identical table.

### 5.3 Latency

There is no latency claim: this is one interleaved pair per path, at load 25 to 101.

Median recipient-install-inclusive over transitions t8 to t15 (<evidence>/track-n/bin/phase_medians.py):

| path    | base   | HEAD   |
| ------- | ------ | ------ |
| default | 522 ms | 360 ms |
| room    | 458 ms | 444 ms |

The creator adoption and the creator lull move both ways between runs. The recipient's extra cleanup at install is
one bounded scan and one native prune of 3 rows per epoch.

## 6. What remains, and risks

1. **Per-epoch issuance volume is capped for every Writer.** This predates the track; it is not a regression.
   - With the leak fixed, a Writer keeps about the last 4 epochs of its own rows: 4 x (moves + 1 fence) + 1. The
     current epoch's rows come on top while it plays.
   - The 1,024-row issuance bound (section 2.6) therefore caps any Writer at roughly 100 moves per epoch. That
     includes the creator, which has always had this cap.
   - Long epochs in a real-time game could reach it. Raising it, or draining the window faster, is a reviewed-limit
     decision (G21) that I did not make.
2. **Stores that leaked before this fix.**
   - A recipient below the bound drains its classified backlog on its next install. The probe and the tests show
     the backlog clearing in one install (17 to 13 rows at epoch 5).
   - A recipient already past the bound: its turnover census refuses ("issuance retirement census exceeds bound").
     Its last completed decision should still let this drain clear the rows that decision classified, after
     which retirement could resume. I did not test this, and a store whose last decision classified too little may
     stay refused. It would need an explicit, authenticated repair (BSL:216-221, 236-241).
3. **The cold creator path is untested** (section 3.3). No run produced creator adoption material without the
   certified grant together with a matching completed decision. The safety argument does not depend on the role.
4. **Track M (slice 14b, room path).**
   - The drain depends on the recipient's own completed AHE retirement decision and the issuance control's
     completed decision agreeing, as observed through `readRetirementControl` and `acquireRetirementControl`.
   - If 14b stops completing the issuance control, or completes decisions that differ, the cold path returns: it
     fails safe and retains everything, and the growth comes back on that path. After rebasing, Track M should
     re-run tests/recipient-long-room-issuance-retention-native.test.ts and a 16-rollover room-path Grid with
     LULL=1 (section 5.2's table).
   - Textual conflicts are possible only if 14b edits `cleanupCreatorSettlementSuccessor`.
5. **Room-path coverage is Grid-only.** The node tests run on the SQLite node host. The browser room database is
   covered by the genuine-IndexedDB Grid runs, not by a node-level test.
6. **The proof-event budget is empirical.** 4,000 per rollover is set from today's steady 3,730 creator events. If
   instrumentation adds per-rollover events, the truncation check fails loudly, and the budget, not the check,
   should be revisited.
7. **First drain timing.** The recipient first drains at epoch 5; the creator drains at epoch 3. The recipient's
   first completed decision appears at the epoch-4 install, and that scan stops at a hole. From epoch 6 on, the two
   windows are identical.

## Files and functions touched

Product (one function):

- packages/node/src/v3-live.ts: `cleanupCreatorSettlementSuccessor` (94cef38a, af83570a). No other function, no
  planner, no store, no limit.

Tests and harness:

- tests/recipient-long-room-issuance-retention-native.test.ts (new; 60161b4a, eca9b1c2).
- tests/fixtures/startup-discovery/critical-observer.ts: `proofEventBudget` (new export), and `proofEvent` uses
  it in place of the literal 50,000 (8d00935d).
- tests/fixtures/startup-discovery/healthy-grid.ts: the role observer reports `proofEventBudget` (8d00935d).
- tests/fixtures/startup-discovery/r8-source-binding.pw.ts: sets the scaled budget through a context init script,
  and asserts that every role observed with it (8d00935d).
- docs/realtime-latency/tracks/24-track-n-recipient-issuance-growth/RESULT.md (this file).

Not touched: the main checkout, the planner (`planClosedEpochCleanup`), the retirement classification
(`closedIssuanceProtectedRecordsForRetirement`), the native issuance owners, any RED or governance test, frozen
artifacts, registries, vectors and limits. The worktree's untracked
`.logs/bounded-storage-lifecycle/r8-warm-capacity-01/` (bench inputs copied from the main checkout) is not committed.

## Commits

On branch track-n-recipient-issuance-growth (parent 9ae59c2e):

- 60161b4a test: RED for a Writer recipient's local issuance growing with room age
- 94cef38a fix: let a Writer recipient drain its own classified settled issuance
- eca9b1c2 test: a recipient with retired issuance keeps issuing across lulls and reopen
- 8d00935d test(grid): scale the proof-event observer budget with configured rollovers
- af83570a fix: a cold recipient drains only published issuance rows
