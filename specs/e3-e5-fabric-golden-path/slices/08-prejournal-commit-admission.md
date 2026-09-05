# Slice E5-01: Pre-Journal Commit Admission

## Contract

A co-signed outcome is accepted or rejected identically during local issue,
remote ingress and recovery before any durable journal append or visible
application effect.

## API seam

Add a narrow `V3OperationAdmissionPolicy` application seam to the existing
`v3-live` composition, threaded through `createV3RoomSession`. The zone installs
one exact policy for the `commit-outcome-v1` discriminator; chat installs no
policy and is the preservation control. This does not change the protocol-v3
blueprint schema or registry.

The host invokes the policy in the same serialized live gate before local
issuance and before remote journal append. During recovery it rebuilds the
`@ts-drp/outcome-commit` registry from authenticated accepted outcome vertices
before network subscription. Unknown or malformed operations carrying the
reserved outcome discriminator fail closed. All other operations follow the
existing path unchanged.

`@ts-drp/outcome-commit` is the sole replay owner and classifies an intent as
fresh, exact duplicate or conflicting reuse. Duplicate and conflict both create
zero new journal rows and zero visible effects; conflict has a stable semantic
rejection class. After successful journal/index admission, registry commit
precedes visible projection. A crash after journal append is healed by recovery
rebuild. The reducer consumes already-admitted outcomes and does not retain a
second replay map.

## TDD and acceptance

Two genuine clients prepare and sign one same-zone trade:

- both exact signatures create one durable vertex and one effect;
- one signature, foreign epoch or altered intent creates none;
- exact replay creates no second business outcome;
- same `clientOperationId` with a different intent is rejected before journal;
- disconnect/recover converges on the same one outcome;
- crash boundaries around issuance, journal, publication and visible apply do
  not duplicate or fabricate the outcome.

Run the two-client browser case in <2 minutes and focused admission/unit tests in
<30 seconds.

## Human surface

The workbench shows pending approvals, accepted durable outcome and reconnect
recovery. Run screenshot critique, compare with E5-00, and use the non-blocking
preview window.

## Must stay green

Normal non-commit operations, shared room ordering/recovery, E3/E4, and current
writer/ACL authority.

## Feedback that changes this slice

Only proof that the host-side pre-journal policy or outcome registry belongs in
a different existing sole owner. A local-only, reducer-only or blueprint-marker
check is not acceptable.
