# Track R2, Step 4: single-database watermark retirement

This is the Step 4 verdict, checked against the real code at de70325e. Guarantee ids are from
`scratchpad/track-r/GUARANTEES.md`. The abbreviations are the same: BSL, R2E, 6B, 6B01, 02D and PLAN.

## Verdict in one paragraph

A single-database watermark retirement can satisfy every guarantee except one: G28 (native,
three-engine and SIGKILL evidence) is still owed. Three conditions apply:

1. The trust model must change. Track E's "local IndexedDB contents are trusted after ingress
   verification" is not allowed: it contradicts G5 and G8.
2. The watermark must be a write fence, an index and a resume point. It must never be an
   authority.
3. The host floor must stay a separate custody database, reached by an ordered two-step
   protocol.

It cannot land as a production replacement in this cycle, for three reasons:

* It changes durable formats, digest domains, controls and the database layout. 6B:63 lists
  "No wire-format, digest-domain, signature, QC, activation, or identity change" as a Phase 6b
  non-goal, so it needs its own spec slices (listed at the end).
* It needs an authenticated, fenced migration from the existing databases (G25).
* Its native claims (strict durability, crash atomicity, native exclusion) need three-engine and
  SIGKILL evidence (G28).

What can land soundly now is the mechanism, opt-in and unwired: one store module whose invariants
are tested at every crash point, plus a cost measurement. That is what Track R2 implemented (see
`RESULT.md`).

## 1. The current shape it would replace (de70325e)

* Five physical retention databases, plus the separate host floor:
  * the main database at schema v6 (`schema-idb.ts:86-91`) holds AHE (`objects`, `generations`,
    `blobs`, `promotions`) and signing (`storageMeta`, `voteSlots`, `signerState`, `voteOutbox`,
    `sealEvidence`);
  * snapshot quarantine, v4 (`snapshot-transfer.ts:300`);
  * live journal, v3 (`live-journal.ts:201`);
  * issuance, v3 (`browser-issuance-store.ts:101`);
  * room-head floor, v1 (`room-head.ts:110`; `<db>--startup-floor` in the Grid fixture).
* One lull runs four passes (`reconcileCreatorBoundedRecoveryMaintenance`, creator-close.ts:2397):
  journal and evidence, then summaries, then two AHE generation drains. Each pass does the same
  steps:
  1. a fresh sealed census;
  2. `acquireClosedData` (creator-closed-rollback-data.ts:7138), a full re-authentication by
     re-encoding;
  3. one cross-database two-phase commit, `applyClosedEpochRetirementIntent`
     (closed-epoch-cleanup.ts:997). Its coordinator is AHE; its participants are snapshot,
     journal, issuance, floor and signing;
  4. `verifyCompleted` (creator-closed-rollback-data.ts:19801).
* Stage exclusivity comes from implementation choices, not from the spec:
  * `creatorClosedRetirementCapacityBranches` (14111);
  * the decision carrier's single `policy` (11160);
  * exactly one AHE `completed.generationDrain` (`packages/storage/src/retirement-control.ts:433-478`).
* Exclusion comes from `HeldReadView` (native-read-reservation.ts:100), an all-store readonly
  transaction kept alive by a `getKey("")` spin. It issues about 26,800 sentinels per epoch.

Measured costs (Track E diag; Track R2 `diag-base1-l1`):

| Item | Per pass | Per epoch |
|---|---|---|
| Re-acquire and authenticate (`racq`) | 100–145 ms | |
| Install (`rinstall`) | 200–320 ms | |
| 2PC apply | 120–160 ms | |
| Stage drains | 25–120 ms each | |
| Lull total | | 2.0–3.1 s |

## 2. Design

### 2.1 Physical layout

There is one retention database per room namespace. The cheapest place for it is the existing
main database, bumped to v7. It already holds AHE and signing, so only the snapshot, journal and
issuance owners move. The bump from v6 to v7 is itself the stale-writer fence for v6 code: v6 code
opens with a fixed version and gets `VersionError`, and open v6 connections get `versionchange`.
This mechanism is already used for v5 and v6.

