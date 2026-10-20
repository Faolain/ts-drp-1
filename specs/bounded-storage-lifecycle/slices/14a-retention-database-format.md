# 14a — Room database format and single-transaction retirement (S1)

Status: contract draft, 2026-10-19, under the [slice 14 parent](14-single-database-watermark-retirement.md).
Implementation (Track R3): stage 1a only, opt-in. The version-7 room database, the owner
room factories, the room retirement session and the node install in one session per
install have landed; one retirement per epoch in one transaction needs 14b. See the
[parent status](14-single-database-watermark-retirement.md#status-track-r3-2026-10-19-opt-in-stage-1a-only).
No review has run. RED precedes GREEN; no implementation acceptance is claimed.
Guarantee ids (G1–G28) are defined, with their sources, in the
[golden-path guarantee checklist](../golden-path-guarantees.md). Line numbers are at commit 1c6a8259.
Abbreviations: MNT = packages/storage/src/maintenance.ts, ST = packages/storage/src/snapshot-transfer.ts,
LJ = packages/live-journal/src/retirement.ts, RET = packages/issuance-store/src/retirement.ts.

## One question

Can the five browser retention owners (AHE, signing, snapshot, journal, issuance)
live in one IndexedDB database with disjoint store namespaces, keeping every
ordinary operation, row format and refusal code, so that one strict read-write
transaction can apply one verified retirement decision across all of them, with
each owner checking and fencing its own facts inside that transaction?

## Today

A browser room uses six databases (base name `N`, host-chosen):

| Owner    | Database                        | Version | Stores                                                                                                               |
| -------- | ------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------- |
| AHE      | `N--ahe`                        | 6       | `objects`, `generations`, `blobs`, `promotions`, `storageMeta` (plus the unused signing stores of the shared schema) |
| Signing  | `N`                             | 6       | `voteSlots`, `voteOutbox`, `signerState`, `sealEvidence`, `storageMeta` (plus the unused AHE stores)                 |
| Snapshot | `N--drp-snapshot-quarantine-v1` | 4       | `scopes` (index `expiryAsc`), `chunks`, `owner`, `retirementControls`                                                |
| Journal  | `N--drp-live-journal-v1`        | 3       | `scopes`, `acceptedEntries` (indexes `digestUniq`, `localRefUniq`), `retirementControls`                             |
| Issuance | `N--drp-issuance-v1`            | 3       | `lineages`, `settlementPlans`, `issuedRecords`, `issuanceOutbox`, `retirementControls`                               |
| Floor    | host-chosen                     | 1       | `floor`                                                                                                              |

IndexedDB is atomic only inside one database, so closed-epoch retirement today
is a metadata two-phase commit across six databases
(`applyClosedEpochRetirementIntent`, packages/node/src/internal/closed-epoch-cleanup.ts:997-1235)
followed by per-owner drains. The parent slice records what that costs.

## Format

### The room database

The room database is the existing database `N` at schema version 7. The floor
stays separate ([14c](14c-host-floor-retirement-fence.md)). Version 7 contains:

| Namespace                      | Stores                                                                                                                              | Key paths and indexes                                                   |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| signing (unchanged, no prefix) | `voteSlots`, `voteOutbox`, `signerState`, `sealEvidence`, `storageMeta`                                                             | exactly as version 6                                                    |
| legacy schema stores           | `objects`, `generations`, `blobs`, `promotions`                                                                                     | exactly as version 6; must stay empty in room mode                      |
| AHE                            | `ahe:objects`, `ahe:generations`, `ahe:blobs`, `ahe:promotions`, `ahe:storageMeta`                                                  | the version-6 key paths of the unprefixed stores                        |
| snapshot                       | `snapshot:scopes`, `snapshot:chunks`, `snapshot:owner`, `snapshot:retirementControls`                                               | exactly as snapshot version 4, including index `expiryAsc`              |
| journal                        | `journal:scopes`, `journal:acceptedEntries`, `journal:retirementControls`                                                           | exactly as journal version 3, including `digestUniq` and `localRefUniq` |
| issuance                       | `issuance:lineages`, `issuance:settlementPlans`, `issuance:issuedRecords`, `issuance:issuanceOutbox`, `issuance:retirementControls` | exactly as issuance version 3                                           |
| room                           | `room:layout`                                                                                                                       | out-of-line key; one record under key `"layout"`                        |

AHE moves under a prefix even though `N` already has stores with its names: AHE
and signing would otherwise share `storageMeta`, and an AHE held read view would
then block signing writes. With disjoint namespaces, two owners' transactions
overlap only when one of them is the retirement transaction.

Each namespaced store holds exactly the rows, keys and values its owner writes
today. No owner row, codec, control record, index or refusal code changes.

The layout record is canonical bytes under the floor's image limits:

```text
{ version: 1, kind: "room-database-layout-1",
  state: "migrating" | "ready",
  sources: [ { database, fencedVersion, receiptDigest }, ... ] }
```

`sources` is filled by [14d](14d-retention-migration.md). Owners open in room
mode only when `state` is `"ready"`.

### Upgrade to version 7

Only the schema owner (`packages/storage-browser/src/internal/schema-idb.ts`)
upgrades `N`. From version 6 it first checks the exact version-6 catalog, as it
does for earlier versions; from version 0 it creates the version-6 stores and
incarnation row first. It then creates every namespaced store and index above
and adds the layout record with `state: "migrating"`. Any other old version, an
unexpected store, or a blocked upgrade refuses with the existing schema codes.

Version 7 is the stale-code fence for `N`: code pinned to version 6 gets
`VersionError` on open, and open version-6 connections receive `versionchange`
and close. Every pre-existing room session needs `N`, so no pre-existing session
can run against a version-7 room.

### Owners in room mode

The storage host chooses the layout ([parent](14-single-database-watermark-retirement.md#selection-and-default)).
In room mode an owner:

1. opens `N` at exactly version 7 on its own connection and aborts any upgrade
   (a missing or older database refuses with the owner's existing
   unsupported-schema code);
2. checks the exact catalog of its own namespace (names, key paths, auto-increment
   and indexes) and that the layout record is `"ready"`;
3. names every store through its namespace and scopes every transaction,
   including its held read view (`HeldReadView`, native-read-reservation.ts:100-122),
   to its own stores;
4. closes on `versionchange`, as today.

Everything else an owner does is unchanged in room mode. In particular its
ordinary write fences still read its own retirement control.

### Retirement marks

An owner's mark is its existing completed retirement control:

| Owner    | Control                               | Store and key                                  |
| -------- | ------------------------------------- | ---------------------------------------------- | ---------------------------------------------- |
| AHE      | `ahe-retirement-control-2             | 3`                                             | `ahe:storageMeta`, `ahe-retirement:<objectId>` |
| Signing  | `signing-retirement-control-1`        | `storageMeta`, `signing-retirement:<objectId>` |
| Snapshot | `snapshot-retirement-control-1`       | `snapshot:retirementControls`, `<objectId>`    |
| Journal  | `v3-live-journal-retirement-control-1 | 2`                                             | `journal:retirementControls`, `<objectId>`     |
| Issuance | `v3-issuance-retirement-control-1`    | `issuance:retirementControls`, `<objectId>`    |

A mark is a write fence (the owner's existing fence rules), an index (which
closed epochs and scopes are retired) and a resume point (the next decision
starts from it). It is never authority: no decision is derived from a mark
([G8](../golden-path-guarantees.md), PLAN:96895-96899; [14b](14b-retention-trust.md)).

The retirement transaction writes each mark in its owner's own codec, by the
owner's own code, as a completed control with no active intent and no pending
drain. Where the owner's codec records one unit per transition (the AHE
`generationDrain` holds one generation), the owner applies its existing
single-unit transitions in order in memory and writes only the final control.

This slice adds no mark store. Track R2's sketch of new `retainedRows`,
`retainedBlobs`, `retainedHeads` and `retirementMarks` stores is not adopted: it
would change every owner's ordinary formats and write fences, which is not needed
to reach one transaction per decision.

### The decision record

The planner ([14b](14b-retention-trust.md)) produces one decision per retirement:

```text
{ version: 1, kind: "room-retention-decision-1",
  objectId, stableEpoch,
  owners: { <owner>: { base, target, through, delete: [...], rewrite: [...] } } }
```

- `base` and `target` are the digests of the owner's control bytes before and
  after; `through` is the target control's `throughEpoch`.
- `delete` lists every row the owner deletes, by exact key and the digest of its
  exact stored bytes as the owner encodes them for its image.
- `rewrite` lists the owner's in-place rewrites (only the AHE lineage-floor
  rewrite, MNT:644-669, and the snapshot survivor's retirement fact), each with
  the exact before and after digests.

The record's digest uses the local domain `ts-drp/retention-decision/v1`. It is
written as `decisionDigest` into every advanced owner control, and it is never
sent, signed or used as authority.

### The retirement transaction

`applyRoomRetirement(decision)` runs one `readwrite` transaction over every
namespaced store, the signing stores and `room:layout`, with
`{ durability: "strict" }`. A transaction whose `durability` is not `"strict"`
aborts before its first request and refuses `RETENTION_DURABILITY`
([G16](../golden-path-guarantees.md), PLAN:1277).

It runs one section per owner present in the decision, in this order:
snapshot, journal, signing, AHE, issuance. Each section is code owned by that
owner's module and does, inside the shared transaction:

1. read its control and require its digest to equal `base`;
2. read every row in `delete` and `rewrite` and the owner's bounded census of the
   retired range ([14e](14e-retention-bounds-and-charges.md)), and require exact
   digests and no unexpected row;
3. recheck the owner's own transactional rules (table below);
4. charge every byte read ([14e](14e-retention-bounds-and-charges.md));
5. delete, rewrite, and put the control whose digest is `target`.

Any refusal aborts the whole transaction, so every store is unchanged, and the
caller retains (retain too much, never too little; [G15](../golden-path-guarantees.md), 6B:183-184).
There is no await on non-IndexedDB work inside the transaction; all hashing that
needs WebCrypto and all signature work happen before it.

Owner rules rechecked inside the transaction (the in-transaction checks of
today's owners, which are all structural, byte or digest checks):

| Section  | Rechecked inside the transaction                                                                                                                                                                                                                                                                                                |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Snapshot | retired scopes are not holes of the target control; every chunk of a retired scope is present and named; survivor scope and its retirement fact bind `currentHead = survivor + 1` and retired epochs below `survivor - 1` (ST:833-870); protected scopes present                                                                |
| Journal  | each drained prefix has exactly one header with `nextJournalSequence` equal to its row count; every row's bytes match; a retired header has zero rows in this transaction's pre-state (a header is never retired together with its own rows, LJ:393-397)                                                                        |
| Signing  | every evidence row is finalized, without peer evidence, with this database's incarnation; no undispatched outbox row in a retired epoch; summary rows only for epochs whose evidence retirement is already in the base control                                                                                                  |
| AHE      | head row and every generation row of the object match the decision; the deleted generations are exactly the classifier's selection (`classifyAheReclamation`, MNT:576-828), Q before P; blobs deleted only when no remaining closure or promotion of any object references them; re-classification after the deletes is a no-op |
| Issuance | no `pendingUnsigned`; each deleted pair exists with equal digests and decodes to its author, object and sequence; no hole and no unfenced plan inheritance target inside the range (RET:1660-1701)                                                                                                                              |

Ordinary owner transactions on the same object are scoped to that owner's
stores, which the retirement transaction also covers, so IndexedDB serialises
them ([G12](../golden-path-guarantees.md), R2E:4854-4868). The planner releases
every held read view it holds on `N` before it starts this transaction; a held
view would make the transaction wait on its own caller.

Refusals added by this slice, each with zero writes:
`RETENTION_DURABILITY`, `RETENTION_LAYOUT` (catalog or layout record not
ready), `RETENTION_STALE` (a base, row, census or rule mismatch),
`RETENTION_CORRUPT` (an undecodable control or row), and the 14e refusals
`RETENTION_CAPACITY` and `RETENTION_BUDGET`.

## Guarantee map

| Guarantee                                                                | How this slice keeps it                                                                                                     |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| [G1](../golden-path-guarantees.md), [G21](../golden-path-guarantees.md)  | One control per owner per object, as today; no per-epoch metadata growth; bounded sections (14e)                            |
| [G4](../golden-path-guarantees.md), [G17](../golden-path-guarantees.md)  | Every owner's existing write fences read the mark this transaction writes; version 7 fences pre-existing code               |
| [G9](../golden-path-guarantees.md)                                       | Each owner rechecks its own facts inside the transaction that deletes, immediately before its deletes                       |
| [G11](../golden-path-guarantees.md)                                      | Currency is read inside the acting read-write transaction, a stricter bracket than a held readonly view                     |
| [G12](../golden-path-guarantees.md)                                      | Native read-write serialisation; no lock or timer stands in for exclusion                                                   |
| [G13](../golden-path-guarantees.md)                                      | No lock is consulted                                                                                                        |
| [G14](../golden-path-guarantees.md), [G15](../golden-path-guarantees.md) | One decision, one transaction; the mark is written in the same transaction as its deletes; every abort leaves the old state |
| [G16](../golden-path-guarantees.md)                                      | Strict only; refusal before any write otherwise                                                                             |
| [G18](../golden-path-guarantees.md)                                      | The AHE lineage-floor rewrite stays in the same owner section as its deletes                                                |
| [G25](../golden-path-guarantees.md)                                      | Version 7 and the layout record fence stale code and half-migrated rooms                                                    |
| [G26](../golden-path-guarantees.md)                                      | Every in-transaction check of today's owners is kept                                                                        |
| [G28](../golden-path-guarantees.md)                                      | Native evidence in [14f](14f-retention-native-evidence.md)                                                                  |

## Runnable RED and acceptance

RED, before any product edit, in new test files only (fake-indexeddb is
mechanism evidence; native evidence is 14f):

1. Upgrade: version 6 to 7 and 0 to 7 create exactly the catalog above and a
   `"migrating"` layout record; an unexpected store or old version refuses with
   zero changes; version-6 code gets `VersionError` on a version-7 database.
2. Room-mode parity: each owner's existing contract cases pass unchanged in room
   mode (a parameterised harness that reuses the existing case bodies, not edited
   copies).
3. Isolation: an AHE held read view does not block a signing or journal
   read-write transaction; an owner refuses to open when the layout record is
   `"migrating"` or its namespace catalog differs.
4. Executor: one decision per owner and all owners together; a base mismatch, a
   changed row, an extra row in the retired range, or a rule failure refuses with
   every store unchanged; abort at the last request leaves every store unchanged;
   a replayed decision refuses `RETENTION_STALE` with zero writes; after success,
   each owner's existing ordinary writer refuses the retired range with its
   existing code.
5. Equivalence of final state: for each owner, the control written by the
   transaction equals, byte for byte, the control the owner's existing
   transitions reach for the same retirement, apart from `decisionDigest`.

GREEN may change only the storage-browser owners named above, their storage
contracts' pure control transitions where a multi-unit composition needs an
export, and the new host. The SQLite backend is out of scope.

## Feedback and stop conditions

- If an owner's ordinary semantics cannot run unchanged in room mode, stop and
  record the case.
- If adding namespaced stores or the cross-owner transaction would require
  changing the IndexedDB ownership registry
  (`packages/storage-browser/tests/fixtures/idb-ownership-checker.ts`), stop and
  ask for a governance review instead of editing it. New raw IndexedDB calls stay
  inside the existing owner modules and their allowed methods.
