# Slice 1 — Recovery bytes outlive temporary transfer expiry

## Current execution order

Live execution status and the next pickup belong to the [handoff](../README.md).
The original combined contract's [review dispositions](../review.md) govern this
reslicing; the [native integration RED](../evidence.md) remains frozen.
Versioned ownership, atomic retention/admission and fixture content delivery are
separate prerequisites, not proof of producer or recipient integration. Pre-sign
producer integration for ready v2 stores needs its own reviewed RED/GREEN seam.
Legacy classification remains required, but follows authenticated discovery,
protected-set planning and cross-store fencing: see the
[migration dependency rationale](../README.md#migration-depends-on-authenticated-selection).
Fresh-store integration cannot count as migrated-room acceptance. This file
is the parent obligation, not permission to implement all mechanisms together.

## Contract

A genuinely adopted successor's required snapshot remains recoverable after
normal transfer TTL maintenance and process death. An unrelated expired
temporary transfer is still removed. Verification is not permanent retention;
the storage owner distinguishes temporary content from explicitly promoted
recovery content. Do not solve this by disabling sweep or extending TTL.

This slice first pins the current-head obligation. Pending-adoption and both
rollback dependency cases are required before retention acceptance, but must
be separate tests and, if their ordering differs, separate sub-slices.
Declaration-free discovery belongs to slice 2: retaining a declaration in the
initial fixture is an explicit coverage limit, not a product completion claim.

## Seam and implementation boundary

Use the existing snapshot storage contract, both adapters, and creator
close/adoption consumers. Promote exact verified scope identity, declaration
and bytes before committing dependence. Sweep/cancel must transactionally
respect recovery ownership, including stale handles. No new caller boolean is
authority to retire content. Recovery ownership release remains subject to the
later authenticated protected-set planner; this slice must neither expose
unrestricted deletion nor silently introduce unlimited pending pins.

Before GREEN freeze the minimal promotion operation, identity validation,
finite staging-capacity behavior, crash ordering, and refusal results through
the requested contract reviews. Do not guess a public API from this prose.
If that requires multiple uncertain mechanisms, split storage-owner promotion
from consumer adoption integration and record each RED/GREEN separately.

## Runnable RED and acceptance

Use the existing native browser production successor fixture and a separate
normative test/artifact namespace. Preserve historical negative reports.

1. Perform genuine fixed-state successor adoption using the authenticated
   settlement fixture; record expected head, state, ACL and issuer sequence.
2. Move controlled time beyond transfer expiry and invoke real maintenance.
3. Confirm unrelated temporary bytes disappear.
4. Fully exit the browser process and reopen the same persistent profile.
5. Recover the authenticated current state and issue the next operation with
   exact sequence, state and authority assertions.

The first RED must fail specifically because required snapshot recovery bytes
are unavailable, not from infrastructure failure or a missing invented API.
Keep exact command, exit status, source hashes and artifacts. A separate GREEN
owner consumes that frozen handoff.

Then prove browser/Node adapter behavior for promotion before/after expiry,
forged or incomplete promotion, stale sweep/cancel handles, aborted/lost
transaction outcomes and bounded staging refusal. Add pending and rollback
consumer tests without hiding missing declarations behind raw database scans.
Keep existing snapshot transfer, receipt, poisoning, creator adoption,
issuance-retention and closed-epoch cleanup regressions green.

Required gates: focused causal RED; independent GREEN; Grok, Kimi capped at
100 steps, Opus xhigh with dispositions; logged typecheck, lint/format and
affected tests. Native engine coverage and process-cold assertions are reported
at the engines actually run. No claim of thousand-epoch storage boundedness is
unlocked by this slice alone.

## Feedback and stop conditions

The user has authorized production-sensible architecture. A new wire/custody
authority requirement, relaxing supported rollback, or replacing full chat
history with lossy deletion would change scope: explain and obtain direction.
Routine internal ownership choices remain in scope. Any expansion across
unrelated mechanisms triggers reslicing before production edits.
