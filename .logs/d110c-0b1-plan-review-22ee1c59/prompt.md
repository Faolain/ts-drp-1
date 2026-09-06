# D.110c-0b1 bounded checkpoint plan review

Act as an independent, read-only senior security and distributed-systems reviewer. Review the exact signed/pushed plan-only commit `22ee1c59b3163e4f5b23c5cb299570cdeda08a03` for D.110c-0b1. Inspect the commit diff, the new `D.110c-0b1 bounded checkpoint opener and control-proof compaction plan` section in `docs/production-hardening/production-hardening-tdd-plan-v2.md`, its audit ledger at `.logs/d110c-0b1-plan-audit-80b2e65b/audit-ledger.md`, and the directly relevant current source.

Accepted inherited facts and scope:

- D.110c-0b0, 0a, a, and b are closed and must not be reopened.
- D.110c-b genuinely reaches an active epoch-2 room through 0→1→2.
- The accepted architecture is a fixed-creator, v1 dual-anchor checkpoint with an independently authenticated expected room head and exactly two rollback generations; no WRAPS/SNARK, new wire record, changed authority, external pin, dependency, threshold, root export, or product API is authorized.
- D.110c-0b1 must add only the already accepted non-root protocol-v3 checkpoint opener and non-root control-plane bounded-advance predicate, compose them through existing Node owners, and prove genuine epoch-2 cold reopen plus bounded active control closure.
- D.110c-0c owns pending-adoption restart after 0b1. D.110c-c owns cleanup/pruning/restart/custody and a third transition. D.110c-d owns the ≥100-transition campaign. Phase 7 owns archive-root evolution, cold paging, and brand-new-client floor delivery.
- No D.110a worker/preflight or long campaign may run. No Fable or collaboration subagent is authorized.

Review whether the plan is secure, causal, implementable, and sufficiently exact before RED. In particular:

1. Can `openCreatorCheckpointTrust` authenticate epoch N from the pinned genesis invite, fixed creator carriers, one immediate predecessor record, current record, current CutValue/QC, and an independent expected room head without replaying N-2 evidence or exposing a naked authority constructor?
2. Are its exact input shape, output, failure roster, internal singleton-custody callback, genesis/current/predecessor signature/link checks, and one-step QC reuse sufficient and non-duplicative?
3. Does `inspectBoundedCreatorTrustAdvance` derive retirement authority from decoded current candidates, preserve every unrelated ref, reject extra deletion/still-retained/substituted refs, and actually make active control closure constant-bounded?
4. Does the RED fail through three genuine current defects—not import trivia, synthetic records, or fixture-authored authority—and does its exact 3-failure matrix give deterministic causality?
5. Is the Node Batch-2 scope complete enough to remove every epoch-0/1 pin in cold reopen and pending recovery, use the independent floor, preserve epoch-0/first-successor behavior, and avoid activating/deleting before all authentication gates?
6. Is the two-head-advances/two-rollback-generation mapping correct and strong enough to ensure the immediate predecessor remains available while older transition pairs can leave the active closure?
7. Are the focused/retained/static/evidence gates sufficient and scoped, and are any claimed closure-count/byte equalities unrealistic or able to hide control growth in projections, metadata, registration, bootstrap, or another store?
8. Does any requirement silently require a new wire/schema/public product contract, floor authority, migration, dependency, authority/key-rotation assumption, pruning behavior, or broader production-source redesign that should stop and reslice before RED?

Do not edit files, run long workloads, invoke other models, or propose unrelated architecture. Only P0/P1 findings block. Report P2 observations with a concrete owner/disposition. Judge this plan, not later implementation evidence.

Return exactly one final JSON object and no prose outside it:

```json
{
  "verdict": "APPROVED or CHANGES_REQUIRED",
  "summary": "short evidence-based summary",
  "findings": [
    {
      "severity": "P0 or P1 or P2",
      "title": "concise title",
      "path": "repository-relative path",
      "line": 1,
      "evidence": "specific evidence",
      "required_action": "specific correction or disposition"
    }
  ],
  "plan_causal": true,
  "scope_preserved": true,
  "red_ready": true,
  "blocking_union_closed": true
}
```

`APPROVED` requires zero P0/P1 findings and all four booleans true. Use `CHANGES_REQUIRED` when any P0/P1 exists. Do not invent findings merely to populate the array.
