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

Preparation opens the genuine current-epoch author authorization and retains it
inside the prepared payload. Recovery resolves the local issuance author from
that capability, installs journal genesis from sealed preparation bytes, scans
the complete one-record-paged outbox, authenticates the selected committed local
envelope, appends its journal reference and constructs the one retained index.

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
