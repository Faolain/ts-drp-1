# 14d — Migration from six databases to the room database (S4)

Status: contract draft, 2026-10-19, under the [slice 14 parent](14-single-database-watermark-retirement.md).
Implementation (Track R3): not started. Until it exists, the room database host refuses
an existing version-6 room with `V3_ROOM_DATABASE_MIGRATION_UNAVAILABLE` before any
write. See the [parent status](14-single-database-watermark-retirement.md#status-track-r3-2026-10-19-opt-in-stage-1a-only).
No review has run. RED precedes GREEN; no implementation acceptance is claimed.
Guarantee ids are defined, with their sources, in the
[golden-path guarantee checklist](../golden-path-guarantees.md).

## One question

Can an existing six-database browser room move to the room database layout
([14a](14a-retention-database-format.md)) so that every crash leaves exactly one
authority or none, no stale connection can write either layout, and migration
neither trusts nor discards anything?

## Rules

- **Migration moves bytes; it decides nothing.** Every row is copied verbatim
  (same key, same value). Nothing is verified, classified, repaired, dropped or
  made collectible by migration. Authentication stays where it is today: the open
  verification of every session ([14b](14b-retention-trust.md);
  [G5](../golden-path-guarantees.md), PLAN:6967-6968).
- **Fence before copy.** No legacy database is read for the copy until it is
  fenced against every writer.
- **One authority.** Before the copy commits, the legacy databases are the only
  authority and the room namespaces are empty. After it commits, only the room
  database is read. The legacy databases are never read as authority again
  ([G25](../golden-path-guarantees.md), BSL:216-221).
- **Never deleted, only emptied.** A legacy database stays at its fenced version
  after it is emptied. Deleting it would let pre-existing code create a fresh one
  under the old name and write there; a version it cannot open stops it.
  (Track R2's prototype deleted the legacy databases; that is withdrawn.)
- **Quiescent sources only.** A legacy owner control with an active intent or a
  pending drain refuses migration with `RETENTION_MIGRATION_BUSY`, before any
  fence. The room keeps the existing layout and path until the existing path
  completes that retirement, then migrates on a later open.

## Steps

The room host runs migration at open, before any owner opens in room mode.

| Step | Transaction                                                                                                                                      | Effect                                                                                                                                                                                                             |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M1   | Upgrade `N` from 6 (or 0) to 7                                                                                                                   | Namespaces created empty; layout record `"migrating"`. Pre-existing code can no longer open `N`, so no pre-existing session can start.                                                                             |
| M2   | For each legacy database (`N--ahe` 6, snapshot 4, journal 3, issuance 3): open at version + 1 with an upgrade that only checks its exact catalog | Pre-existing code pinned to the old version gets `VersionError`; open old connections receive `versionchange` and close; a blocked upgrade refuses `UPGRADE_BLOCKED` and migration stops with nothing copied.      |
| M3   | One read-only transaction per fenced legacy database                                                                                             | Every row of every store, with its key, read in key order, bounded by the caps of [14e](14e-retention-bounds-and-charges.md).                                                                                      |
| M4   | One strict read-write transaction in `N`                                                                                                         | Every row put verbatim into its namespace store; the layout record gets one `sources` entry per legacy database with its fenced version and receipt digest. The namespaces must be empty before; otherwise refuse. |
| M5   | One strict read-write transaction per legacy database                                                                                            | Delete every row, using that owner's existing delete method; the database stays at its fenced version.                                                                                                             |
| M6   | One strict read-write transaction in `N`                                                                                                         | Layout record `"ready"`.                                                                                                                                                                                           |

The receipt digest of a legacy database is SHA-256 over the canonical sequence of
its (store, key, value) triples in key order, under the local domain
`drp.room-migration-receipt.v1`. It binds what was copied to what was read; it
is not authority. At M5 and on every later open before `"ready"`, the room
namespaces must still reproduce the recorded receipt, or migration fails closed.

## Crash matrix

| Crash after        | Next open sees                                                                        | Resumes at                                     |
| ------------------ | ------------------------------------------------------------------------------------- | ---------------------------------------------- |
| M1 (or during M2)  | `N` at 7, `"migrating"`, empty namespaces, legacy databases at old or fenced versions | M2 (fencing is idempotent)                     |
| M2 or M3           | All legacy databases fenced; namespaces empty                                         | M3                                             |
| During M4          | M4 aborted natively; namespaces empty                                                 | M3                                             |
| M4                 | Namespaces full; receipts recorded; legacy databases still full                       | M5 (rows are compared with the receipts first) |
| During or after M5 | Some legacy databases empty                                                           | M5 for the others                              |
| M6                 | `"ready"`                                                                             | No migration                                   |

At every point there is exactly one authority: the legacy databases until M4
commits, the room database after. Owners open in room mode only at `"ready"`,
and the existing layout cannot open once M1 has run, so a crashed migration
leaves the room unavailable until it resumes, never served by two layouts.

## Unverifiable rows

Migration never verifies, so it never meets an "unverifiable" row: it moves the
exact bytes. A row that the open verification would reject before migration is
rejected identically after it (same bytes, same verifier, same code). A row whose
value cannot be read or copied (a structured-clone or quota failure) aborts M3 or
M4 with nothing written to `N`; the legacy databases stay fenced and intact as
evidence, the layout stays `"migrating"`, and the room fails closed with
`RETENTION_MIGRATION_FAILED`.

## Retirement state across migration

Controls are copied verbatim, so every owner keeps its exact retirement frontier
and holes; nothing becomes collectible by migration. The floor has no fence entry
for a migrated room until its first decision; 14c's open check accepts a missing
entry only while each control is byte-identical to its migrated copy, which the
receipt binds. The first step A of the first decision records `base` as the
migrated control's digest.

Rebase-source and scratch AHE databases are other storage identities. They are
not migrated and keep their existing layout.

## Guarantee map

| Guarantee                                                              | How this slice keeps it                                                                                             |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| [G5](../golden-path-guarantees.md)                                     | Bytes stay untrusted; the open verification runs as before, on identical bytes                                      |
| [G15](../golden-path-guarantees.md)                                    | Each step is one transaction; every crash leaves one consistent layout or an unavailable room                       |
| [G16](../golden-path-guarantees.md)                                    | Strict read-write transactions only                                                                                 |
| [G17](../golden-path-guarantees.md)                                    | Legacy databases stay fenced at a version pre-existing code cannot open; nothing is deleted that could be recreated |
| [G24](../golden-path-guarantees.md)                                    | The floor is not changed by migration                                                                               |
| [G25](../golden-path-guarantees.md)                                    | Fence before copy; one atomic copy with receipt; no second authority; stale connections closed by version change    |
| [G7](../golden-path-guarantees.md), [G8](../golden-path-guarantees.md) | Migration makes no retirement decision and grants no authority                                                      |
| [G21](../golden-path-guarantees.md)                                    | Bounded by 14e's migration caps; over cap refuses and keeps the legacy layout                                       |
| [G28](../golden-path-guarantees.md)                                    | SIGKILL at each step in three engines ([14f](14f-retention-native-evidence.md) case 9)                              |

## Runnable RED and acceptance

RED, in new test files only:

1. A six-database room with retired and unretired epochs migrates; every owner's
   rows, controls and refusals are byte-identical before and after; the legacy
   databases are empty at their fenced versions.
2. Pre-existing code opening `N` or any legacy name after M1/M2 gets
   `VersionError`; an open pre-existing connection is closed by `versionchange`.
3. Crash at every row of the matrix (fake-indexeddb abort injection), then
   resume: same final state; no step reads a legacy database after M4.
4. A busy legacy control refuses before any fence; a non-empty namespace at M4
   refuses; a receipt mismatch fails closed.
5. A room the open verification rejects before migration is rejected after it,
   with the same code.

## Feedback and stop conditions

If emptying a legacy database needs an IndexedDB method its owner is not
allowed today (`packages/storage-browser/tests/fixtures/idb-ownership-checker.ts`),
stop M5 and leave the fenced legacy databases full: they are inert but still
occupy space. Record that as an open item instead of changing the registry.