New stores (a sketch; exact names are a spec-slice decision):

| Store | Key | Value |
|---|---|---|
| `retainedRows` | `[owner, scope, epoch, kind, id]` | exact canonical bytes (`Uint8Array`) |
| `retainedBlobs` | `digest`, with index `lastRef` on `[scope, epoch]` | exact canonical bytes |
| `retainedHeads` | `scope` | exact canonical head-record bytes, `revision`, `incarnation` |
| `retirementMarks` | `[scope, owner]` | `{through, revision, decisionDigest}`, one monotone mark per owner |
| `migrationReceipts` | legacy database name | `{legacyVersion, sourceImageDigest, rows, bytes}` |

Notes on the layout:

* Rows are keyed epoch-major inside each owner and scope. Retiring an epoch prefix is then one
  `delete(IDBKeyRange)` per owner. The existing AHE stores are not epoch-keyed; they get an epoch
  index and are retired by an index cursor, `cursor.delete()`, which is still one transaction.
* Rows that must outlive their epoch use their own `kind`, retired under their own mark. Examples:
  signing summaries outlive evidence; journal replay-protection rows outlive the prefix.
* Rows are stored as exact canonical bytes, not structured objects. This removes the
  re-encode-to-compare and re-encode-to-charge cost (`closedRetirementBytes`/`closedRetirementEqual`,
  288 call sites, and the `canonicalValueResourceForSizing` encode and decode).

### 2.2 Trust model (replaces Track E's "trusted after ingress")

1. **Verify on arrival.** Every row is verified before it is written: signature, digest, chain
   and exact canonical bytes. A blob's key must equal `digest(bytes)`.
2. **Verify on every open.** When a room opens, the retained window is read and verified again
   against signed facts and the host floor (G5, PLAN:6968). The window is bounded: head, two
   rollbacks, bounded pending work and the shared bytes those reference (G18, G21). Anything
   unverifiable fails closed. Nothing is repaired from stored digests or the watermark.
3. **In session, only in-memory verified facts are authority.** These are the verified head chain
   and closures, held in process memory. Durable bytes are only compared byte-exactly against
   them, inside the same read-write transaction that acts on them. Two stored digests are never
   compared with each other; PLAN:10974-10981 says "Comparing two stored digests is
   insufficient".
4. **Incremental digests are caches.** An LtHash or MSet multiset hash of an owner's retained rows
   may be kept in memory. It is computed from verified bytes and makes the verify-on-open check
   cheaper. A digest stored on disk is only a hint, so it can never decide anything.

### 2.3 One retirement, step by step

The decision owner is unchanged: the node's authenticated planner. It computes the decision from
in-memory verified facts:

* the verified head;
* the two `baseExpectedHead` ancestors;
* bounded pending work;
* the protected closure, meaning protected row keys and protected blob digests;
* for each owner, `through[owner]`, the highest epoch whose rows are all outside the protected set
  under that owner's classifier.

Step A is the floor fence, in the room-head database. It is one strict read-write transaction
that compares and sets `retiredThrough[owner] := max(old, through[owner])` for every owner in the
decision, plus a head fence at the minimum of those values. Adoption and rollback to any head at
or below the head fence are then refused.

* Every fence is monotone and idempotent. It never lowers a floor (G18), and every protected
  rollback ancestor sits above every `through` by construction.
* The floor re-checks its own exact image inside this transaction, as `room-head.md` already
  requires (G9).
* The fence is per owner, not one number. An owner held back by verified pending work, such as
  issuance below an unpublished record, has a lower `through`. Its rows stay readable and
  finishable, while the other owners' rows are fenced (G19, G2).

  Track R2 first implemented a single scope-wide fence. It hid such pending rows and answered
  their late acknowledgements `RECORD_PRUNED`. That is a G19 violation, and the per-owner fence
  replaced it. A test pins the fix: "pending work the planner knows of holds back only its own
  owner".

