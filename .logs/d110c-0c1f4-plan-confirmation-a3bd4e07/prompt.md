Perform the single material confirmation of the corrected high-risk
D.110c-0c1f3 decision and D.110c-0c1f4 exact pinned-genesis bootstrap recovery
authority prerequisite at signed/pushed commit
`a3bd4e07bce71876fd98ed4e6ded30c1aef49cd3`, relative to first reviewed plan
`50b281e3dd9732a2dd7403992ec5336dcd96a0ce` and signed causal RED
`c584b76bb7376fe2cbf4664dfdebacab8c153568`. This is read-only. Do not edit,
run tests, delegate, or spawn subagents. Return only one JSON object matching
the supplied schema.

Inspect:

- D.110c-0c, D.110c-0c1, D.110c-0c1f/f1/f2/f3/f4, D.110c-c, and D.110c-d in
  `docs/production-hardening/production-hardening-tdd-plan-v2.md`;
- `.logs/d110c-0c1f3-plan-review-50b281e3/{trace.md,review-results.md,source-audit.md,local-audit.md,SHA256SUMS}`;
- signed RED commit `c584b76bb7376fe2cbf4664dfdebacab8c153568` and
  `.logs/d110c-0c1f2-red-f488f1f6/`;
- the current working-tree production diff only as a held diagnostic prototype,
  never as accepted GREEN;
- `packages/node/src/{creator-close.ts,creator-adoption.ts,v3-live.ts}`;
- `packages/node/src/internal/{creator-successor-live.ts,creator-transition-advance.ts,creator-issuance-retirement-boundary.ts}`;
- `packages/protocol-v3/src/{creator-author-issuance-frontiers.ts,creator-issuance-retirement.ts,latched-acl.ts}` when present in the diagnostic diff;
- `examples/v3-room/src/index.ts`; and
- issuance/live-journal types and focused D.110c-0c1 tests.

The first governing review unanimously returned `CHANGES_REQUIRED` while
accepting the original RED as causal. Its union required one frozen rule, exact
close and recovery consumers, an unconditional ban on covered-historical slot
zero, a tighter pinned-genesis predicate, exact dense chain proof rather than a
count, explicit aggregate/legacy semantics, original RED preconditions, and a
compatibility boundary for the missing trusted bootstrap-policy fact.

The corrected selected rule is uniform constrained candidate 2:

1. Local sequence zero is a separately authenticated exact application-defined
   pinned-genesis bootstrap base. It is never covered-historical authority.
2. Aggregate boundary `S` authenticates the complete creator-observed issuance
   prefix `1...S`; an actually creator-observed slot zero may also yield numeric
   zero.
3. From null, first observed sequence zero advances a dense `0...S`, first
   observed sequence one advances a dense `1...S`, and first observed sequence
   greater than one fails with the frozen migration-required gap code. Numeric
   frontiers retain the adjacent `S+1` law.
4. Recovery must prove exact paired issued/outbox rows `0...S`. Slot zero must
   match the exact trusted bootstrap policy and full pinned-genesis envelope;
   slots `1...S` must individually authenticate under creator-covered history.
5. Null means no creator-observed post-bootstrap history. A bootstrap-only
   later addition or same-key re-entry is safe under the existing transactional
   non-equivocating issuer assumption. Any retained row above zero under null,
   or a first newly observed row above one, refuses. No lineage reset is added.
6. Candidate 1 cannot close the RED. Candidate 4 changes publication/census and
   does not solve later additions. An initial-only candidate-3 proof class adds
   tombstone/incarnation semantics yet still lacks exact bootstrap policy, so it
   is rejected unless this confirmation disproves the uniform invariant.

The source audit demonstrates that today's pinned-genesis predicate accepts any
valid local-author epoch-zero, genesis-anchored row; it does not prove sequence
zero, exact one-anchor dependencies, logical time one, `join`, or configured
bootstrap-operation equality. Signature, ACL, lineage, blueprint execution, and
the generic admission reservation do not supply that product-policy fact.
`V3RoomApplication.bootstrapOperation` does, but low-level recovery and private
successor custody do not carry it.

D.110c-0c1f4 therefore freezes one exported compatibility addition:
`exactCanonicalPinnedGenesisBootstrapOperationBytes` is optional in the
TypeScript recovery input but mandatory at runtime whenever a pinned-genesis
row must classify. Missing or invalid policy fails closed; there is no legacy
permissive fallback. The trusted room application supplies detached canonical
bytes, bounded by the opened blueprint operation budget and existing v3 vertex
canonical limits. The same detached bytes must survive fresh recovery, hot
adoption, pending resume, and cold reopen through private successor custody.
They are local policy, not signed wire/control state. Existing paths that never
need pinned-genesis classification remain behaviorally and source compatible.

The one shared predicate must additionally require exact row/extracted sequence
zero, epoch zero, pinned anchor, scope author/object, dependencies exactly the
single pinned anchor, logical time one, action `join`, registered signature and
digest, and operation canonical-byte equality to the captured policy. Sequence
zero is unconditionally rejected by covered-historical classification.

Determine whether the corrected plan is sufficiently exact and safe to
authorize the focused 0c1f4 RED. Check especially:

1. Does the uniform slot-zero base plus first-observed `>1` refusal safely cover
   continuously authorized genesis writers, later additions, bootstrap-only
   re-entry, and re-entry with hidden post-bootstrap history without an O(epoch)
   proof class or tombstone?
2. Does it preserve creator-observed authority for every slot above zero and
   prevent a self-signed but never creator-admitted application row from being
   replayed?
3. Is exact trusted bootstrap-operation byte equality plus the full frozen
   envelope the right local policy authority, and is optional-with-fail-closed-
   use a coherent public compatibility contract?
4. Are all fresh, hot-adoption, pending-resume, and cold-reopen custody seams
   owned without requiring a wire field, persisted policy record, dependency,
   new signer, threshold, or publication change?
5. Is action `join` consistent with the existing V3 room bootstrap contract, or
   must the plan rely solely on exact product bytes to avoid silently narrowing
   valid applications?
6. Can the causal 0c1f4 RED exercise both the exported recovery and filtered-
   store consumers without private-capability fabrication, and will it fail
   only because the current predicate is broad?
7. Are the mismatch/control/mutation, exact-chain, compatibility, retained,
   source-shape, census, pruning, rollback, and combined final-review gates
   sufficient?
8. Does the original signed 0c1f2 browser RED remain unchanged and causal, with
   its missing sequence-zero graph preconditions now explicitly asserted?
9. Does the held diagnostic draft remain outside accepted GREEN and avoid
   leaking behavior into legacy paths before 0c1f4 closes?
10. Is any required schema, wire, public room API, dependency, authority,
    threshold, workload, or migration change missing from the declared high-risk
    boundary?

Only P0/P1 blocks RED. P2 requires a concrete owner/disposition but does not
trigger recursive prose review. Set `verdict=CHANGES_REQUIRED` iff at least one
P0/P1 exists. Set `plan_sufficient=true` only if the plan freezes a deterministic
implementable authority and compatibility contract plus causal RED. Set
`red_causal=true` only if both the new narrow RED and original signed RED remain
causal. Set `scope_preserved=true` only if broader carrier, repeated-transition,
archive, and Phase-7 work stay owned. No Fable or collaboration subagent is
authorized.
