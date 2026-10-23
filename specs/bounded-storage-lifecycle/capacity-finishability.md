# Capacity finishability and larger epochs

The shipped application scope is `creator-trusted-settlement-v1`, the Track P
R-A choice. A successful capacity test proves that **accepted** work can finish,
preserve the exact application projection, and return to useful admission. It
does not promise that every offered operation fits in one epoch. The legacy
`creator-trusted-v1` profile remains diagnostic-only here; this work adds no
legacy deletion rule or new reserve policy.

The executable probe lives in
[the native capacity test](../../tests/creator-capacity-finishability-native.test.ts).
It distinguishes individual native APP records from application edits coalesced
by the existing batching owner. Every serial capacity refusal compares the
complete native row images before and after. After admission, the probe checks
seal, adoption, recipient installation, maintenance, exact projection, and a
subsequent useful write. Its native byte metric counts BLOB/TEXT payloads;
canonical diagnostic dumps and physical database files are reported separately.

## Why the recovery rules matter

A retirement cut is a monotone frontier, not an intent identity. An active
preparation must finish with its exact decision and source digests. After that
preparation completes, a newly authenticated source at the same cut can release
holes whose final journal consumers are physically absent. Permanent excluded
rows remain excluded. This rule belongs to the original closed retirement
owner in [the closed-data implementation](../../packages/node/src/internal/creator-closed-rollback-data.ts).

Startup may encounter an active native preparation after committed journal
cleanup. The original readiness queue can resume only the same private request,
current head and floor, with the expected domains and no nominee. Ordinary
admission remains halted until terminal reconciliation and every admitted
release join. This stays inside the existing replay read phase; it introduces
no second replay gate.

The native ordinary issuance path still checks the complete original entry
image. Where there is no settlement plan or plan effect, same-connection SQLite
currency checks can account for only the owner's new material at subsequent
writer boundaries. Expected own DML, `data_version`, `total_changes`, and exact
control bytes are checked at every boundary; other contexts retain complete
readback. This numerical optimization supplies no retirement authority and
depends on native SQLite counter semantics that abstract models do not prove.

## Evidence at common commit 57124615

The longer campaigns ran the common recovery/maintenance implementation before
the final active-startup gate change. That change was exercised separately by
the real process-death tests below. The optional legacy APP-elision patch is
excluded from the common commit and is outside these shipped-profile results.

| Shipped campaign | Accepted work per cycle | Result |
| --- | --- | --- |
| Offer 128 individual native APP records, four cycles | 128, 128, 79, 77 | All four cycles finished, preserved recipient state, and admitted the next write; fourth-cycle maintenance retired old journal data. |
| Offer 1,024 application edits in batches of 64, six cycles | 1,024, 1,024, 464, 656, 784, 256 edits, represented by 64, 64, 29, 41, 49, 16 native APP records | All six cycles finished and resumed admission through epoch 7, including maintenance and a mandatory-fence-only transition. |

These are finite finishability receipts, not a capacity floor, steady-state
proof, throughput claim, or UI responsiveness result. Both campaigns used 32
overwritten application slots on a shared, loaded machine. The serial campaign
accepted 412 user records; the batched campaign accepted 4,208 user edits.

The logs are
`/private/tmp/creator-capacity-settlement-native128x4-01.log` and
`/private/tmp/creator-capacity-settlement-edits1024x6-01.log`. Each completed with
exit 0. Earlier 512-record offers are preliminary baseline observations, not
evidence for a 512-record epoch on this final common commit.

[The process-death test](../../tests/creator-capacity-retirement-crash-native.test.ts)
kills its disposable worker with SIGKILL immediately after a real SQLite COMMIT,
then recovers the same files in another process. Both shipped edges passed:
committed journal deletion and committed active issuance preparation. Recovery
preserved the accepted projection and admitted a new APP. For active issuance,
the exact frozen preparation completed before any fresh same-cut intent.
Evidence directories are
`/private/tmp/creator-capacity-settlement-death-journal-02` and
`/private/tmp/creator-capacity-settlement-death-issuance-02`; each contains
`death.json`, `projection.json`, and `recovered.json`. Mutation exits by killed
worker are expected; recovery logs ended with exit 0.

The final independent common-only review reported no actionable regressions.
Affected-package typechecks and 22 focused controls passed. Native currency
controls separately passed 26 tests. A broader readiness/maintenance run had
77 passes, one stale source-extraction argument-list assertion, and a Vitest
RPC timeout; it is not an all-green suite claim. The assertion belongs to the
concurrent authenticated recovery-role plumbing and is covered by that lane's
final signature check. Eight broad storage test failures also reproduced on
the unchanged base during review. Review output is
`/private/tmp/ts-drp-membership-point-review.log`.

## Larger-epoch acceptance plan

Increase offered native record counts independently from logical edit counts:
128, 512, and 1,024 serial APP offers, followed by the corresponding batched
edit offers. A refusal ends admission for that cut and triggers the existing
finish-and-maintain workflow; it never authorizes a budget increase, empty cut,
age-based deletion, or skipping authenticated dependency coverage. Report both
offered and accepted records, retained payload bytes, and the exact refusal
boundary.

Repeat each shape beyond the first physical retirement and subsequent same-cut
reselection. Then vary independent writer count and delayed authenticated
dependencies while keeping native count, application state size, and batching
separate. A held dependency must retain its real consumer; releasing it must
allow the original owner to reconsider the current authenticated source.
Repeat both committed process-death edges at the largest actually admitted
shape and require exact frozen-intent completion before fresh selection.

The final integrated candidate must rerun the relevant recovery/admission
controls with the outer replay phase and authenticated gap roles together.
Measure own CPU and event-loop delay separately from wall time during sealing,
adoption, and installation. A passing finite finishability campaign cannot
close the responsiveness gate or replace the independently owned 300-epoch
application endurance campaign.