Step B is one strict read-write transaction in the retention database. Its scope is
`retainedRows`, `retainedBlobs`, `retainedHeads` and `retirementMarks`, with
`{durability:"strict"}`. If `durability !== "strict"` it refuses (G16). There are no awaits on
non-IndexedDB work inside the transaction; all crypto ran before it.

1. Read `retainedHeads[scope]`. It must be byte-identical to the verified head bytes. Otherwise it
   refuses `HEAD_CHANGED`, with zero writes. This catches another tab's adoption or rollback, a
   foreign writer, or a restored database.
2. For each owner, read `retirementMarks[scope, owner]`:
   * if `mark.through` is at or above the decision's lowest protected epoch, refuse `CORRUPT` with
     zero writes overall. Either the mark was poisoned or rolled forward, or the decision is
     wrong. Fail closed.
   * if `mark.through ≥ through[owner]`, this owner has nothing to do. This is an idempotent
     replay or a stale decision.
   * if the floor fence from Step A is below the new mark, refuse `FLOOR_BEHIND`. The order is
     floor first, then retention.
3. For each advancing owner, read the candidate range `[owner, scope, -∞] .. [owner, scope,
   through]` with a bounded `getAll(range, cap + 1)`. More than `cap` rows refuses `CAPACITY` for
   that owner (G21, G2 backpressure). Then classify each candidate in memory:
   * a key in the protected set refuses `CORRUPT`, because the decision and the store disagree;
   * otherwise the owner's classifier, applied to the exact bytes, returns retire, block or
     malformed. Issuance retires only valid, paired, published rows. A pending or malformed row
     blocks the owner (G19). A blocked owner gets zero writes and its mark does not advance; the
     other owners proceed.
4. Blobs: the `lastRef` index range `≤ W` only selects candidates. Each candidate digest is kept if
   the in-memory protected-blob set or bounded pending work names it. Otherwise it is deleted.
   Because `lastRef` is a selector and not a proof, a poisoned `lastRef` can only cause retaining
   too much (G15).
5. Charge the proof budget for every read row and key before any delete is issued (G22).
6. Issue the deletes and the AHE lineage-floor rewrite. The rewrite sets the oldest retained
   ancestor's `baseExpectedHead` to `{kind:"none"}`: it is an owner policy, now in the same
   transaction. Then put the new marks with `revision+1` and `decisionDigest`.
7. On commit, read the store back at the next open or next decision. There is no separate
   readback round.

Crash cases:

| When | Result |
|---|---|
| Before A, or during A | Nothing changed. |
| Between A and B | The floor refuses ≤ W, but the rows are still present. This retains too much, which is safe (6B:183). The next lull recomputes the same decision and B runs. |
| During B | B aborts atomically, leaving the old state (G15 old XOR new). |
| After B | Done. A replay hits the "nothing to do" branch. |

The reverse order, B before A, would be unsafe. A crash between them would leave the floor
accepting rollback or adoption to an epoch whose rows are gone. That order is therefore forbidden.

### 2.4 Writers, stale writers and resurrection (G17)

Every append path checks `retirementMarks[scope, owner]` in its own read-write transaction and
refuses `epoch ≤ through` with `RETIRED`. The paths are the journal append, issuance record and
ack, the snapshot put, the AHE object, generation and blob writes, and signing evidence. This is
the store-local monotone write fence of BSL:210. A late issuance ack below the mark gets
`ISSUANCE_RECORD_PRUNED` (6B01). Imports and restores enter through the same writers.

Code that predates the mark cannot reach the database: the version bump fences it. A partial
restore of the retention database alone is a whole-database rollback. The host floor detects it
(§2.5).

### 2.5 Rollback of the watermark and of the database (G6, G24)

* **Mark lower than the floor's `retiredThrough[owner]`.** This is either the crash case or a rollback of
  the retention database. That owner's rows at or below `retiredThrough[owner]` are treated as retired: reads hide
  them and adoption refuses them. The next decision deletes them by verified decision, not on the
  mark's word.
* **Mark higher than the floor.** This cannot happen under the A-then-B order. It refuses
  `CORRUPT`: the database is tampered or the floor regressed. A regressed floor is never repaired
  (02D:86-99).
