# Slice 14 — Single-database watermark retirement

Status: contract draft, 2026-10-19 (Track R3). The user approved this direction
after the Track R2 design review; no independent review of these documents has
run yet. Sub-slices 14a–14f each freeze RED before GREEN. Nothing here is
accepted until its RED, GREEN and native evidence are recorded in the
[requirement map](../requirements-to-evidence.md).

Guarantee ids (G1–G28) are defined, with their sources, in the
[golden-path guarantee checklist](../golden-path-guarantees.md). Track R2's design
review is in
[docs/realtime-latency/tracks/20-track-r2-r3-watermark-retirement](../../../docs/realtime-latency/tracks/20-track-r2-r3-watermark-retirement/STEP4.md);
these slices refine it where noted.

## Outcome

Creator and recipient closed-epoch maintenance (the lull, inline maintenance at
seal, and turnover at install) costs milliseconds per epoch instead of seconds,
with every golden-path guarantee kept. One verified decision per epoch is applied
by one transaction in the host floor (step A) and one transaction in one room
database (step B).

## Why the current shape costs seconds

Measured on the healthy native Grid run (8 rollovers, creator lull), one
maintained epoch makes 103 row writes. To do that it issues about 11,200
IndexedDB requests in 1,398 read-only and 57 strict read-write transactions over
six databases, plus about 26,800 keep-alive requests, and decodes or encodes about
150 MB of canonical bytes, 96–98% of it repeated. A lull is 2.0–3.4 s:

- about 45% re-acquires and re-authenticates the whole recovery state, four times,
  because "neither native observations nor authorization survive a stage"
  ([creator-closed-rollback-data.ts](../../../packages/node/src/internal/creator-closed-rollback-data.ts),
  `createCreatorSnapshotRecoveryMaintenanceJob`);
- about 30% is four cross-database two-phase commits
  (`applyClosedEpochRetirementIntent` in
  [closed-epoch-cleanup.ts](../../../packages/node/src/internal/closed-epoch-cleanup.ts)),
  because the six owners live in six databases and IndexedDB is atomic only
  within one;
- about 15% is bounded drains of at most 16 rows per transaction;
- about 8% is the post-boundary readiness capture.

No codec or pump optimisation reaches milliseconds; Track E measured both. The
cost is the shape: four passes, re-proof per pass, and six databases.

## End state

1. **One room database** (14a). The existing main database `N`, at version 7,
   hosts all five retention owners in disjoint store namespaces: signing keeps its
   stores; AHE, snapshot, journal and issuance move in under owner prefixes.
   Ordinary owner rows, codecs, controls and refusal codes keep their formats.
   Each owner's existing completed retirement control is its mark.
2. **Trust** (14b). Durable bytes stay untrusted. Facts are verified on arrival
   and the retained window is verified again on every open. In a session only
   in-memory verified facts are authority; durable bytes are compared with them
   byte-exactly inside the transaction that acts. A mark is a write fence, an
   index and a resume point, never authority.
3. **Host floor fence** (14c). The floor database stays separate and gains one
   per-owner fence entry (expected control before and after, and `through`).
   Step A writes it; step B follows.
4. **Migration** (14d). Existing six-database rooms move by fence, verbatim copy
   with receipt, then empty-and-keep-fenced. Nothing becomes collectible by
   migration, and a legacy database is never deleted.
5. **Bounds and charges** (14e). Every transaction has a reviewed per-owner row
   and byte cap, and every byte it reads is charged before its first delete.
6. **Native evidence** (14f). Chromium, Firefox and WebKit, SIGKILL at every
   edge, multi-tab version fencing, and the Grid golden path.

The decision owner does not change: the node's authenticated planner in
`creator-closed-rollback-data.ts` decides, now once per epoch and from carried
verified facts. Owners execute, each re-checking its own facts inside the
transaction that deletes.

## What this supersedes in Phase 6b, for retirement only

