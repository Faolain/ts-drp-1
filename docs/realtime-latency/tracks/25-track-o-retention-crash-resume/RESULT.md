# Track O: crash and refusal resume on the room retention path (14f case 8)

- Worktree: `<worktree agent-a5e3fefad3208def1>/`, branch `worktree-agent-a5e3fefad3208def1`. Nothing was pushed.
- Base: Track M's branch `worktree-agent-a6747ca659c74d66c` at **07849f85** (on `codex/phase3a1b-p6-golden-path`
  at 5c6b949d).
- Working notes: `<evidence>/track-o/PROGRESS.md`. Logs: `<evidence>/track-o/logs/`. Suite reports:
  `<evidence>/track-o/tests/`. Native runs: `<evidence>/track-o/sub-14f/runs/`. Grid: `<evidence>/track-o/grid/`.
  Scripts: `<evidence>/track-o/bin/`.
- Guarantee ids (G1–G28) refer to the
  [golden-path guarantee checklist](../../../../specs/bounded-storage-lifecycle/golden-path-guarantees.md).
  `CRD` is packages/node/src/internal/creator-closed-rollback-data.ts. `SR` is
  packages/storage-browser/src/internal/signing-retirement.ts. Line numbers are at Track O's HEAD unless marked
  "base" (07849f85).

## 1. Outcome in brief

- **Fixed: a crash or a refusal between the transactions of one retention boundary now resumes.** This was Track M's
  14f case 8, and it restores G3 and G14 on the opt-in path. The next acquisition finds no unclassified signing
  dependency, maintenance continues, and the room reaches the crash-free end state. Nothing that blocks unknown
  material was relaxed.
- **There were two root causes, not one** (§4).
  - Track M's: D1 retired epoch e's evidence and completed the signing control past e, while e's summaries waited
    for D2.
  - New: Track M ordered the journal prefixes before the signing evidence, and the evidence classifier admits an
    epoch only while its prefix is collectible. A split between them strands e's evidence.
  - Both end the same way: a later AHE unit retires the generation that supplies e's trust, and the next
    acquisition halts on `UNCLASSIFIED_SIGNING_DEPENDENCY:e`.
- **Fix: option (b), with a 14b and 14e amendment committed first** (§5).
  - One decision per boundary.
  - One epoch's signing work (its evidence and its summaries) is one unit.
  - Units commit in the order snapshot, headers, signing by epoch, prefixes, AHE.
  - Continuations split only between units, so every committed prefix is a state that the next cold acquisition
    resumes from, with no durable resume record.
- **Option (a) cannot be made sound as a local change** (two counterexamples, §5.3). Option (c) needs (a)'s durable
  form and does not cover either split point.
- **The change is small.** Two functions in CRD and one condition in the storage-browser signing section, plus doc
  comments. Acquisition, every classifier and owner rule, the planner, step A and step B, and the existing path are
  unchanged.
- **RED tests (§3).** At base they fail at 3 of the creator's split points: D1 / D2, prefix / evidence and
  evidence / summaries. Each fails for a kill and for a refusal (stale, budget and capacity at D1 / D2; capacity at
  the other two). At Track O they pass at every split point the room has: creator and recipient, kill, and stale,
  budget and capacity refusals.
- **Native, real SIGKILL (§7).** The full 14f file passes on Chromium, Firefox and WebKit, case 8 included. Cases 5–8
  also pass at continuations 1–3 of a one-unit boundary; continuation 1 is epoch 3's whole signing unit, the rows
  that case 8 stranded at base.
- **Differential (§8):** retention still deletes a subset of what the existing planner deletes.
- **Suites (§9):** 0 new failures in node, root, sb, snr and obs against Track M's head. `pnpm -r typecheck`
  reports 0 errors.
- **Grid (§10).** 16 rollovers with the room database, retention and `LULL=1` pass. Every retention pass applies in
  one continuation, and recipient issuance stays flat at 13 rows per client.
- **No lull regression.** In a quiet interleaved pair, the creator lull is 549 ms against 601 ms for Track M's code
  (Track M reported 623 ms).

## 2. Commits

| Commit   | What                                                                                                              |
| -------- | ----------------------------------------------------------------------------------------------------------------- |
| c6eff8e7 | RED: crash and refusal between the transactions of one retention boundary (node level, fake-indexeddb)            |
| 96bc9b3c | Spec: 14b and 14e amendment. One epoch's signing work is one unit; signing evidence before its prefix             |
| 31a274fd | Fix: one retention decision per boundary; units in the amended order; the signing section accepts it              |
| a99d8abe | Native harness options: 14f death cases at any continuation, with an optional one-unit cap (additive)             |
| bc193d75 | Fix: rename the fix's new local `signingEpochs` to `unitEpochs` (a source-text test requires the name unique, §9) |
| a66a0dea | Tests: stale and budget refusals at every split point (coverage added after the fix; capacity was there)          |
| (this)   | This file                                                                                                         |

Every commit message ends with the requested co-author line. The spec commit was amended once, before the fix was
committed, to correct its message (§5.3).