* **Retention database head older than the host floor head.** Fail closed, as today. A floor is
  never repaired by selecting genesis.
* **Whole-origin rollback (floor and retention restored together).** Nothing in the same origin
  can detect this (BSL:175-178). The defence remains the host's freshness and custody choice for
  the floor (`room-head.md`). The design neither changes nor claims more than that (G6).

### 2.6 Migration from the existing databases (G25)

The ordering is chosen so that every crash leaves exactly one authority, or none, and never an
unfenced old writer.

1. **Fence the legacy databases.** Open each legacy database (snapshot v4, journal v3, issuance v3)
   at `version+1`, with an upgrade that only adds a `migrationFence` store holding a tombstone.
   * Old code that opens with its fixed version gets `VersionError`.
   * Already-open connections receive `versionchange`. Every current store closes on it
     (`live-journal.ts:1531`, `snapshot-transfer.ts:700`, `browser-issuance-store.ts:2691`), and
     the upgrade is blocked until they do.
   * New code never writes a fenced legacy database.
2. **Authenticate.** Read each legacy database under one held readonly view and verify every
   retained row against the verified head and the signed facts, exactly as an open would. Any
   unverifiable protected row aborts the migration: the room fails closed and the legacy databases
   are kept as fenced evidence. Unprotected, unverifiable rows are simply not carried, which
   retains less but deletes nothing protected.
3. **Copy.** In one strict read-write transaction in the retention database:
   * all verified rows, as exact bytes;
   * the heads;
   * marks initialised from the legacy completed retirement controls. A mark equals the highest
     completed epoch the legacy control proves. A missing control means mark −∞, which retains
     everything;
   * one `migrationReceipts` row per legacy database, holding the digest of the authenticated
     source image.

   A crash before commit leaves nothing.
4. **Delete the legacy databases** with `indexedDB.deleteDatabase`. On every open, if a receipt
   exists and a legacy database still exists, delete it again. This is idempotent. A legacy
   database is never read as authority after its receipt commits, so there are never two
   authorities (BSL:216).

Crash cases:

| When | Next open |
|---|---|
| After 1 | Sees fenced legacy databases and no receipt, and resumes at 2. |
| After 3 | Sees a receipt and the legacy databases, and resumes at 4. |
| After 4 | Clean. |

The receipt digest binds what was copied to the authenticated source. A receipt without matching
retained rows fails closed.

## 3. Guarantee by guarantee

