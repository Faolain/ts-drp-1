# D.110c-0b1 final plan -> RED -> GREEN review

Act as a read-only senior security/correctness reviewer. Do not edit files, run a campaign, invoke D.110a, or spawn subagents. Inspect the current signed/pushed GREEN commit and the cited immutable evidence. Return only one terminal JSON object matching the contract below; no prose before or after it.

## Custody

- Accepted plan correction: `627f98d118fa22e935f31023171d38c6075e3bc0`
- Accepted confirmation: `2cd3ba512a62595a314b1806b70b0eac9092f09c`
- Signed causal RED: `9457680d95eec15afe3a6a6d7d17655a1d21c2ee`
- Signed/pushed GREEN under review: `420fd2403f69a5bc21e7bb5807597ff96d92a344`
- RED evidence: `.logs/d110c-0b1-red-2cd3ba51/`
- GREEN evidence: `.logs/d110c-0b1-green-9457680d-final/`
- Plan section: `docs/production-hardening/production-hardening-tdd-plan-v2.md`, heading `D.110c-0b1 bounded checkpoint opener and control-proof compaction plan`

Read the complete current files named by `.logs/d110c-0b1-green-9457680d-final/changed-paths.txt`, not only snippets. Inspect the RED and GREEN ledgers, reporters, serialized functional evidence, command statuses, source hashes, state audit, and manifests. Check the signed RED test source and the GREEN diff from RED to current HEAD.

## Required review questions

1. Was RED genuinely causal? Confirm all three frozen RED failures occurred only after their preceding semantic assertions, and that GREEN closes those exact missing seams rather than weakening the tests.
2. Does `openCreatorCheckpointTrust` authenticate pinned genesis, fixed creator carriers/signatures, exact immediate predecessor/current lineage, exact 1->2 CutValue/commit-QC, and the independently authenticated expected head? Check replay, fork, skipped/stale/cross-object/cross-genesis and custody behavior. It must not trust untrusted storage merely because a record self-identifies, walk N-2 state, leak a naked constructor, or widen the protocol root export.
3. Does `inspectBoundedCreatorTrustAdvance` remove exactly the old trust, stale Cut/QC, and stale predecessor ACL; add exactly the successor trust plus new Cut/QC; preserve unrelated refs byte-for-byte; validate kind/phase/epoch/object/ref digest; and fail closed on omissions, duplication, substitution, retention, and extra deletion?
4. Does the single Node-private classifier correctly serve close staging, hot verification, adoption commit, and active cold reopen while preserving byte-compatible epoch-0->1 behavior and intentionally leaving pending epoch>=2 recovery pinned for D.110c-0c?
5. Does genuine active cold reopen authenticate the epoch-1/epoch-2 checkpoint pair and copied room head before activation, recover exact state/ACL/authority/history/snapshot/journal/issuance, and actually issue and publish after reopening?
6. Closely review `authenticatedPinnedGenesisOutboxRow` and both filtered-store call paths. It may hide only a cryptographically authenticated pinned-genesis row cross-bound to the durable issued row. Malformed, substituted, other-author/object/sequence/digest/anchor/epoch rows must remain visible and fail closed. Flag any bypass, unbounded state, counter error, or unsafe `Number.MAX_SAFE_INTEGER` interaction.
7. Do tests cover the frozen reason and retirement-mutant families without authoring fake positive trust state or relaxing retained contracts? Check the two retained expectation corrections are exact consequences of bounded closure/source-graph ownership, not regression masking.
8. Does evidence support 5/5 focused, 350/350 retained, 1/1 Chromium, builds/typechecks/lint/format/source-shape, exact 5->4->5 census, and post-reopen issue/publish? Treat the broad Node typecheck and diagnostic launcher/regex failures honestly; decide whether the exact-source substitute is acceptable under prior D.110c ownership.
9. Confirm scope: no wire/schema, root API, authority/floor, rollback count, dependency, threshold, product API, pruning, pending-recovery success, third transition, campaign, or D.110a change. Confirm the explicit arbitrary-intermediate-issuance limitation is safely deferred to D.110c-0c/D.110c-d and does not invalidate the frozen two-transition GREEN.

Only P0/P1 findings block this checkpoint. P2 findings must have an exact owner/disposition and do not make `blocking_union_closed` false.

## Terminal JSON contract

Return exactly:

```json
{
  "verdict": "APPROVED or CHANGES_REQUIRED",
  "summary": "concise evidence-based conclusion",
  "findings": [
    {
      "severity": "P0 or P1 or P2",
      "title": "short title",
      "path": "repository path",
      "line": 1,
      "evidence": "specific evidence",
      "required_action": "bounded disposition"
    }
  ],
  "red_causal": true,
  "green_closes_red": true,
  "scope_preserved": true,
  "evidence_sufficient": true,
  "blocking_union_closed": true,
  "next_state": "D110C_0B1_CLOSED or D110C_0B1_CORRECTION_REQUIRED"
}
```

Set `verdict` to `CHANGES_REQUIRED`, `blocking_union_closed` to false, and `next_state` to `D110C_0B1_CORRECTION_REQUIRED` if any P0/P1 exists. Do not invent findings. Do not classify service/tool limitations as code approval.