## 3. Split points and their RED tests

### 3.1 Where one boundary spans more than one transaction

Enumerated from `applyRoomRetentionPass` (CRD:20870) and the plan built in `reconcileSnapshotRecoveryRoles`:

1. **Between decisions.** At base the creator's boundary had two decisions, D1 (snapshot, journal, signing
   evidence) and D2 (signing summaries, AHE, issuance) (base CRD:22426-22438). Each decision's continuations end
   with `session.checkpoint()`, which commits the room transaction. The fix removes this split point: the boundary
   is one decision.
2. **Between continuations of one decision.** The planner merges the longest prefix of the remaining units that
   fits the 512-write cap. On `RETENTION_CAPACITY` or an over-cap plan it halves `take`, down to one unit
   (CRD:20913-20927). Each continuation is its own step A (floor) and step B (room) and commits on its own. The
   units come from `roomRetentionItems` (CRD:20781): the snapshot turnover, each journal header, each journal
   prefix, each epoch's signing work, each AHE generation unit. Every pair of consecutive units is a possible split
   point.
3. **Between step A and step B of one continuation.** Step A commits the floor fence in the floor database; step
   B commits in the room database. Track M's 14f cases 5, 6 and 7 cover kills inside A, between A and B, and
   inside B (re-run here, §7). The budget and capacity refusal tests lower the bounds of step B only, so they refuse
   after the continuation's step A committed.
4. **Between passes of one boundary.** `applyRoomRetentionPass` can ask for another fresh pass. Each pass is a
   complete decision from a fresh acquisition, so a kill between passes is a kill after the last unit of a
   boundary.
5. **After a refusal.** Any refusal aborts the room transaction whole and calls `declined(...)` (CRD:20879). The
   same lull then runs the existing path from a fresh acquisition (`roomRetentionFallbacks`). That path's own
   transactions and resume forms are unchanged here.

Points 1 and 2 are where the boundary's committed prefix can be a state that the crash-free boundary never leaves.
The RED tests target them.

### 3.2 The RED tests

All on the browser room database host (`createBrowserV3RoomDatabaseStorageHost({ roomRetention: true })`) under
fake-indexeddb, with a FIFO Web Locks stand-in, like Track R3's and Track M's room-host tests. Each test brings a
room to a steady boundary (5 rollovers), interrupts the boundary under test, then reopens both rooms and runs 3
more rollovers. It asserts:

- no refused acquisition and no `UNCLASSIFIED_SIGNING_DEPENDENCY` (from the product's own proof events);
- the lull completes (`maintained`), or for a kill, the databases are unchanged since the kill;
- the same durable end state as the crash-free run: per-store row counts and the retired-but-present signing rows,
  which must be none.

A "kill" stops every later session call at the instant the transaction commits; the rooms are then closed and
reopened from the same databases. A refusal is a genuine owner refusal on the next transaction, which writes
nothing:

- stale: a foreign write moves the signing owner's control; it is restored after the abort;
- budget: step B runs with `maxChargedBytes: 0`;
- capacity: step B runs with `maxWrites: 0`.

The bounds are only ever lowered.

**Default caps** (`tests/track-o-room-retention-resume.test.ts`): the boundary as the product plans it.

**One-unit continuations** (`tests/track-o-room-retention-split.test.ts` for the creator,
`tests/track-o-room-retention-split-recipient.test.ts` for a recipient): every plan of more than one unit is
refused `RETENTION_CAPACITY`, so the node's own planner splits the boundary into one-unit continuations, and a kill
or a refusal can land between any two units. Each kill or refusal point is compared with the crash-free one-unit
boundary.

Composition of the boundary under test (printed by the reference tests):

| Boundary                            | Base (07849f85)                                                          | Track O                                                            |
| ----------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Creator, default caps               | D1 = snapshot + journal prefix + evidence(3); D2 = summaries(3) + AHE x2 | one transaction: snapshot + prefix + evidence + summaries + AHE x2 |
| Creator, one unit per transaction   | snapshot / prefix / evidence / summaries / AHE / AHE                     | snapshot / signing(3) / prefix / AHE / AHE                         |
| Recipient, one unit per transaction | snapshot / prefix / AHE                                                  | snapshot / prefix / AHE                                            |

Journal headers do not retire in this room's steady boundary, so the suite skips their split points (§11, risks).

**Results at base** (`<evidence>/track-o/logs/red-resume-2.log`, `red-split-1.log`):

| Split point (creator unless marked)                   | Kill                                                      | Refusal of the next transaction                                                              |
| ----------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| D1 / D2 (default caps)                                | **RED**: `UNCLASSIFIED_SIGNING_DEPENDENCY:3` after reopen | **RED** for stale, budget and capacity: `UNCLASSIFIED_SIGNING_DEPENDENCY:3` in the same lull |
| snapshot / journal prefix                             | green                                                     | green (capacity)                                                                             |
| journal prefix / signing evidence                     | **RED**: `UNCLASSIFIED_SIGNING_DEPENDENCY:3`              | **RED** (capacity), after reopen                                                             |
| signing evidence / signing summaries                  | **RED**: `UNCLASSIFIED_SIGNING_DEPENDENCY:3`              | **RED** (capacity), after reopen                                                             |
| signing summaries / AHE                               | green                                                     | green (capacity)                                                                             |
| AHE / AHE                                             | green                                                     | green (capacity)                                                                             |
| after the last AHE                                    | green                                                     | no later transaction                                                                         |
| recipient: snapshot / prefix, prefix / AHE, after AHE | green                                                     | green (capacity)                                                                             |

**Results at Track O's HEAD** (`<evidence>/track-o/logs/green-o-5.log`, a66a0dea, all three files at once:
43 pass, 60 skipped, 0 fail):

