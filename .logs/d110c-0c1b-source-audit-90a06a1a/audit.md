# D.110c-0c1b bounded source/architecture audit

Audit anchor: signed/pushed commit
`90a06a1aae79d408a1c2c6b014dae1a99daf866d`, tree
`8a85703957dc6e4eb4f8351de008cebc4be02348`.

## Demonstrated defect

`packages/node/src/v3-live.ts::issueOneVertex()` returns from
`issuer.issue()` normally returns only after
`DurableIssuanceStore.transactIssue()` has committed the exact issued record
and pending outbox row. All failures from `committedFailure()` therefore occur
after durable issuance. There is also one pre-return ambiguous arm: both real
issuance stores can commit and then throw exact
`ISSUANCE_OUTCOME_UNKNOWN` when the bounded terminal readback is unavailable.
The surrounding catch and `committedFailure()` set
`operationAdmissionHalted` only when an optional operation-policy reservation
exists. Even when they do set the flag, neither
`creatorCloseRegistration()` nor the queued `stageClosedBlueprintEpoch()`
checks it. A close can consequently fold/capture a graph that omits a durable
issued row.

The queue ordering makes the dynamic omission deterministic. Creator snapshot
staging sets `blueprintClosing` synchronously, then queues
`stageClosedBlueprintEpoch()` behind all earlier registration tasks. If an
earlier issue has committed but its journal append then fails, the issue task
sets the recovery-required flag and completes; the queued fold runs next and
currently ignores that flag.

## Existing recovery owner

`recoverV3LiveReplica()` already owns exact reconciliation. Its outbox scan:

- pages the real issuance store and point-reads the matching issued record;
- requires byte-exact issued/outbox equality;
- authenticates current/displaced authority, signature, object, epoch,
  anchor, author, sequence, operation, dependencies, ACL and terminal order;
- reserves the operation policy;
- appends the local-issued journal row, accepting idempotence only when the
  graph already contains the same authenticated vertex;
- appends the graph and retained application vertex exactly once; and
- commits the recovered operation reservation or rejects activation.

The retained E5-01 recovery test already demonstrates the adjacent
post-journal ambiguous case rebuilding the reservation exactly once. No new
durable marker, schema, API, wire field, dependency, authority rule or store
operation is necessary for this defect.

## Selected minimal repair

This is composition/orchestration, not new product data:

1. Every `committedFailure()` after `issuer.issue()` returned a durable commit
   unconditionally sets the existing `operationAdmissionHalted`
   recovery-required flag. The surrounding catch also sets it when the thrown
   error has exact code `ISSUANCE_OUTCOME_UNKNOWN`, independent of whether an
   operation admission policy is installed. Definitely pre-transaction
   signer and capacity failures retain their existing release/retry behavior.
2. `creatorCloseRegistration()` refuses to mint a close registration while
   that flag is set.
3. `stageClosedBlueprintEpoch()` rechecks the same flag after the registration
   queue barrier, so a close handle bound before an in-flight issue cannot fold
   after that issue reports a committed failure.

The recovery flag remains in-memory and conservative. It does not purport to
prove reconciliation. Deactivation plus genuine recovery is the only path
that creates a fresh registration with the flag clear, and activation occurs
only after the existing authenticated outbox/journal reconciliation succeeds.

## Rejected alternatives

- In-process close-time outbox repair: duplicates the recovery authority and
  application pipeline inside creator close and widens failure ordering.
- Skipping or retiring the orphan at close: treats durable issuance as
  authority, loses a signed operation, breaks the dense sequence frontier, and
  can hide unpublished work.
- Deleting or marking the row published: falsifies durable issuance/outbox
  truth and publication custody.
- Adding an issuance outcome marker or transaction spanning two stores: not
  required because the existing recovery scan already reconciles the exact
  durable row; would introduce schema/store-contract work.
- Weakening retirement derivation to accept a gap or stale epoch: violates the
  authenticated dense frontier and masks the defect.

## Frozen RED witness

A tests-only fixture uses the genuine issue path and real store implementations.
It first admits sequence 0 so the current retirement boundary is non-empty,
then uses a one-use journal adapter that blocks at sequence 1's target
`local-issued` append and rejects without writing. It binds creator close
before releasing the failure, calls close while issue owns the registration
queue, then releases the journal rejection. At current code the issue returns
the existing
`journal-rejected` class, the exact issued/pending-outbox row survives, the
journal and graph omit it, yet the queued creator close advances. After genuine
adoption/restart, the next close fails with exact
`D110C_0C1A_RETIREMENT_CHECKPOINT_UNAVAILABLE` because the row retains the old
authenticated epoch/anchor. Test case id
`D110C_0C1B_COMMITTED_ISSUANCE_RECOVERY_REQUIRED` marks unexpected advancement;
it is not a product error. GREEN must preserve the existing product surfaces:
bind-after-failure returns `CREATOR_CLOSE_UNAVAILABLE`, while a pre-bound close
fails through the existing `creator snapshot export failed: not-active` path.
No fixture inserts, mutates, deletes, republishes or reclassifies the row.

## Frozen GREEN and retained gates

GREEN changes only the three internal checks above. The same fixture must show
both pre-bound and post-failure bind orderings refuse close without changing
the durable head, snapshot, graph or row. A second issue is rejected without a
new issuance transaction. After deactivate/recover of the same epoch, the
existing product recovery path must admit the exact row once, restore exact
application and operation-policy state, and allow genuine 0→1 close/adoption,
restart/reopen, genuine 1→2 close/adoption, and continued issue/publish after
epoch 2. Assertions cover no duplicate journal/graph/application entry, no
sequence skip, no hidden pending row, exact carrier boundary and non-null
continuation, exact state digest and operation count.

Fault cases cover failure before journal write, journal write then thrown
outcome, graph append failure, policy-commit failure, a non-terminal
`ISSUANCE_OUTCOME_UNKNOWN` after durable commit with no operation policy, close
racing the failure, close binding after the failure, repeated recovery,
substituted issued/outbox row, stale epoch/anchor, invalid dependency/ACL,
capacity, and terminal classification. The conservative halt also refuses new
local and received admissions and a received-path uncertain outcome can refuse
close; this fail-closed reuse is intentional. On queued-fold refusal,
creator-close's existing abort path clears `blueprintClosing` while
`operationAdmissionHalted` remains set; the refused mint consumes no close
claim, and only deactivate/recover creates a fresh close-capable registration.
Existing fail-closed error classes remain unchanged; the RED token is test-only.
Retain D.110c-0c1a, E5-01 admission/recovery, Phase-6a
successor recovery/adoption, issuance/outbox/rebase, AHE rollback, snapshot,
D.109 reclamation, exact-owner static gates, and the D.110c-a/b hot path. No
campaign or D.110a invocation is permitted.
