# D.110c-0c1f3 bootstrap-authority source audit

Audit base: signed/pushed commit
`50b281e3dd9732a2dd7403992ec5336dcd96a0ce`.

## Demonstrated issue path

1. `examples/v3-room/src/index.ts::createV3RoomSessionOwned()` issues
   `input.application.bootstrapOperation` at local author sequence zero with
   epoch zero, the pinned genesis anchor, dependencies containing that anchor,
   and logical time one before live activation.
2. Bootstrap issuance alone does not call `publishAccepted()`. A later
   application issue can publish while the bootstrap row remains pending.
3. `packages/node/src/v3-live.ts::authenticatedPinnedGenesisOutboxRow()`
   currently checks registered-vertex authentication, pinned anchor, epoch
   zero, scope object/author, row sequence equality, and digest equality. It
   does not require sequence zero, exact dependencies, logical time one,
   reserved action `join`, or equality to the configured application bootstrap
   operation.
4. The later room rebase drain treats an authenticated `pinned-genesis` row as
   zero-intent completion custody and does not publish it directly at the old
   anchor. This is why Bob sequence zero stays absent from Alice's graph while
   sequence one can later be admitted.
5. The diagnostic aggregate draft consequently records Bob null, refuses to
   cross directly to sequence one, and leaves the unchanged signed browser RED
   failing. Adding an epoch-zero application write makes Alice observe the
   complete prefix and the control pass, confirming the missing seam.

## Available and missing authority

- The creator-signed aggregate can authenticate the greatest contiguous
  creator-observed post-bootstrap sequence.
- The local transactional issuer can authenticate dense non-equivocating
  `(objectId, author, sequence)` issuance, but not creator observation.
- The author signature, genesis ACL, blueprint reducer, and local lineage do
  not distinguish the intended bootstrap payload from another valid
  self-signed epoch-zero application payload.
- `V3OperationAdmissionPolicy.reserve(operation)` is a generic admission and
  deduplication policy. It receives no sequence/epoch/bootstrap context and
  does not provide exact bootstrap equality.
- `V3RoomApplication.bootstrapOperation` is the trusted local product policy
  fact that identifies the intended bootstrap payload.
- `RecoverV3LiveReplicaInput`, `RecoveredV3LivePayload`, and private creator
  successor live/reopen material do not currently carry that fact. The room
  can supply it for ordinary recovery and cold reopen, while hot adoption must
  copy it through private successor custody from the source registration.

## Decision

Do not weaken the contiguous-prefix rule, publish bootstrap joins, infer
bootstrap authority from an action string, or treat self-signature as creator
admission. Use a uniform constrained candidate 2:

- sequence zero is an exact application-defined pinned-genesis bootstrap base;
- aggregate `S` authenticates creator-observed slots `1...S` (and may record
  zero when slot zero was actually observed);
- recovery proves exact paired dense local rows `0...S`;
- slot zero uses only the exact bootstrap predicate;
- slots `1...S` use only creator-covered historical authority; and
- a first observed slot greater than one or hidden post-bootstrap history under
  a null frontier fails closed.

The exact bootstrap policy must cross a public `@ts-drp/node/v3-live` recovery
compatibility boundary. D.110c-0c1f4 owns that API/custody change and its
focused RED/GREEN. No signed carrier, vertex wire, dependency, authority,
threshold, workload, or publication behavior change is selected.

## Required verification seams

- one shared exact pinned-genesis predicate for direct recovery and filtered
  issuance-store classification;
- unconditional sequence-zero rejection in covered-historical classification;
- detached canonical-byte capture and mutation resistance;
- hot adoption, pending resume, and cold reopen retention;
- exact issued/outbox pairing and contiguous index accounting;
- fail-closed missing/substituted/forked/out-of-order/mismatched rows;
- unchanged recovery behavior when no pinned-genesis historical row is used;
- original browser RED preconditions and unchanged causal treatment; and
- maximum-shape, combined scan, census, pruning, rollback, protected-path,
  stash, signed-commit, pushed-ref, and manifest gates.