| id | How the design satisfies it, or why it cannot |
|---|---|
| G1 | Satisfied. The retained window is head + two rollbacks + bounded pending work, and each lull retires everything below `W` in one transaction. Hot state stays bounded and there is no per-epoch growth in marks: one mark per owner per scope. |
| G2 | Satisfied. `CAPACITY` and a blocked owner retain the rows and report them, and the existing pool-capacity admission backpressure applies unchanged. Accepted work is in the protected set, so it stays finishable. |
| G3 | Satisfied, assuming the owner classifiers and the protected set are unchanged. Offline and rebase work below `W` is refused exactly as today's fences refuse it. Crash recovery is §2.3; next issuance is unchanged. Golden-path evidence on the real Grid is still owed, because the design is unwired. |
| G4 | Satisfied. The writer fence refuses `epoch ≤ through` (§2.4), stale signing requests hit the signing owner's mark, and the version bump closes stale code. |
| G5 | Satisfied only with §2.2. Verify on arrival and on every open; in session, durable bytes are only compared against in-memory verified facts. Track E's "trusted after ingress" is rejected. |
| G6 | Unchanged and not strengthened: whole-origin rollback is out of scope (BSL:175-178), and host floor custody stays separate (§2.5). |
| G7 | Satisfied. There is one decision owner, the node planner. The store module is an executor: it deletes nothing that the decision does not name or cover by range, and it never decides from epoch age, TTL, counts, `adopted: true` or labels. Track E's "successor adopted, pool > K" stability gate is not used as proof. `through` comes from the verified protected set and the owner classifiers. |
| G8 | Satisfied. The mark is a fence, an index and a resume point. Anything the mark contradicts refuses (`CORRUPT`, `FLOOR_BEHIND`), and rows below a mark are deleted only by a verified decision. |
| G9 | Satisfied. Each owner's facts (head bytes, mark, revision, candidate rows, protected keys and blobs, lifecycle classification) are rechecked inside the same read-write transaction, immediately before that owner's deletes. The floor rechecks its own image in its own compare-and-set transaction. Because the database is one, every check and delete is in one native transaction, which is stronger than one check per database. |
| G10 | Satisfied. Only signed and verified facts in memory outlive a stage. Currency (head bytes, marks) and progress are read fresh inside the transaction, and no proof is reused across retirements. |
| G11 | Satisfied. The currency reads and the deletes share one native read-write transaction, which is a stricter bracket than a held readonly view. |
| G12 | Satisfied natively. IndexedDB serialises read-write transactions with overlapping scope, so a foreign writer cannot interleave. Retirement no longer needs the `HeldReadView` pump. Other readers, such as the readiness capture, keep it. |
| G13 | Satisfied. Web Locks may at most schedule which tab runs the lull. Eligibility and deletion come only from the transaction. |
| G14 | Satisfied. The bounded resumable checkpoint is the mark row, written atomically with the deletes. There is only one cross-database dependency, floor then retention, and both steps are ordered, idempotent and monotone. Store-local write fences are the marks (§2.4). An absent mark or receipt means retain. |
| G15 | Satisfied. Inside the database, old XOR new comes from one transaction. Across floor and retention, a crash retains too much. A delete is always in the same transaction as its mark, and retirement is never part of a gameplay or adoption commit. |
| G16 | Satisfied. The transaction requires `durability:"strict"` and refuses otherwise, the same pattern as `live-journal.ts:192`. |
| G17 | Satisfied within the origin by the writer fences and the version bump (§2.4). Resurrection by a whole-origin rollback is G6. |
| G18 | Satisfied. The protected set is unchanged and computed from verified facts. Marks and the floor fence are monotone (compare-and-set refuses a decrease), and the AHE lineage-floor rewrite is preserved, in the same transaction. Rollback never lowers floors. |
| G19 | Satisfied. The planner holds issuance's `through` below any verified pending record, so pending work stays readable and finishable, and only issuance's fence is held back. Issuance candidates are also classified row by row inside the transaction. A pending or malformed row the verified facts did not predict blocks issuance with zero issuance writes and no mark advance, while the other owners proceed. Late acks below the mark get `ISSUANCE_RECORD_PRUNED`. |
| G20 | Satisfied, with the snapshot owner policy kept. A snapshot scope is protected only while a protected closure or pending work names it, and promotion precedes dependence. TTL is not used. |
| G21 | Satisfied, with new reviewed bounds needed. Each owner has a per-epoch cardinality cap read with `getAll(range, cap+1)`, and over-cap refuses. The caps must be reviewed policy, not post-hoc constants (BSL:257-267). That is a spec-slice item. |
| G22 | Satisfied in shape. Every read row is charged its full exact byte length before the first delete, with no refunds; reservation precedes irreversible effects. The 4 MiB `maintenanceProofBytes` comfortably covers one epoch. The new charge table must be reviewed (spec slice). |
| G23 | Satisfied. The lull stays a deferrable queue slot, and ingress queues FIFO during it. The design shortens the lull; it does not change admission. |
| G24 | Satisfied. The floor remains a trusted expectation (§2.5), and a mark above the floor or a head older than the floor fails closed. It is never repaired from genesis. |
| G25 | Satisfied by §2.6: fence first, authenticate, then one atomic copy with a receipt, then idempotent delete. Stale connections are fenced by version bump and `versionchange`, and there is never a second authority after the receipt. A spec slice and native evidence are needed. |
| G26 | Respected. No check is removed. The latency comes from structure: one transaction, one database, exact bytes, no re-authentication by re-encoding. |
| G27 | Satisfied. Owner policies are generic and there is no Grid carve-out. Census-proven pruning still holds, because candidates come from a bounded census of the candidate range. |
| G28 | **Not satisfied yet.** Fake-indexeddb tests are mechanism evidence only. The native claims (strict durability, cross-engine read-write serialisation, crash at each step under SIGKILL, `versionchange` across tabs) need Chromium, Firefox and WebKit runs plus SIGKILL harness runs, in the style of the existing `phase-2e6-real-process-death` tests. |