[Phase 6b non-goals](../../phase-6b-bounded-pruning/README.md#non-goals):

- "No wire-format, digest-domain, signature, QC, activation, or identity change"
  (6B:63). Superseded only for local, non-consensus formats used by retirement:
  the room database layout at version 7 and its layout record (14a), the
  retirement decision record and its local digest domain
  `ts-drp/retention-decision/v1` (14a), the floor fence record and its readback
  domain `drp.native-room-head-retirement-fences.v1` (14c), and the migration
  receipt domain `drp.room-migration-receipt.v1` (14d). No wire format,
  signature, QC, activation, identity, vertex, Cut, anchor or protocol digest
  domain changes, and no owner row or control codec changes.
- "No cross-database atomicity claim. Each physical owner rechecks its own
  monotone facts transactionally immediately before its own deletion" (6B:66-67). Kept. The
  new claim is atomicity within one database, which IndexedDB provides. There is
  still no atomicity claim between the floor and the room database; the order is
  A then B. Each owner still rechecks its own facts immediately before its own
  deletion, now inside the same transaction.
- The other non-goals (6B:64-65, 6B:68-70: no deletion by lock, timer, lease,
  UI or runtime observation; deferred receipt work; legacy finality; memory
  thresholds; archive behaviour) are kept.

Every [Phase 6b sacred contract](../../phase-6b-bounded-pruning/README.md#sacred-contracts)
is kept: head plus the two `baseExpectedHead` rollbacks complete; the lineage-floor
rewrite in the same owner transaction; issuance deletion only of valid, paired,
published, epoch-bound rows with the per-scope watermark and
`ISSUANCE_RECORD_PRUNED`; the local-only availability digest; advisory locks never
decide eligibility; retain too much, never too little.

Ordinary owner operations, their formats and refusal codes are not changed by
this slice.

## Selection and default

- The browser storage host selects the layout. The existing host keeps six
  databases and the existing protocol. A new host, `browserRoomDatabaseStorageHost`,
  opens every owner in the room database and adds the retention port.
- The node selects the retirement path by the presence of that port. The
  existing path stays for the existing host and for the Node/SQLite backend, which
  this slice does not change.
- The new path becomes the browser default only in a separate final commit, and
  only when 14f passes on Chromium, Firefox and WebKit and the golden-path suites
  show no new per-test failure against the base commit. Otherwise it stays opt-in
  and the reason is recorded here.

## Slice graph

| Slice                                         | One question                                                                                                          | Depends on | Decisive artifact                                                                                 |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------- |
| [14a](14a-retention-database-format.md) S1    | Can all five owners share one database, and can one transaction apply a verified decision with marks as write fences? | —          | Co-located owner parity; single-transaction executor with crash points; writer fences             |
| [14b](14b-retention-trust.md) S2              | Is a decision from carried verified facts plus in-transaction byte checks sound under untrusted storage?              | 14a        | Poisoned-byte, stale-writer, foreign-head and reopen cases; equivalence with the existing planner |
| [14c](14c-host-floor-retirement-fence.md) S3  | Does a per-owner floor fence order the two steps and detect rollback?                                                 | —          | Monotone fence; crash matrix; mark-versus-fence checks                                            |
| [14d](14d-retention-migration.md) S4          | Can a six-database room move without a second authority?                                                              | 14a, 14c   | Fence, copy, receipt, empty; crash matrix; old code refused                                       |
| [14e](14e-retention-bounds-and-charges.md) S5 | Is every retirement transaction bounded and charged?                                                                  | 14a        | Cap and budget refusals with zero writes; batching continuation                                   |
| [14f](14f-retention-native-evidence.md) S6    | Do the native claims hold in three engines under SIGKILL?                                                             | 14a–14e    | Per-engine evidence record; Grid golden path                                                      |

## Guarantees

The per-slice tables own the detail. Summary:

| Guarantee                                                                                                     | Kept by                                                                              |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| [G1](../golden-path-guarantees.md), [G2](../golden-path-guarantees.md)                                        | 14a, 14e: bounded window, bounded marks, backpressure on cap                         |
| [G3](../golden-path-guarantees.md)                                                                            | 14b, 14f: owner rules unchanged; Grid golden path                                    |
| [G4](../golden-path-guarantees.md), [G17](../golden-path-guarantees.md)                                       | 14a existing owner write fences, 14c fence mismatch fails closed, 14d version fences |
| [G5](../golden-path-guarantees.md), [G8](../golden-path-guarantees.md), [G10](../golden-path-guarantees.md)   | 14b                                                                                  |
| [G6](../golden-path-guarantees.md), [G24](../golden-path-guarantees.md)                                       | 14c: floor custody unchanged; fail closed, never repaired                            |
| [G7](../golden-path-guarantees.md)                                                                            | 14b: one decision owner, no sweeper                                                  |
| [G9](../golden-path-guarantees.md), [G11](../golden-path-guarantees.md), [G12](../golden-path-guarantees.md)  | 14a: every owner check and delete in one native read-write transaction               |
| [G13](../golden-path-guarantees.md)                                                                           | 14a: no lock decides anything                                                        |
| [G14](../golden-path-guarantees.md), [G15](../golden-path-guarantees.md)                                      | 14a, 14c: marks atomic with deletes; A before B                                      |
| [G16](../golden-path-guarantees.md)                                                                           | 14a, 14c: strict only                                                                |
| [G18](../golden-path-guarantees.md), [G19](../golden-path-guarantees.md), [G20](../golden-path-guarantees.md) | 14b: protected set and owner rules unchanged                                         |
| [G21](../golden-path-guarantees.md), [G22](../golden-path-guarantees.md)                                      | 14e                                                                                  |
| [G23](../golden-path-guarantees.md)                                                                           | 14b: the lull keeps its FIFO ingress queue                                           |
| [G25](../golden-path-guarantees.md)                                                                           | 14d                                                                                  |
| [G26](../golden-path-guarantees.md)                                                                           | no check is relaxed for latency                                                      |
| [G27](../golden-path-guarantees.md)                                                                           | no game-specific rule                                                                |
| [G28](../golden-path-guarantees.md)                                                                           | 14f                                                                                  |

Track K's recipient journal semantics (received-certificate replay
classification, the recipient's own closed-membership carrier and numeric
protected-hole order) are owner rules and are kept unchanged. Its extra fresh
pass after a generation drain exists only because a generation pass suppresses
journal prefixes; the new path does not suppress them, and 14b acceptance 6
checks that scope k-3 still becomes collectible at floor k.
`tests/recipient-long-room-journal-retention-native.test.ts` runs the SQLite
path, which this slice does not change, and stays green; 14b acceptance 6 checks
the same bounds on a browser room with the new path selected.

## Acceptance additions

- A Grid run with every recipient lull, including the last, passes persisted
  close, reopen and continued gameplay with the new path selected. On the
  existing path this run fails twice: an unawaited retained-history request after
  the final lull races the close, and after reopen recipients never admit the next
  live move. Track L owns both on the existing path; neither may occur on the new
  path, which leaves no active control, pending drain or new resume request.
- Per transition, against the base commit in interleaved pairs: seal, creator
  adoption, recipient install, creator lull and recipient lull; per-move visible
  and durable latency during the lull; and the longest main-thread task in each
  window.

## Owners replaced and kept

Replaced on the new path: the cross-database two-phase commit and its readbacks;
the multi-transaction drains; the four-pass stage loop and its single-policy
decision carrier; the held all-store read view as retirement exclusion;
per-pass re-acquisition.

Kept: the node planner as the only decision owner and its protected-set rules;
every owner's classification rule; every owner's retirement control, now
written only as a completed mark; the floor's custody and its head expectation;
canonical codecs, signatures and digests; strict durability; schema-version
fencing; the deferrable lull with FIFO ingress; the readiness capture (outside
retirement).

## Stop conditions

If any step cannot keep a guarantee, that step stops, its counterexample is
written here, and the new path stays opt-in.
