# Slice 00: Authorized Durable Recovery

## Question

Can the existing node composition recover one genuinely issued local vertex
into the live journal and sole causality index, using P6 authorization and real
durable carriers, before any live effect occurs?

## Seam

Add one asynchronous private recovery function to the existing v3 live owner.
It consumes a genuine prepared capability, exact author-authorization carrier,
issuance scope/store and live-journal store, and returns one opaque recovered
capability.

Recovery opens the genuine current-epoch author authorization from the prepared
trust and sealed carrier bytes. It resolves the local issuance author, installs
journal genesis from sealed preparation bytes, scans the complete
one-record-paged outbox, authenticates the selected committed local envelope,
appends its journal reference and constructs the one retained index.

The checkpoint transcript is:

```text
authorized -> issued-record-authenticated -> journaled -> indexed -> ready
```

## Acceptance

- A real already-issued local record absent from an empty journal reaches READY.
- Pending and published records are both considered.
- Recomputed, issued-envelope and journal digests must agree.
- Missing, malformed, foreign or poisoned issuance evidence fails closed.
- An unauthorized author fails before journal, issuance, index or live effects.
- Journal append precedes index append; no queue, network, sink, fold or publish
  effect occurs before READY.
- The recovered capability and retained index cannot be forged, cloned, reused
  or exposed.

## Owners

Production changes are limited to the node private live owner, its direct
live-journal dependency and lockfile importer. Focused tests may transition the
existing private-surface contracts and add D.93.36 fixtures. Protocol-v3,
storage adapters, issuance and journal production owners remain unchanged.

## Feedback that changes this slice

Only evidence that the shipped P6, issuance or journal interfaces cannot support
the recovery ordering above. UI, reducer and network concerns belong to later
slices.

## Shipped checkpoint

Signed commit `3fabce94891539e53bd644dca60f68d028c7c3b7` implements this
private recovery seam without changing protocol-v3, storage adapters, wire
formats, public node exports or live effects. The focused live composition set
passed 60/60 in 16.54 seconds; the authorization, journal and issuance
preservation set passed 65/65 in 15.39 seconds; and the node package build,
lint, formatting and diff checks passed on the same bytes.

This checkpoint recovers exactly one durable local record into an initially
empty journal. Complete replay, reconciliation and reuse of the retained
recovery capability belong to Slice 01 and later slices.
