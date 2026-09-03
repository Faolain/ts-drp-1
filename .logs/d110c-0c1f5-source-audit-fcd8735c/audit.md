# D.110c-0c1f5 bounded source audit

## Scope and custody

- Inspected signed/pushed RED anchor: `fcd8735c8316b048166560ab904704102ce90705`.
- Anchor tree: `34a03882ac6d4940d5ca29b317ab59a9c42edb01`.
- The current f2/f4 GREEN draft was inspected only to understand the newly
  exposed interaction. This audit does not approve or alter production behavior.
- No D.110a worker, retained campaign, dependency change, threshold change, or
  wire/API change was run or made.

## Direct source trace

1. `examples/v3-room/src/index.ts::drainRebaseOutbox()` reads authenticated
   displaced/historical rows from `V3PlaneHandle.readRebaseOutbox()` and reduces
   each row to one or more application intents.
2. For `rebase` and `transform`, those intents enter the ordinary
   `pendingIssues` queue. The active room issues and signs new vertices through
   the normal local-issuance transaction, so replacements receive fresh author
   sequence numbers.
3. After all replacement issues complete, the room calls
   `completeRebaseSource()` for each non-held source. The same-store path calls
   `publishPending(registration, row)` and records the old source outbox row as
   published; it does not make that old vertex part of the creator's later
   authenticated close graph.
4. `V3CreatorCloseRegistration.captureCloseGraph()` returns the active graph's
   exact `(author, authorSequence)` identity for each accepted application
   vertex. `authorIssuanceFrontiersCandidate()` groups those observed sequences
   per successor-author.
5. Starting from prior aggregate boundary `S`, the current draft advances only
   through exactly adjacent observed sequences `S+1`, `S+2`, and so on. It
   stops at the first numerical hole.
6. `authenticatedCoveredHistoricalOutboxRow()` later treats a local row as
   creator-covered only when its exact sequence is nonzero and at most the
   authenticated aggregate boundary. Both recovery and filtered-store paths use
   this predicate.

## Demonstrated conflict

Suppose a writer's authenticated boundary is 4. Old local rows 5 and 6 are
displaced, while intervening issuance has already consumed sequence numbers.
Their genuine replacements are admitted as 7 and 8. The creator observes 7 and
8 but not the old 5 and 6, so the contiguous algorithm keeps the boundary at 4.
Every later valid writer row remains above the hole, and cold recovery cannot
authenticate it. This is deterministic lifecycle structure, not scheduling.

A highest-observed-sequence repair is unsafe. If the aggregate advanced to 8
merely because the creator saw 7 or 8, an unseen or substituted locally signed
row at sequence 5 or 6 would become creator-covered without evidence connecting
it to an admitted replacement or authorized terminal disposition.

## Decision boundary

The missing fact is an authenticated, bounded statement that closes each gap:
the source author/sequence/digest, exact replacement or terminal disposition,
and the creator's verification of that relationship. Existing signed vertex
preimages and application operation identities may help verify equality, but
the current aggregate stores neither a per-gap commitment nor a proof that the
creator observed the source side of the mapping.

Therefore no production repair is selected by this audit. D.110c-0c1f5 must
compare a supersession commitment, an authenticated settled-prefix protocol, a
compact range/Merkle accumulator, and any demonstrably sufficient construction
already derivable from existing authenticated material. If no existing material
can carry the missing statement without ambiguity, the work must stop at an
explicit carrier/wire/API prerequisite rather than treating `max(observed)` as
GREEN.

## Required causal proof

RED must use a genuine noncreator durable database, genuine displaced source
rows, ordinary fresh-sequence reissue, creator receipt, at least two subsequent
close/adopt transitions, restart/cold reopen, and a post-reopen issue/publish.
Evidence must identify old and new sequence/digest pairs and the aggregate
boundary. A no-gap control must remain green. Tests-only frontier construction
or private durable-record injection is forbidden.

## Draft-source hashes at audit time

- `examples/v3-room/src/index.ts`:
  `d63a8ab6be34bc6aca85293726982e106d5198c234abf2271aa1195c54d93bd0`
- `packages/node/src/creator-close.ts`:
  `f3b9471a36997a64d3966ee94a58395862b1788c0f4f79787edf4f1ef9c6c437`
- `packages/node/src/v3-live.ts`:
  `9797d496e5a8db3bdd17b2223367ff0be2ae633c45d3170b885f2d10c92ad02e`
- `packages/node/src/internal/creator-transition-advance.ts`:
  `196c4cd9e814250ce8c130f232a00c96812516cb0ce82de2430fe85b766834ff`
