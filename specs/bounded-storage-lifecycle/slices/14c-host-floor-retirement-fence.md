# 14c — Per-owner retirement fence in the host floor (S3)

Status: contract draft, 2026-10-19, under the [slice 14 parent](14-single-database-watermark-retirement.md).
No review has run. RED precedes GREEN; no implementation acceptance is claimed.
Guarantee ids are defined, with their sources, in the
[golden-path guarantee checklist](../golden-path-guarantees.md).

## One question

Can a bounded, monotone, per-owner fence record in the existing host floor
database order retirement (step A in the floor before step B in the room
database) so that every crash retains too much, never too little, and a room
database that lost or gained retirement behind the floor's back is detected
rather than trusted?

## Why the floor, and why per owner

The floor stays a separate custody database chosen by the host
(`createBrowserRoomHeadAuthority`, packages/storage-browser/src/room-head.ts).
It already holds the trusted head expectation that every open validates
([02d](02d-declaration-free-shipped-startup.md); [G24](../golden-path-guarantees.md), 02D:14-18).
Retirement adds one more trusted expectation: which retirement each owner's
control should be at.

The record is per owner. Track R2's prototype
(`packages/storage-browser/tests/prototypes/epoch-retirement-store.ts`) first
used one scope-wide number. It hid an issuance row that the planner had held back
for pending work and answered its late acknowledgement `RECORD_PRUNED`, which
breaks [G19](../golden-path-guarantees.md) (6B:162-171) and
[G2](../golden-path-guarantees.md) (R2E:697-700). Per owner, pending work holds
back only its own owner.

The fence does not hide or refuse rows. Rows stay governed by their owner's own
control (the mark, [14a](14a-retention-database-format.md)). The floor fence
orders the two steps and detects mismatch.

## Format

Floor database version 2 adds exactly one object store, `retirementFences`, with
no key path, no auto-increment and no index. It holds at most one record per
scope, keyed by `objectId`, as canonical bytes under the existing
`ROOM_HEAD_IMAGE_LIMITS` (16,384 bytes, depth 8, 128 items):

```text
{ version: 1, scope: RoomHeadScope, revision: integer >= 0,
  owners: [[owner, { through, base, target }], ...] }
```

- `owners` is sorted by owner name, names are unique and come from
  `ahe`, `issuance`, `journal`, `signing`, `snapshot`; at most five entries.
- `through` is the target control's `throughEpoch` (an integer at least 0).
- `base` and `target` are digests of the owner's control bytes before and after
  the decision, as defined in 14a.

The existing `floor` store, its image, its Phase 6b `control` and
`begin`/`commit` are unchanged. The version-1 image codec in `@ts-drp/storage`
is unchanged; the new record has its own capture function and its own local
digest domain, `drp.native-room-head-retirement-fences.v1`, used only for exact
readback.

Version 2 is the stale-code fence for the floor: version-1 code opens with a
fixed version and gets `VersionError`; open version-1 connections receive
`versionchange` and close (the existing handler), and version-1 code refuses a
two-store catalog (`ROOM_HEAD_UNSUPPORTED_SCHEMA`). A host opts in with
`retirementFences: true`; without it the authority opens version 1 exactly as
today. Reopen never creates a missing database, as today.

## Operations

`fenceRetirement({ scope, owners })` runs one strict read-write transaction over
`floor` and `retirementFences`. For each owner in the request:

1. Load the floor image. A missing image or a different scope refuses
   `ROOM_HEAD_CONTROL_CONFLICT`, with zero writes.
2. `through` must be below `stable.epoch`, the existing bound on a completed
   retirement (`roomHeadRetirementChange`, packages/storage/src/room-head.ts).
   Otherwise refuse `ROOM_HEAD_FENCE_WINDOW`, with zero writes.
3. Load the fence record. A record that does not decode, names another scope, or
   repeats or misorders owners refuses `ROOM_HEAD_FENCE_CORRUPT`, with zero writes.
4. With `old` the owner's current entry (absent for an owner never fenced):

   - absent: accept any entry (the first fence of a migrated or new room);
   - `base = old.target`: the previous target was applied;
   - `base = old.base`: the previous target was never applied, and the new
     target replaces it;
   - otherwise refuse `ROOM_HEAD_FENCE_CONFLICT`, with zero writes.

   In both accepted transitions `through` must be at least `old.through`, so a
   fence never moves back even when its target was not applied. A planner that
   cannot yet reach `old.through` (new pending work) retains and waits; the
   pending target stays recorded. An identical entry is an idempotent replay.

