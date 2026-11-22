# D.110c-0c1f5b0b final implementation review

Act as an independent, read-only production/security reviewer. Review the
complete accepted plan → causal RED → GREEN history for Node author
settlement. Do not edit files, run long workloads, invoke other models, or
review superseded f5b0/f5b0p/f5b0q grammar.

## Governing inputs

- Accepted design and constraints:
  `.logs/d110c-0c1f5b0r-design-3a156aca/design.md` and sibling
  `pre-review.md`.
- Current frontier and D.110c-0c1f5b0r/f5b records in
  `docs/production-hardening/production-hardening-tdd-plan-v2.md`.
- Initial tests-only RED `882a3dc1de1a550003b0e105fbbb89444e915b2e`.
- Final corrected tests-only RED `f7f693b7ec3eddcc68694ad093e807067b9333a7`.
- RED evidence roots `.logs/d110c-0c1f5b0b-red-882a3dc1/`,
  `.logs/d110c-0c1f5b0b-red-de1eed2a/`, and
  `.logs/d110c-0c1f5b0b-red-f7f693b7/`.
- Production GREEN `93585bf3ba62ae662c2963fd13be2ee051451fa2`;
  inspect the exact production diff
  `504ca351653701af9dd45ad99f725307994c8e1f..93585bf3ba62ae662c2963fd13be2ee051451fa2`.
- GREEN evidence root `.logs/d110c-0c1f5b0b-green-93585bf3/` and signed
  evidence commit `9b02f9c27d6173b92265b23ccd205405c9383741`.
- Focused tests and fixtures under
  `tests/phase-6b-d110c-0c1f5b0b-node-red.test.ts` and
  `tests/fixtures/phase-6b-d110c-0c1f5b0b/`.
- All five GREEN paths listed in the GREEN evidence `changed-paths.txt`.
- Precomputed read-only review packets in this review root:
  `production.diff`, `red.diff`, and `custody-chain.txt`. Use these when your
  tool policy does not permit Git commands.

## Review obligations

Determine whether RED was genuinely causal and GREEN closes the intended
reason without widening product semantics. Inspect, do not assume, all of the
following:

1. Strict settlement advance input capture rejects extras, accessors, sparse
   arrays and non-plain shapes without rejecting the legitimate control-plane
   caller shape.
2. The dedicated fence issuer reads the complete durable plan; refuses absent,
   manual-review and already-linked plans before issuance; derives rather than
   trusts the fence `planEffect`; binds `fenceSequence` to the chosen issuance
   lineage; and handles concurrent/CAS/unknown outcomes fail closed.
3. Replacement `planEffect` remains an internal settlement-only Node/room seam,
   cannot be supplied under a legacy profile or for a reserved/control action,
   and does not change the exported `V3LocalIssueInput` or room public issue
   contract.
4. Genuine legacy-profile fence ingress fails before journal, graph,
   reservation, ACL, projection, sink or accounting changes, while settlement
   fences remain globally reserved control operations.
5. The complete graph really is owned by `closeVertices`, `closeAuthors` and
   `closeCharges`; control operations remain in close/history/charge/frontier
   custody but are excluded from application authorization, reservation, ACL
   staging, reducer projection, application sink and application accounting.
   Look for any missed rename or code path that loses/misclassifies controls.
6. Published and pending own rows are both scanned under settlement. Structural
   `join`/`causalJoin` are authenticated controls with no application intents;
   displaced ACL is authenticated and surfaced. Legacy behavior is unchanged
   unless the operation was already Node-reserved.
7. Any-anchor older-row authentication verifies exact canonical bytes,
   registered digest, signature, object, author, sequence, epoch, dependencies
   and operation. It must require a validated authenticated frontier context;
   terminal (`seq <= terminalThrough`) and old-incarnation
   (`epoch < admissionEpoch`) rows must never be surfaced as displaced. No
   dummy boundary or unauthenticated caller authority is permitted.
8. The current partial caller with only an authenticated displaced-source
   capability must not claim terminal/incarnation classification. Confirm the
   explicit future f5b0c/f5b owner for threading the verified checkpoint
   frontier is safe and not incorrectly represented as already complete.
9. `completeRebaseSource` is unavailable only under settlement and preserves
   creator-trusted-v1 behavior.
10. The new protocol-v3 internal subpath re-exports the unchanged verifier
    without leaking it from the root, changing crypto/dependencies, or exposing
    a broader product API. The Vite alias must be exactly the matching
    monorepo-resolution entry and not affect unrelated production resolution.
11. Focused 27/27, retained 87/87, builds/typechecks/public smoke, isolated
    evidence and manifests are complete and internally consistent. Distinguish
    inherited Node typecheck failures and isolated build-order diagnostics from
    GREEN defects.
12. No wire/protobuf/schema/dependency/threshold/campaign/room/pruning/creator
    integration change entered this slice, and none of the explicit design
    stop rules fired.

P0/P1 findings block closure. P2 findings are nonblocking but must be concrete,
with a recommended owner and disposition. Do not block on documentation prose,
future f5b0c/f5b work explicitly outside this slice, or inherited failures
unless GREEN worsened them.

## Required terminal schema

Return exactly one terminal JSON object, with no markdown fence or prose before
or after it:

```json
{
  "verdict": "PASS or BLOCK",
  "p0": [
    {
      "title": "...",
      "evidence": "path:line and concrete mechanism",
      "impact": "...",
      "repair": "..."
    }
  ],
  "p1": [],
  "p2": [
    {
      "title": "...",
      "evidence": "path:line and concrete mechanism",
      "owner": "exact future slice or existing owner",
      "disposition": "fix now, defer with reason, or reject with reason"
    }
  ],
  "red_causal": true,
  "green_closes_red": true,
  "scope_preserved": true,
  "evidence_valid": true,
  "summary": "concise conclusion"
}
```

Use `PASS` only when both `p0` and `p1` are empty. Set the booleans according
to evidence rather than forcing them true.