- Default caps (resume test): 5 of 5 pass. The boundary is one transaction, so after the evidence commits there is
  no later transaction of the boundary to refuse. The test asserts that the transaction also retired epoch 3's
  summaries.
- Creator, one unit per transaction: the reference, 6 kill points and 18 refusal points (6 points times capacity,
  stale and budget) pass. The kill points are after the snapshot, the signing unit (counted as both the evidence and
  the summary point), the prefix, AHE 1 and AHE 2.
- Recipient, one unit per transaction: the reference, 3 kill points and 9 refusal points pass.
- Skipped: the points this room's boundary does not have, which are journal headers and second occurrences.
- Earlier runs of the same tests: `green-o-2` and `green-o-3` (31a274fd), and `green-o-4` (stale and budget,
  a99d8abe code with the rename applied during the run).

## 4. Root cause

### 4.1 Summaries stranded in a retired epoch (Track M's finding 1)

- D1 retired epoch e's evidence and completed the signing control past e. The room signing section computes the
  new `protectedEpochs` without the section's evidence epochs (SR:1447), so e is no longer protected, while e's
  `signerState`, `voteOutbox` and `voteSlots` rows remain for D2.
- After a kill or a refusal of D2, no later pass selects those rows:
  - the retention summary selection takes only epochs whose evidence the same boundary retires
    (`roomRetentionSummarySelection`, CRD:20691);
  - the existing fresh summary rule needs the evidence drain of the same decision and floor (base CRD:10395).
- Passes do run at the same floor after the reopen (`<evidence>/track-o/logs/diag-events-1.log`, lines 53–54 and
  94–95: epoch 6 passes, the second retiring 15 AHE rows). The AHE unit then retires the generation whose closure
  supplies e's trust. The next acquisition finds e's signer rows with no authenticated material for e:
  `acquireSigningDependencies` throws `UNCLASSIFIED_SIGNING_DEPENDENCY:e` (packages/seal/src/creator.ts:775), and
  the creator's maintenance stops.

### 4.2 Evidence stranded behind its journal prefix (new)

- Track M ordered the journal prefixes before the signing evidence (base `roomRetentionItems`, base CRD:20770).
- The evidence classifier admits epoch e only while the journal prefix of e is collectible (base CRD:10588); the
  journal prefix is a gate on evidence reconstruction, not a source of it.
- A kill or refusal between the prefix continuation and the evidence continuation therefore strands e's evidence:
  it can never be selected again, e stays protected with its evidence and summaries, and a later AHE unit retires
  the generation that supplies e's trust. Same halt, `UNCLASSIFIED_SIGNING_DEPENDENCY:3`.
- This split point exists only when the cap splits a creator boundary (one-unit RED), not at default caps on the
  Grid. A room with a larger boundary reaches it.

### 4.3 Why per-transaction tests did not catch it

Old XOR new held for every transaction: each committed state was valid on its own. The failure is a durable state
that no crash-free run leaves and that no classifier reselects from. Track M flagged this risk class (its §14).

## 5. The fix

### 5.1 Spec amendment (96bc9b3c)

- 14b: one epoch's signing work, its whole evidence and its whole summaries, is one unit. Its summaries are the
  ones the existing fresh summary rule selects on the image that the same unit's evidence retirement leaves.
  "Evidence before summaries" is kept by atomicity: no committed state holds an epoch's evidence without its
  signer state, and none holds summary rows in an epoch the control retires that the crash-free boundary would
  have retired.
- 14b: a new dependency, "signing evidence for an epoch before, or with, the journal prefix of that epoch".
- 14b: units commit in the order snapshot, headers, signing by epoch, prefixes, AHE (issuance with every
  continuation, after AHE). Continuations split only between units, so every committed prefix is a state from which
  the next acquisition's classifiers select exactly the remaining units. A crash or a refusal between
  continuations is a resume, with no durable resume record. The boundary is one decision again.
- 14e: continuations split only between those units; a unit whose own plan exceeds the cap is not split, and the
  boundary keeps the existing path, as before.

### 5.2 Code (31a274fd)

