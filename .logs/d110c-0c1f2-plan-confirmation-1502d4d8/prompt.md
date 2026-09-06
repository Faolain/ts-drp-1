Perform the single material confirmation of the corrected high-risk
D.110c-0c1f1/D.110c-0c1f2 multi-author issuance-frontier carrier plan at
signed/pushed commit `1502d4d81e1769a75bc3c416937b53e57dc3390b`, relative to
the first reviewed plan `5e0170670973f4920731a6d418436c9b4ae971ff` and closure
anchor `244c935f9e715236e9f2c2783f3bb6bee24706e1`. This is read-only. Do not edit,
run tests, delegate, or spawn subagents. Return only one JSON object matching
the supplied schema.

Inspect:

- D.110c-0c, D.110c-0c1, D.110c-0c1f, D.110c-0c1f1, D.110c-0c1f2,
  D.110c-c, and D.110c-d in
  `docs/production-hardening/production-hardening-tdd-plan-v2.md`;
- `.logs/d110c-0c1f-source-audit-244c935f/{audit.md,source-seams.txt,source-hashes.txt,SHA256SUMS}`;
- `.logs/d110c-0c1f2-plan-correction-5e017067/{review-summary.json,size-probe.json,size-probe-execution.json,predicates.md,plan.diff,SHA256SUMS}`;
- `.logs/d110c-0c1f1-plan-review-5e017067/kimi/reemit.stream.jsonl` for
  the exact first-review findings;
- `packages/protocol-v3/src/{creator-issuance-retirement.ts,latched-acl.ts}`;
- `packages/node/src/{creator-adoption.ts,creator-close.ts,v3-live.ts}`;
- `packages/node/src/internal/{creator-issuance-retirement-boundary.ts,creator-transition-advance.ts}`;
- `packages/compaction/src/types.ts`; and
- `packages/issuance-store/src/types.ts`.

First-review findings and correction:

1. Kimi found P1 that the captured `EpochVertex` lacks remote author/sequence,
   signature, and preimage facts and the capture owner was undeclared. The
   correction explicitly owns a private bounded digest-keyed
   `(author,authorSequence)` map populated only after the existing exact
   preimage/digest/signature/anchor/epoch/object/ACL/admission checks, captured
   with exact non-anchor key-set/cardinality equality, censused and reclaimed
   with the graph. It deliberately does not duplicate signature/preimage bytes
   or change the shared `EpochVertex` type.
2. Kimi found P1 that literal writer-group selection is wrong for permissionless
   ACLs. The correction defines the vector as exactly every member when
   permissionless, otherwise exactly writer-group members, matching
   `authorizeLatchedApplicationWrite()`, and brings
   `creator-adoption.ts::authenticatedSuccessorIssuanceScope()` under the same
   owner.
3. Kimi found P1 that aggregate initialization and dual-carrier precedence were
   ambiguous. The correction seeds the legacy-authenticated creator exactly
   from v1, starts other new writers at null/zero, refuses observed noncreator
   pre-aggregate gaps, and requires legacy/aggregate creator identity/frontier
   equality on every coexistence close. A non-null aggregate frontier is the
   selected capability; v1 remains an independently checked creator witness.
4. The P2 dispositions define null-plus-nonzero refusal precedence, stop on
   size overflow, and correct removal/re-add timing plus its mutant.
5. The pre-RED maximum-shape probe demonstrated that 64 object-form entries
   encode to 8,289 bytes and therefore stopped 0c1f1 before RED. D.110c-0c1f2
   retains every fixed signed field but changes each frontier to one exact
   canonical two-element array `[author, admittedAuthorSequence]`. The same
   maximum shape encodes to 6,241 bytes, leaving 1,951 bytes under the unchanged
   8,192-byte ceiling. GREEN must reproduce the exact size with the real
   encoder and reject all alternate tuple/object shapes.

Determine whether the corrected plan is sufficiently exact and safe to
authorize causal RED. Check especially:

1. Is a private identity map containing only digest-keyed verified author and
   authorSequence sufficient once existing admission has already authenticated
   the exact signature and canonical preimage, or must close retain/reverify
   more bytes? Would the proposed key-set/cardinality and lifecycle checks
   prevent substitution or stale identity without hidden growth?
2. Does the exact owner list now cover every necessary capture, recovery,
   adoption, close, transition, census, and reclamation seam without requiring
   a shared compaction type, public API, dependency, threshold, or wire-vertex
   change?
3. Is the permissionless-aware application-writer set exact for both close and
   successor reopen, including non-write-authorized ACL-operation authors?
4. Are aggregate 0-to-1 seeding, continuing frontier derivation,
   legacy/aggregate creator equality, removal, rollback, quiescent legacy
   writers, and same-key re-entry deterministic and fail closed?
5. Does the exact two-element tuple representation remain canonical,
   one-to-one, mutation-resistant, and safely under 8,192 bytes at every legal
   maximum without dropping an authenticated fact?
6. Do all signed fixed fields and prior-aggregate adjacency still prevent
   cross-object/genesis/ACL/cut/QC/snapshot replay, substitution, fork, skipped
   epoch, or signature-domain confusion?
7. Will the two-layer RED still fail for the intended absent aggregate carrier
   rather than because tuple production does not exist, permissionless setup is
   invalid, or some earlier fixture/recovery defect intervenes?
8. Is ordinary cold reopen still O(1) in epoch count and O(current authorized
   members) with no hidden lifetime-author, archive, bootstrap, registration,
   local-store, or proof-chain dependency?
9. Do pending/published outbox custody, dense gaps, scan ceilings, two rollback
   generations, pruning, and runtime reclamation remain fail closed?
10. Is any necessary schema/API/dependency/authority/threshold change absent
    from the declared high-risk boundary?

Only P0/P1 blocks RED. P2 requires a concrete owner/disposition but does not
trigger recursive prose review. Set `verdict=CHANGES_REQUIRED` iff at least one
P0/P1 exists. Set `plan_sufficient=true` only if the plan freezes a
deterministic implementable contract and causal RED. Set `scope_preserved=true`
only if broader authority, repeated-transition, archive, and Phase-7 work stay
owned. This is the sole material confirmation; do not request another
bookkeeping review. No Fable or collaboration subagent is authorized.