## 4. Owners replaced, owners kept

Replaced, in the end state:

* The cross-database 2PC sequencer `applyClosedEpochRetirementIntent` (closed-epoch-cleanup.ts:997):
  coordinator intents, participant prepare fences, readbacks, recheck, coordinator commit and
  `verifyCompleted`. It becomes one transaction plus the floor fence step.
* The per-database `retirementControls` stores (snapshot, journal, issuance), the AHE control's
  `completed.generationDrain`, and the signing intents in `storageMeta`. These become per-owner
  marks.
* The held all-store readonly view as the exclusion for retirement. It is replaced by the
  read-write transaction scope.
* The per-pass re-authentication by re-encoding (`acquireClosedData`, `closedRetirementBytes`,
  `closedRetirementEqual`). It is replaced by exact stored bytes compared with in-memory verified
  bytes.
* Stage exclusivity, the four passes and the decision carrier's single `policy`, together with the
  source-proof domains `ts-drp/closed-retirement-source/v1|v2|v3`. They are replaced by one
  decision record per retirement, under a new digest domain (spec slice).

Kept:

* The node's authenticated decision owner and planner, and the protected-set computation (G7, G18).
* Every owner classification policy:
  * AHE lineage-floor rewrite;
  * issuance published/paired/pending blocking;
  * the signing evidence-then-summary fence, which becomes ordering inside one transaction;
  * journal replay protection;
  * snapshot scope and promotion.
* Host floor custody: the room-head database and its compare-and-set and image recheck (G6, G24).
  It gains one bounded, monotone per-owner `retiredThrough` record (six integers per scope).
* The canonical codec, signatures and digests, and strict durability.
* Schema-version fencing.
* The deferrable lull with FIFO ingress.
* The readiness capture (`captureCreatorOrdinarySourceWithoutForecast`, about 200 ms). It is
  outside retirement, keeps its held view and is untouched by this design.

## 5. Expected gain

| Variant | Median per epoch | Max |
|---|---|---|
| Track E model, one database, one strict transaction | 2.5 ms | 4.3 ms |
| Track E model, six databases with independent marks | 6.2 ms | |
| Track R prototype, six databases with floor fence | 15.3 ms | |
| Track R2 opt-in module, fake-indexeddb, in-process | see `RESULT.md` | |

Track R2 also benchmarked the opt-in module in Chromium with strict durability (`RESULT.md`).

Against the 2.0–3.1 s lull:

* retirement drops to milliseconds;
* the lull's floor becomes the readiness capture (about 200 ms) plus one census;
* if readiness capture were also rebuilt on exact bytes, the readiness work would shrink too.

## 6. Spec slices required

* **S1, retention database format.** Stores, keys, exact-byte rows, the mark record and the
  decision-record digest domain. This supersedes the Phase 6b non-goal (6B:63) for retirement
  only.
* **S2, trust statement.** Verify on arrival and on every open; in session, in-memory verified
  facts only; no stored-to-stored digest comparison; incremental digests are caches.
* **S3, floor retirement fence.** The per-owner `retiredThrough` record in the room-head record, the A-then-B
  order and its crash matrix.
* **S4, migration.** Fence, authenticate, copy with receipt, delete, plus the crash matrix and the
  behaviour under unverifiable rows.
* **S5, bounds and charges.** Per-owner per-epoch caps and the proof-byte charge table for one
  transaction (G21, G22).
* **S6, evidence.** Three engines, SIGKILL at A, between A and B, inside B, and between each
  migration step, plus multi-tab `versionchange` (G28).
