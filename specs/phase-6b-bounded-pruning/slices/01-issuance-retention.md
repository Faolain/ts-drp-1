# D.109b — Issuance Retention

Keep the mandatory six-method `DurableIssuanceStore` contract unchanged. Each
Node/browser adapter adds a separate package maintenance capability that is
resolved by object identity only for its genuine concrete store; a structural
stub cannot mint it. Inside the issuance owner’s single native transaction,
page/scan the selected scope rows, decode canonical preimages, prove epochs and
author sequences form the selected complete published prefix, recheck the
closed-epoch boundary, and delete only paired `published` issued/outbox rows. A
`pending`, malformed, one-sided, foreign-digest, unreadable, gapped,
non-monotone, or newly changed row aborts with zero writes. Node, browser, and
conformance-memory implementations must agree.

The same transaction advances one durable per-scope pruning watermark through
the exact deleted prefix while retaining the lineage CAS row. Browser upgrades
its existing `--drp-issuance-v1` database in place; Node upgrades its existing
`.drp-issuance-v1.sqlite` catalog in place. Neither changes the derived storage
identity or creates an empty replacement database. Terminal classification,
`readIssued`, and publication acknowledgement distinguish an address at or
below the watermark as `pruned`, not `ISSUANCE_RECOVERY_CORRUPT`. Reads return
absence. A late or raced acknowledgement returns the new exact closed error
`ISSUANCE_RECORD_PRUNED`; because the deleted digest is no longer available,
it must not claim exact-digest CAS success. This error carries only the
caller-known scope and sequence, never a digest or deleted candidate. Above-
watermark consumed absence retains the existing corruption classification.

RED covers every row classification, page boundaries, prefix gaps and epoch
regression, stale expected lineage/watermark, late duplicate and wrong-digest
acknowledgements, two-handle races, shared terminal recovery, transaction abort
edges, schema upgrade, crash/reopen, idempotence, and unrelated-scope
preservation. GREEN returns an immutable issuance cleanup receipt containing
the exact deleted key range, resulting watermark, and observed lineage
revision; it adds no scheduler.