5. If nothing changes, return the record without writing. Otherwise write it
   with `revision + 1` and return it.

`readRetirementFences({ scope })` is a read-only point capture that returns the
record or `null`. It borrows a held native read when present, like
`readRetirementImage`.

Neither operation authorizes deletion ([G8](../golden-path-guarantees.md),
PLAN:96895-96899). The planner decides; the floor records each owner's expected
control and enforces only monotone, ordered transitions.

## Order and crash matrix

Step A is this transaction. Step B is the 14a retirement transaction, which
requires each owner's control to equal `base` and writes `target`. A is always
first: B before A would let a crash leave a room database whose controls the
floor never expected.

| Crash point        | Durable state                              | Next open                                                                                                             |
| ------------------ | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Before or during A | Old fences, old controls                   | Consistent                                                                                                            |
| After A, before B  | New fences; each control equals its `base` | Pending: the next decision retires again from verified facts; rows stay readable, governed by the owner's own control |
| During B           | B aborts natively                          | Same as the previous row                                                                                              |
| After B            | Each control equals its `target`           | Consistent; replay is a no-op                                                                                         |

## Check at every open

Before the first decision of a session (the open verification,
[14b](14b-retention-trust.md)), each owner's control digest is compared with its
fence entry:

- equal to `target`: consistent;
- equal to `base`: pending (the crash case above);
- no entry: consistent only for a room whose controls are all still the
  migration copies recorded by [14d](14d-retention-migration.md);
- anything else: the room database lost or gained retirement behind the floor
  (a partial restore, tampering, or a write without step A). Fail closed with
  `RETENTION_FENCE_MISMATCH`. A regressed floor or a mismatched room database is
  never repaired ([G24](../golden-path-guarantees.md), 02D:86-99).

Whole-origin rollback, with floor and room database restored together, is not
detected by anything in the origin. That remains the host's custody and
freshness choice ([G6](../golden-path-guarantees.md), BSL:176-178).

## Refusals and precedence

Lifecycle and substrate errors keep their existing codes (`ROOM_HEAD_CLOSED`,
aborts). Within the transaction: scope conflict, then window, then corrupt
record, then fence conflict. Every refusal makes zero writes.

## Guarantee map

| Guarantee                                                               | How this slice keeps it                                                                                 |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| [G6](../golden-path-guarantees.md)                                      | The floor stays a separate host-chosen database; nothing claims whole-origin rollback detection         |
| [G8](../golden-path-guarantees.md)                                      | A fence records an expectation; it never deletes or authorizes                                          |
| [G9](../golden-path-guarantees.md)                                      | The floor rechecks its own image and record inside its own transaction                                  |
| [G14](../golden-path-guarantees.md)                                     | One bounded record per scope; ordered, idempotent, monotone steps A then B                              |
| [G15](../golden-path-guarantees.md)                                     | Every crash leaves old XOR new controls, with rows retained                                             |
| [G16](../golden-path-guarantees.md)                                     | Strict read-write only; a non-strict transaction refuses                                                |
| [G17](../golden-path-guarantees.md)                                     | A room database whose controls fall behind or run ahead of the floor fails closed                       |
| [G18](../golden-path-guarantees.md)                                     | `through` never decreases and stays below the stable epoch                                              |
| [G19](../golden-path-guarantees.md), [G2](../golden-path-guarantees.md) | Per owner, so pending work holds back only its own owner; rows are never hidden                         |
| [G24](../golden-path-guarantees.md)                                     | A mismatch fails closed and is never repaired                                                           |
| [G25](../golden-path-guarantees.md)                                     | Version 2 fences version-1 code                                                                         |
| [G28](../golden-path-guarantees.md)                                     | Three engines and SIGKILL at A, between A and B, and inside B ([14f](14f-retention-native-evidence.md)) |

## Runnable RED and acceptance

RED, before any product edit, in new test files only:

1. fake-indexeddb: first fence, applied and unapplied transitions, monotone
   `through`, idempotent replay, window refusal, corrupt record, scope conflict,
   fence conflict, zero writes on every refusal, version-1 code refused after the
   upgrade, and unchanged version-1 behaviour when the option is absent.
2. Chromium, Firefox and WebKit: the same cases in a real browser, plus
   `durability === "strict"` observed on the read-write transaction.
3. SIGKILL cases belong to 14f.

GREEN changes only `room-head.ts` in storage-browser, the new capture function in
`@ts-drp/storage`, and the host option. The SQLite floor is out of scope.

## Feedback and stop conditions

If a host cannot accept a floor schema version bump, stop and report: the fence
would then need its own database, which changes the crash matrix.
