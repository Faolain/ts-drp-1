# 14e — Bounds and charges for single-transaction retirement (S5)

Status: contract draft, 2026-10-19, under the [slice 14 parent](14-single-database-watermark-retirement.md).
Implementation (Track R3): not started. See the [parent status](14-single-database-watermark-retirement.md#status-track-r3-2026-10-19-opt-in-stage-1a-only).
No review has run. The per-transaction cap below is new policy and needs review
before acceptance runs (BSL:261-263). RED precedes GREEN.
Guarantee ids are defined, with their sources, in the
[golden-path guarantee checklist](../golden-path-guarantees.md).

## One question

Is every retirement transaction, open verification and migration step bounded
in rows, bytes and requests by reviewed limits, and is every byte it reads
charged before its first irreversible effect?

## Bounds

Existing reviewed limits stay the owner bounds; this slice adds no owner limit:

| Owner        | Existing bound (source)                                                                                                                                   |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AHE          | `AHE_BOUNDED_READ_LIMITS`: 7 generations per object, 786,432 union bytes, 65,536 bytes per blob, 7 closure references (packages/storage/src/types.ts:146) |
| Journal      | `LIVE_JOURNAL_RETIREMENT_LIMITS`: 7 protected scopes, 24,576 rows, 2,097,152 image bytes (packages/live-journal/src/retirement.ts:33-37)                  |
| Snapshot     | 4 recovery scopes and `maxRecoveryContentBytes`; 2,048 chunks per scope (packages/storage/src/snapshot-transfer.ts:344-346, 1682)                         |
| Signing      | 65,536 image rows and the signing union byte limit (packages/storage-browser/src/internal/signing-retirement.ts)                                          |
| Issuance     | the existing per-scope lineage and outbox bounds (packages/storage-browser/src/internal/browser-issuance-store.ts)                                        |
| Proof budget | `maintenanceProofBytes` 4,194,304 (packages/storage/src/types.ts:128)                                                                                     |

New policy for one retirement transaction (proposed here, to be reviewed):

- at most **512 row deletes and rewrites** in total, and
- at most `maintenanceProofBytes` of charged reads.

Rationale, stated before any new measurement: the existing drains bound one
native transaction at 16 point deletes (`LIVE_JOURNAL_RETIREMENT_BATCH_ROWS`,
`SIGNING_DETAIL_RETIREMENT_BATCH_ROWS`) because one decision could cover a whole
24,576-row journal image across many transactions. One room transaction must
stay a bounded main-thread task, so it gets its own count bound, sized to the
largest steady-state epoch of the supported 64-writer profile with headroom
(Track E measured 103 writes per epoch on the 8-rollover Grid), and the existing
byte budget. Neither bound is an eligibility rule.

Decisions above the cap are split by the planner into ordered continuation
decisions. Each continuation is a complete decision with its own step A and step
B ([14c](14c-host-floor-retirement-fence.md), [14a](14a-retention-database-format.md)),
ordered by the real dependencies in [14b](14b-retention-trust.md). There is no
partial transaction and no cursor: each continuation commits whole or not at
all. The number of continuations per epoch is bounded by the owner bounds above
divided by the cap.

Every read in step B is bounded before it is issued: point reads by key, and
census reads with `getAll(range, bound + 1)` or `count(range)` so that an
over-bound range refuses instead of loading more
([G21](../golden-path-guarantees.md), BSL:266).

## Charges

- Step B charges every row it reads (controls, deleted and rewritten rows,
  survivor rows it compares, census rows) at its exact stored byte length, into a
  fresh operation-local maintenance proof book, before its first delete. Over
  budget refuses `RETENTION_BUDGET` with zero writes.
- The snapshot section keeps today's turnover census check and its accounting
  unchanged (the snapshot owner's own recovery limits), because its chunk content
  is bounded by those limits rather than by the proof budget today.
- Each open verification ([14b](14b-retention-trust.md)) pays the charges of the
  existing cold acquisition, unchanged.
- Nothing is refunded, carried between transactions or shared between decisions
  ([G22](../golden-path-guarantees.md), BSL:21-24).

## Backpressure

A decision that the planner cannot apply (over cap after splitting is impossible,
over budget, a blocked owner, a stale refusal) retains. Existing pool-capacity
backpressure then applies unchanged: admission stops when maintenance cannot
drain ([G2](../golden-path-guarantees.md), BSL:269-272). This slice adds no new
admission path and no new way to accept work.

## Migration bounds

[14d](14d-retention-migration.md) reads and copies whole legacy databases. Each
legacy database is bounded by its owner's limits above, so one migration is
bounded. A legacy database over its owner's bounds refuses migration
(`RETENTION_CAPACITY`) and keeps the existing layout.

## Guarantee map

| Guarantee                           | How this slice keeps it                                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| [G1](../golden-path-guarantees.md)  | The retained window is the owner bounds; retirement keeps up with one decision per epoch plus bounded continuations |
| [G2](../golden-path-guarantees.md)  | Refusals retain; existing admission backpressure applies                                                            |
| [G21](../golden-path-guarantees.md) | Count and byte bounds on every transaction and every read; the one new cap is explicit policy for review            |
| [G22](../golden-path-guarantees.md) | Fresh book per transaction; charged before the first delete; no refunds                                             |
| [G26](../golden-path-guarantees.md) | No bound is relaxed; the 16-row batch is replaced by a reviewed per-transaction cap, not removed                    |

## Runnable RED and acceptance

RED, in new test files only:

1. A decision of 513 deletes refuses `RETENTION_CAPACITY` with zero writes; the
   planner splits it into continuations that each commit whole.
2. A decision whose reads exceed the budget refuses `RETENTION_BUDGET` with zero
   writes.
3. Charges are recorded before the first delete and never refunded (trace of the
   proof book).
4. An over-bound census range refuses without materialising more than
   `bound + 1` rows.
5. An over-bound legacy database refuses migration and keeps the existing layout.

## Feedback and stop conditions

If review rejects the 512-row cap, the cap changes here before any acceptance run
and the evidence is rerun. If a supported-profile epoch needs more than one
continuation in steady state, record it: that is a latency finding, not a reason
to raise the cap without review.
