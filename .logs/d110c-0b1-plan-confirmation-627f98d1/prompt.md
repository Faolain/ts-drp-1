# D.110c-0b1 material plan-correction confirmation

Act as an independent, read-only senior security and distributed-systems reviewer. Confirm the exact signed/pushed D.110c-0b1 material correction at commit `627f98d118fa22e935f31023171d38c6075e3bc0` (tree `20f41aaf2adccd2029649aaece9d728ef2ff61e9`) relative to reviewed plan commit `22ee1c59b3163e4f5b23c5cb299570cdeda08a03`.

Inspect only the correction diff, the corrected D.110c-0b1 section in `docs/production-hardening/production-hardening-tdd-plan-v2.md`, the first-review evidence root `.logs/d110c-0b1-plan-review-22ee1c59/`, the correction ledger `.logs/d110c-0b1-plan-correction-22ee1c59/correction-ledger.md`, and directly relevant current source. Do not reopen completed D.110c work or demand implementation evidence before RED.

The first review's material union was:

1. every epoch-N staged-pair classifier—not only close staging—must use bounded classification;
2. the stale epoch-tagged predecessor ACL must retire with the stale Cut/QC pair or active closure still grows;
3. active cold reopen needs both genuine predecessor and current opaque trust capabilities, not only current trust.

Confirm that the corrected plan now:

- gives `openCreatorCheckpointTrust` the exact success object `{currentTrust,ok,predecessorTrust}`, returns no genesis/key/constructor material, uses one named sole-caller private predecessor minter, directly initializes `anchor-trust-singleton.js`, and retains the fixed-creator/v1/no-N-2 security model;
- gives `inspectBoundedCreatorTrustAdvance` exact `retiringPredecessorAclRef` plus retiring/new Cut/QC tuples, binds old proof+ACL epoch to `currentEpoch-1`, new proof epoch to `currentEpoch`, preserves every unrelated ref, and yields the exact five-kind post-adoption active closure without authorizing physical deletion;
- names one Node-private `inspectCreatorTransitionAdvance` owner for epoch-N close, hot verify, commit, and active cold reopen while preserving the exact 0→1 compatibility path;
- leaves epoch>=2 pending-adoption recovery unimplemented and assigns its first causal RED to D.110c-0c rather than landing an untested branch;
- makes RED behavioral before missing-module tokens and freezes the exact three-failure matrix;
- replaces open-ended byte equality with exact count/kind equality, per-kind byte/delta enumeration, fixed-schema ceilings, and no hidden store-growth escape;
- remains implementable without a wire/schema/root-export/product-API/dependency/authority/floor/threshold/rollback/pruning/campaign change; and
- closes every P0/P1 from the first review without introducing a new material defect.

Do not edit files, run long workloads, invoke other models, spawn subagents, or propose unrelated architecture. Only P0/P1 findings block. Report P2 with a concrete later owner/disposition; do not use P2 to require another confirmation.

Return exactly one final JSON object and no prose, markdown fences, or commentary outside it:

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
  "material_union_closed": true,
  "scope_preserved": true,
  "red_ready": true,
  "blocking_union_closed": true
}

`APPROVED` requires zero P0/P1 findings and all four booleans true. Use `CHANGES_REQUIRED` when any P0/P1 exists. Do not invent findings merely to populate the array.