- `reconcileSnapshotRecoveryRoles` (CRD:22437-22445): the boundary's plan is one decision. Its signing part names
  the evidence and `roomRetentionSummarySelection(...)` with the same inputs as base D2 (the same rows, the same
  verified evidence entries, the same trusts, journal details and `unclassified` flag). The edit is after the
  `transferRoles` declaration (CRD:21358), outside the source text that node tests evaluate (Track M finding 15).
- `roomRetentionItems` (CRD:20781-20803): units in the amended order. Each signing unit holds one epoch's
  evidence and summaries.
- `browserRoomSigningRetentionSection` (SR:1412-1429): a summary key is accepted when the current control already
  retires its epoch (as before) or when the same section retires that epoch's whole evidence. The existing census
  check (SR:1438-1445) then refuses unless every row of a summary epoch, its evidence included, is deleted in the
  same section, and every evidence epoch's evidence rows are all named. Each named row is still verified byte for
  byte against its classified frame digest (`verify`), signer state still needs both QCs, the dispatch-debt and
  monotone checks are unchanged.
- Doc comments only: `roomRetentionSummarySelection` (CRD:20682) and `RoomRetentionSigningSelection`
  (packages/storage/src/room-retention.ts).
- bc193d75 renames the new local in `roomRetentionItems` from `signingEpochs` to `unitEpochs` (§9).
- `tests/fixtures/track-o/split.ts`: a transaction counts as carrying a unit kind when its unit has rows of it, so
  the merged signing unit is still exercised as both the evidence and the summary split point. Without this the
  suite skipped those points rather than running them.

Not changed: acquisition, every classifier and owner rule, the planner and its cap, step A and step B, the
continuation loop, every refusal, `acquireSigningDependencies`, the existing path. Unknown signing material still
blocks.

### 5.3 Why not (a) or (c)

Option (a) lets D1 record the existing path's durable form so the existing resume applies. Line numbers are at
base.

- It leaves the journal-prefix / evidence split point (§4.2) as it is: no summary work is pending there.
- (a-i) D1 records the existing evidence drain. The next acquisition at the same floor takes the same-decision
  branch (`classifyClosedSigningEvidence`, CRD:10557). It reconstructs every drained entry and requires its bytes
  (`chain-invalid`, CRD:10603). Rebuilding entry e needs the prefix of e to be collectible (CRD:10588), and D1
  retired that prefix in the same transaction. The acquisition halts. This holds on the crash-free path too,
  whenever the drain record outlives D1.
- (a-ii) D1 stores the summary source. The install requires a resume-basis digest over every owner's post-state
  (CRD:19353, CRD:19360), which D1's signing section cannot compute inside its own transaction. While it is stored
  and undrained, D2's own signing section refuses `signing:summary-debt` (SR:1349 at base) and every signing writer
  refuses `SIGNING_MAINTENANCE_DEBT` (SR:186 at base; packages/seal/src/internal/signing-storage-codec.ts:464),
  so admission blocks until a pass at that floor drains it, and the retention path declines the room
  (`signing-summary`, CRD:20614-20616).
- Making (a) sound would need the prefixes moved out of D1 and a resume pass bound to the same floor: a larger
  change than (b), and still a second durable intent per boundary.

Option (c), `authenticateClosedSigningSummaryEpoch` (CRD:10237), runs only inside the existing stored
summary-source branch (CRD:10330-10345), so it needs (a-ii)'s durable form first. It also authenticates a residual
epoch only through an AHE closure that still carries e's support, which the next AHE unit retires (§4.1), and it
refuses any epoch that still has evidence rows, which is the §4.2 state. It fixes neither split point alone.

Correction recorded: the first version of the spec commit's message said no pass runs at the kill's floor after
the reopen. The diagnostic log shows passes do run there (§4.1). The message was amended before the fix was
committed (95fe7c0f became 96bc9b3c), and the (a) counterexamples above replace that argument.

## 6. Guarantee argument

Scope: the opt-in room path with `roomRetention: true`. The default host and R3's room host without the option run
none of this code.

- **G3, crash recovery.**
  - Claim: every committed prefix of a boundary's continuations is a state from which the next acquisition's
    classifiers select exactly the remaining units, so a crash anywhere resumes to the crash-free end state.
  - After the snapshot turnover (and headers): signing, prefixes and AHE are untouched; their classifiers do not
    read the snapshot rows they lost.
  - After epoch e's signing unit: e has no rows and the control retires it; no classifier has anything for e. The
    prefixes are still collectible (the journal classifier does not read signing rows), and the AHE generations are
    unchanged. The evidence of any later epoch e' is still admitted, because its prefix retires after it.
  - After a prefix: only prefixes and AHE remain, with the same inputs.
  - After AHE unit i: each later unit is the existing classifier's selection on the previous unit's post-image
    (Track M), so the next acquisition reselects it.
  - No AHE unit commits before every signing unit of the boundary, so the generation that supplies e's trust is
    retired only after e's signer rows are gone.
  - Tested at every split point this room has, kill and refusal, creator and recipient (§3.2, §7). Multiple
    evidence epochs in one boundary follow from the same order; this room retires one per boundary, so that case is
    argued, not exercised.
- **G14, one bounded resumable intent.**
  - One decision per boundary, as 14b states. No new durable record: the resumable intent is the boundary's own
    classification, re-derived by the next cold acquisition.
  - The continuations are ordered idempotent steps. A refusal writes nothing, and the next pass starts from the
    committed prefix (a resume, or the existing path after `declined`).
  - Step A still fences the floor once per continuation before any room write; the floor leads and never lags
    (14c; cases 5–8).
  - Bounded: one continuation per unit at most; units are bounded by the owner bounds.
- **G15, old XOR new.**
  - Each continuation is still one strict room transaction (R3's session), all or nothing. The change only moves
    e's summaries into the transaction that retires e's evidence.
  - Never delete too much: summaries are accepted only for an epoch whose whole evidence the same section retires
    or the control already retires. The census then requires every row of that epoch to retire in the same section,
    each named row byte-exact against its classified frame. Nothing that the existing rule keeps is deleted
    (differential, §8).
- **G19 and G26, unknown material blocks; latency never relaxes safety.**
  - `acquireSigningDependencies`, the classifiers and every acquisition check are unchanged. The next acquisition
    still refuses on unclassified signing rows. The fix removes the durable state that produced them; it does not
    tolerate them.
  - The section's summary check now admits the same-section case. This is not a relaxation: the epoch's evidence
    retirement is committed in the same transaction, the summaries are those the existing fresh summary rule
    selects on that post-evidence image (`roomRetentionSummarySelection`, unchanged), and the census forces the
    whole epoch. A partial selection still refuses `signing:summary-census`.
  - Issuance (G19's rows) is unchanged: same section, same order (after AHE).
- **G7, one decision owner.** Every deletion is still decided by `reconcileSnapshotRecoveryRoles` from the existing
  classifiers on one cold acquisition. No sweeper, no age or label rule.
- **G9, transactional recheck.** Each owner section still re-reads its image in the same transaction and checks
  exact frame digests and controls (unchanged).
- **G17, no resurrection.** The signing control's monotone rule is unchanged (`monotone`,
  packages/seal/src/internal/signing-storage-codec.ts:163). The new control retires the same epochs as base D1 then
  D2 together.
- **G21, bounded work.** The 512-write cap, census bounds and charges are unchanged. A signing unit is larger than
  either base half (evidence plus summaries of one epoch). If one epoch's signing unit exceeds the cap, the planner
  declines `unit-over-cap` and the existing path runs (risk, §11).
- **G22, proof budget.** Unchanged: each section charges its whole image in each continuation; no refund.
- **G1, no growth with room age.** The Grid's per-boundary write count (45–46) and recipient issuance (13 rows per
  client) are flat over 16 rollovers, and 14f case 11 (the long room's bounds, 16 epochs) passes (§7, §10).
- **G28, native evidence.** Real SIGKILL on Chromium, Firefox and WebKit. That covers the full 14f file, and cases
  5–8 at three one-unit continuations, including the signing unit that case 8 stranded at base (§7).

## 7. Native evidence (14f)

**Harness.** Track M's harness, `tests/fixtures/track-m/native/` (its §8), with two additive options from a99d8abe.
Both default off.

- `TRACK_O_14F_CONTINUATION=k` aims the death cases at continuation k.
- `TRACK_O_14F_ONE_UNIT=1` refuses `RETENTION_CAPACITY` for any plan of more than one unit in the creator's room
  sessions. It is applied through a `beforePlan` hook, so the node's own planner splits the boundary into one-unit
  continuations.

The cases are unchanged: real SIGKILL of the child's process group, old XOR exact new in the room and floor
databases, floor never lagging, and replay converging to a crash-free reference run with the same options. The
floor-shape check counts one step A (prepare and commit) per continuation up to the target. Run with
`<evidence>/track-o/bin/f14-chain.sh` (wrapper `bin/pw.sh`); table by `bin/f14_table.py`, unit contents by
`bin/f14_units.py`.

Engines: Chromium 151.0.7922.34, Firefox 153.0, WebKit 26.5.

**Full file, default caps** (`<evidence>/track-o/sub-14f/runs/o-full-{chromium,firefox,webkit}-01`):

| Case                                                                            | Chromium | Firefox  | WebKit   |
| ------------------------------------------------------------------------------- | -------- | -------- | -------- |
| Smoke (steady lulls apply on native IndexedDB)                                  | pass     | pass     | pass     |
| 2, refusal at the last request                                                  | pass     | pass     | pass     |
| 2, native abort                                                                 | pass     | pass     | pass     |
| 3, serialisation and stale owner writers                                        | pass     | pass     | pass     |
| Crash-free reference for 5–8                                                    | pass     | pass     | pass     |
| 5, SIGKILL inside step A                                                        | pass     | pass     | pass     |
| 6, SIGKILL after A, before B                                                    | pass     | pass     | pass     |
| 7, SIGKILL inside step B                                                        | pass     | pass     | pass     |
| **8, SIGKILL after B, before the caller observes**                              | **pass** | **pass** | **pass** |
| 11, long room, 16 epochs (Chromium, `TRACK_M_14F_LONG=1`, `o-long-chromium-01`) | pass     | not run  | not run  |

At default caps the creator's boundary is one continuation of 5 units and 38 writes (Track M: two decisions). Case 8
therefore kills after the whole boundary has committed. The room and floor are exactly "new", and replay matches the
reference at epochs 6 and 7.

**One-unit boundary, cases 5–8 at continuations 1, 2 and 3** (`o-unit{1,2,3}-{engine}-01`, each with its own
crash-free one-unit reference). Every cell passes on all three engines:

| Target continuation (one unit)                                                               | Writes | Case 8 room / floor | Reference, 5, 6, 7, 8 (Cr / Ff / Wk) |
| -------------------------------------------------------------------------------------------- | ------ | ------------------- | ------------------------------------ |
| 1: epoch 3's signing unit (1 `sealEvidence`, 1 `signerState`, 2 `voteOutbox`, 2 `voteSlots`) | 6      | new / new           | pass / pass / pass                   |
| 2: journal prefix of epoch 3 (2 accepted entries, scope rewrite)                             | 3      | new / new           | pass / pass / pass                   |
| 3: first AHE unit (1 generation, 7 promotions, 1 blob)                                       | 10     | new / new           | pass / pass / pass                   |

- Continuation 1 is the unit whose rows case 8 stranded at base: Track M's D1 committed `sealEvidence` 3, and D2's
  `signerState`, `voteOutbox` and `voteSlots` rows for epoch 3 were left. Here they commit together.
- A SIGKILL just after that unit, before the journal prefix (case 8 at k=1), converges.
- A kill after the prefix (k=2) and after the first AHE unit (k=3) also converges.
- The floor's revision advanced by 2(k+1) in every "new" floor case, one step A per continuation.

Source: the full-file Chromium and Firefox runs used a99d8abe's code (bundled-source digest `3e0d7b33…`). Every
other run used the code with the bc193d75 rename (digest `5317c763…`). The rename is a local variable name only.
The tree was dirty only with untracked files outside the bundle (this file and the bench inputs) or, for the
WebKit full run, the uncommitted rename.

Not re-run here: cases 1 and 4 (properties of R3's session, unchanged) and case 9 (14d, open), as in Track M.

## 8. Differential

Track M's differential (`tests/track-m-room-retention-differential.test.ts`, 3 tests: a 16-epoch room and seeded
random histories with skipped lulls, lull order changes and a persisted reopen) and the settlement differential
(`tests/track-m-room-retention-settlement.test.ts`, 2 tests) pass at Track O's fix
(`<evidence>/track-o/logs/pins-1.log`, 31a274fd code).

- At every lull, a plan-only probe plans the boundary's first decision from the same acquisition in a discarded
  room transaction, and the existing planner then runs. The rows the decisions name must be a subset of the rows
  the existing planner deletes (`unsafe` empty), and the issuance holes must be equal.
- The probe's first decision is now the whole boundary, so its planned signing section names e's summaries next to
  e's evidence. The probe asserts it plans without a refusal, so the signing section accepts the combined unit at
  every lull, and every named summary row is one the existing planner deletes in the same lull.
- Result: retention still never deletes a row the existing planner keeps.

The other tests run with the fix (same log, 48 of 48 pass): Track M's bounds (7), long-room (1) and trust (21) tests,
Track N's `tests/recipient-long-room-issuance-retention-native.test.ts` (2), Track K's
`tests/recipient-long-room-journal-retention-native.test.ts` (2), Track L's
`tests/recipient-lull-reopen-close-native.test.ts` (3) and `tests/recipient-lull-reopen-four-epochs-native.test.ts`
(3), and R3's `tests/room-database-retirement-native.test.ts` (4). The run reported one vitest RPC timeout
(`Timeout calling "onTaskUpdate"`) as an unhandled error under load, with no test failure.

## 9. Suites and typecheck

Recipe: Track M's (§9 there). Vitest from the repository root with `--exclude ".claude/**" --no-coverage` and a JSON
report per set (`<evidence>/track-o/bin/suite.sh`), compared per test with `<evidence>/track-n/bin/vcompare.py`
against Track M's own reports at its head. storage and storage-browser dist were rebuilt after the fix
(`logs/pkgbuild-3.log`). A test that timed out or whose `beforeAll` timed out under load was rerun alone.

| Set                                     | Track M (07849f85 code) passed / failed | Track O passed / failed | New failures | Track O report                                 |
| --------------------------------------- | --------------------------------------- | ----------------------- | ------------ | ---------------------------------------------- |
| node (packages/node)                    | 1023 / 48 (`head4-node`)                | 1023 / 48               | 0            | `tests/head2-node.json` (bc193d75), plus rerun |
| root (Track N's root set, 188 files)    | 678 / 336 (`head4-root`)                | 678 / 336               | 0            | `tests/head1-root.json` (a99d8abe), plus rerun |
| sb (storage-browser and storage)        | 621 / 4 (`head2-sb`)                    | 624 / 1                 | 0            | `tests/head1-sb.json`                          |
| snr (six storage-node retirement files) | 158 / 49 (`head3-snr`)                  | 158 / 49                | 0            | `tests/head1-snr.json`                         |
| obs (startup observation files)         | 23 / 0 (`head2-obs`)                    | 23 / 0                  | 0            | `tests/head1-obs.json`                         |

- **node, first run: 351 tests did not run.** At 31a274fd, `creator-closed-rollback-proof-accounting.test.ts`
  failed to load with `PRIVATE_STATEMENT_NOT_UNIQUE` for `signingEpochs` (`tests/head1-node.json`). The test takes
  CRD's source text and requires that variable declaration to be unique; the fix's new local in
  `roomRetentionItems` had the same name (Track M finding 15's class). bc193d75 renames the local `unitEpochs`
  with no behaviour change. The file then runs its 351 tests with Track M's per-test results (331 / 20), and the
  full node set at bc193d75 has 0 new failures. `<evidence>/track-o/bin/namecheck.py` compares the whole-word
  counts in CRD of every identifier that the node and root tests look up by name: the only other differences are a
  comment word and the removed `Object.freeze`, `push` and `length` uses of Track M's two-decision code, and no test
  that looks those up fails.
- node, second run: the 5 tests of `sync-state-heap-recharacterization-1o-f-ii-red.test.ts` were skipped because
  their `beforeAll` (a production build with a 30 s timeout) timed out at load 90. Alone
  (`tests/head2-node-heap-rerun.json`): 2 pass and 3 fail, as on Track M's head.
- root: 9 tests of `d110c-0c1f5b0a-settlement-codec-red.test.ts` timed out at load 78. Alone
  (`tests/head1-root-d110c-rerun.json`) all 9 pass; the file's tenth test fails on both trees.
- sb: 3 tests that fail on Track M's report pass here (`corrective-clean-checkout-red`, `phase-2g-b-presence-red`,
  `phase-2g-b-admission-red`): packaging and clean-checkout gates that depend on the environment, not on this
  change.
- The same load-error files fail to load on both trees (node: `creator-ordinary-generation-closure-capacity`,
  `proptest/spawn-scaling`; root: `protected-recovery-role-node-red`, `r11-real-game-terminal-native`,
  `r9-rpc-v3-room-native`).
- `pnpm -r typecheck`: exit 0, 0 errors, at a99d8abe (`logs/typecheck-1.log`) and at a66a0dea
  (`logs/typecheck-2.log`). `node scripts/check-shadowed-sources.mjs`: exit 0.
  Prettier: the new test files and Track O's edits to Track M's native harness are formatted. CRD and SR were not
  prettier-clean at base, so they were not reformatted (reformatting would change the source text that tests read).

## 10. Grid run and lull

**16 rollovers** (`<evidence>/track-o/grid/run-o-ret-l1-16`, bundle `o-head-1` at a99d8abe; the only later product
change is the rename): `STARTUP_HEALTHY_GRID_ROOM_DATABASE=1`, `STARTUP_HEALTHY_GRID_ROOM_RETENTION=1` (as Track M's
harness sets it) and `STARTUP_HEALTHY_GRID_POOL_LULL=1`. Built with `bin/bundleonly.sh` against the dist rebuilt
after the fix.

- It passed: 16 transitions, the persisted reopen and continued gameplay.
- Every creator lull from epoch 4 and every recipient lull from epoch 3 is `maintained`.
- Retention passes (Track M's `grid_summary.py`):
  - creator: 12 of 12 applied, each in **one continuation**, 45–46 writes (Track M: two decisions, 45–52 writes in
    all);
  - recipients: 39 of 39 applied, one continuation each.
- Recipient issuance (`<evidence>/track-n/bin/issuance_series.py`) is flat. Every client holds 13 issuance image
  rows after each adoption, from `adopted-6` through `adopted-16` and the reopen, and 15 before each rollover. That
  is the same 13 per client as Track M's 16-rollover run.
- The creator lull was 675–1029 ms from t5 at load average 78. That is not a paired figure; see below.

**Creator lull against Track M** (`LULL=1`, room database with retention, 8 rollovers, Chromium). The base bundle
is Track M's `build-m4`, copied to `grid/m-base-m4`. Its `entry.mjs` differs from Track O's bundle only in the fix's
hunks (`grid/base-vs-head2.diff`), so it is the 07849f85 product code. The head bundle is `o-head-2` at a66a0dea.
Two interleaved pairs:

| Pair | Order      | Load average         | Creator lull t5–t8, base (ms) | Creator lull t5–t8, Track O (ms) |
| ---- | ---------- | -------------------- | ----------------------------- | -------------------------------- |
| 1    | base, head | 68 / 35 (at run end) | 1070, 1146, 848, 1144         | 559, 584, 582, 629               |
| 2    | head, base | 15 / 10 (at run end) | 605, 604, 591, 599            | 547, 550, 559, 548               |

- Pair 1 overlapped Track O's own final vitest run, mostly during the base run, so it is not used for the figure.
- Pair 2 ran on a quiet machine. Track O's creator lull is **549 ms against 601 ms** (medians of t5–t8). Track M
  reported 623 ms at its own load.
- Track O's figure is lower because each creator boundary is one continuation instead of two.
  - Creator retention pass p50: 352 against 391 ms.
  - Floor step A: 3.2 against 5.5 ms.
  - Step B: 31 against 47 ms.
  - Plan: 32 against 41 ms.
  - The acquisition (275 against 296 ms) is unchanged in kind and is the largest part.
- t4 is not a retention pass on either variant: no creator pass is recorded there, and the existing path runs
  (1945 and 1948 ms; Track M: the first lull declines `ahe-birth`).
- No regression: seal, adoption, install and move issue are within run-to-run noise in pair 2.

## 11. What remains before Track M plus O can merge, and risks

**Before merging Track M plus O:**

1. **The 14b and 14e amendment needs the slice owner's acceptance** (96bc9b3c). It replaces "summaries only for
   epochs whose evidence retirement completed earlier" with "earlier or in the same unit", and it adds the
   dependency of signing evidence on its journal prefix. The code depends on both.
2. **Track M2 rebases onto this branch.** The conflicts will be in `reconcileSnapshotRecoveryRoles` (the decision
   construction) and `roomRetentionItems`. It should run Track O's three test files, the creator one-unit 14f cases
   (§7), and the node file `creator-closed-rollback-proof-accounting.test.ts`, which reads CRD's source text and
   fails to load on a duplicate local name (§9). Stage 2 must keep three things:
   - one decision per boundary;
   - one epoch's evidence and summaries in one unit;
   - the unit order.
3. **Track M's own pre-flip list still stands** (its §14 items 2–6). Those are stage 2, the 14c wiring, 14d
   migration, review of the 512-write cap, the latency and heap re-measurements, and review of the source-text
   tests with their owners. This track closes item 1 (case 8).

**Risks.**

- **A large committee can make one epoch's signing unit exceed the 512-write cap.** One epoch's evidence and
  summaries are about 6 rows per signer: one evidence row, one signer state, and two each of vote outbox and vote
  slots. That passes 512 at about 85 signers. The unit then declines `unit-over-cap`, and that boundary runs the
  existing path. This is safe, but that boundary is as slow as the existing path. The Grid's unit is 6 writes.
  Track M's two-decision form split this unit, but it was not resumable.
- **The existing summary rule can decline an epoch's summaries while that epoch's evidence retires.** That happens
  when a signer has signer state but no finalized evidence. The control then retires the epoch with summary rows
  present. The existing path's evidence pass followed by its summary pass reaches the same state, so this change
  does not create it. It did not occur in any run here.
- **Journal headers do not retire in this room's steady boundary.** Their split points (snapshot / header,
  header / signing) were therefore not exercised. The argument (§6, G3) is that headers come before signing, and
  no signing or AHE classifier reads them.
- **Boundaries with more than one evidence epoch were argued, not exercised** (§6, G3).
- **Case 8 at default caps now kills after the whole boundary.** Under default caps the boundary is one transaction,
  so the old D1 / D2 point no longer exists. The one-unit runs (§7) keep case 5–8 coverage between units, and Track
  M2 should keep running them.
- **Per-transaction old XOR new does not prove resumability.** The RED tests check every committed prefix of a
  boundary, but only for the boundaries this room produces. A new unit kind, or a new dependency between owners,
  needs its split points added to `tests/fixtures/track-o/split.ts`.

## Files and functions touched

- **Product:**
  - packages/node/src/internal/creator-closed-rollback-data.ts: `reconcileSnapshotRecoveryRoles` (the decision
    construction only, after `transferRoles`), `roomRetentionItems` (unit order), `roomRetentionSummarySelection`
    (doc comment).
  - packages/storage-browser/src/internal/signing-retirement.ts: `browserRoomSigningRetentionSection` (summary-key
    condition and doc comment).
  - packages/storage/src/room-retention.ts: `RoomRetentionSigningSelection` (doc comment).
- **Spec:** specs/bounded-storage-lifecycle/slices/14b-retention-trust.md, 14e-retention-bounds-and-charges.md.
- **Tests (new):** tests/track-o-room-retention-resume.test.ts, tests/track-o-room-retention-split.test.ts,
  tests/track-o-room-retention-split-recipient.test.ts, tests/fixtures/track-o/resume.ts,
  tests/fixtures/track-o/split.ts.
- **Track M's native harness (additive options, defaults unchanged):** tests/fixtures/track-m/native/
  room-retention-native.pw.ts, trap.ts (`beforePlan`), worker.ts (`unitCount`, `oneUnit` in `mutate`).
- **Docs:** this file.

No existing RED or governance test, frozen artifact, registry or vector was edited. docs/realtime-latency/README.md
was not edited.
