# D.110c-0c1a final plan -> RED -> GREEN review

Act as a strict, read-only senior security/correctness reviewer. Review the
complete D.110c-0c1a history and the signed GREEN change now at HEAD. Do not
edit files, run tests, or recommend broad redesign absent a demonstrated
blocking defect.

Custody:

- branch: `codex/phase3a1b-p6-golden-path`
- accepted plan commit: `037b82442167ef27b750b2349ec66f1285780e59`
- causal RED commit: `7e2f2694cdd1b3a2feb0265dd0a73fa52dcb52dc`
- causal RED tree: `bcf8073f2d41c92c30eb17944f595291b23d584b`
- signed/pushed GREEN commit: `d77ee315a7688cffb5fd55870c38231403ecc41f`
- GREEN tree: `1c907ac05acb6cd844fb5dbb4f15e7c1ee8940af`
- local and remote branch refs were verified equal to the GREEN commit
- all three commits have the repository's required signed/pushed custody

Primary plan and code to inspect:

- `docs/production-hardening/production-hardening-tdd-plan-v2.md`, section
  `D.110c-0c1a creator-signed issuance-retirement checkpoint prerequisite`
- `packages/protocol-v3/src/creator-issuance-retirement.ts`
- `packages/protocol-v3/src/internal/creator-issuance-retirement-signing-request.ts`
- `packages/keychain/src/finality.ts`
- `packages/node/src/creator-close.ts`
- `packages/node/src/internal/creator-transition-advance.ts`
- its five callers in creator close/adoption/adoption commit
- affected fixture/test diffs and package/Vite subpath wiring in the GREEN
  commit

Evidence named in the plan:

- RED manifest: `5726596405fe05894c2b796b1e400406ef11aaa1c07e07a2d0cee2e216829053`
- focused GREEN manifest: `9ebd55702fc02f46ecfd6f972b9afe839c754e5a45a7eac0dca65a3335e9db72`
- retained unit manifest: `8a3ba7c69c15d70c3ec7580bbf5daca5b4ddae52cba5af82d2bdca98c3af6c8e`
- retained browser stdout/status + JSON manifests:
  `3eb2fba5e6d2c2d4ed6961c86771ae8b8d7fe35db96c8de6c988a846b33b3a1a`,
  `7a09bc9d7fa06721b9244d915407e185a3570a292a9970555c4c85219269ad04`
- post-tightening browser manifests:
  `b6f7ce68ad3aa375ed3f3dfa62d7a2845d1bfa8db97ce8ba2683538f93d284ee`,
  `e13a26535d1c89c38fefaf1ce136dc8379a179046d4548e29c99e1f449a9055a`
- static manifest: `e8e24b3de4b9a979e76f10c1df0a1e305a9ed9206b36aa594e346cde4faa7072`
- closure manifest: `74389094ae89affe4e76f82966bb856f9e5c96a675f3f9333cfd82d161410b6e`

Review questions:

1. Was RED genuinely causal: a real close had the required admitted issuance
   evidence but lacked only an authenticated retirement carrier?
2. Does GREEN close exactly that reason without changing wire roots,
   activation/authority assumptions, public product APIs, dependencies,
   thresholds, or snapshot/archive behavior?
3. Is the carrier cryptographically bound to creator identity, genesis,
   object, closed/successor epoch and anchors, Cut/QC/snapshot, admitted
   sequence, lineage, and prior-carrier continuity?
4. Is creator-close derivation bounded, dense, replay/graph authenticated,
   exact across issued/outbox records, and fail closed for empty, exhausted,
   gapped, substituted, or incomplete lineage?
5. Does the private transition normalization admit only epoch-0 zero-to-one or
   adjacent one-to-one replacement, require exact candidate/ref occurrence,
   preserve the unchanged inner transition predicates, and avoid restoring a
   stale/unverified carrier?
6. Do all stage/verify callers authenticate the carrier before structural
   normalization, including reopen/pending paths?
7. Do tests and retained gates materially cover the adversarial contract and
   preserve the downstream D.110c-0c causal RED rather than weakening it?
8. Are any plan/evidence claims materially false or any production path
   missing such that D.110c-0c1a cannot safely close?

Scope limits:

- D.110c-0c1a exposes no filtering decision; D.110c-0c1 is the consumer.
- The inherited N1-prime source-hash assertion debt is outside this change.
- The signed downstream D.110c-0c RED is intentionally not rerun here.
- No D.110a or retained campaign may be rerun.
- Only P0/P1 findings block. P2 findings need an owner/disposition but do not
  trigger recursive review.

Return one terminal JSON object and no prose outside it:

```json
{
  "verdict": "APPROVED | CHANGES_REQUIRED",
  "summary": "concise conclusion",
  "findings": [
    {
      "severity": "P0 | P1 | P2",
      "title": "short title",
      "evidence": "specific file/symbol/line or concrete evidence",
      "impact": "what can fail",
      "required_action": "smallest justified correction or disposition"
    }
  ],
  "red_causal": true,
  "green_closes_red": true,
  "scope_preserved": true
}
```

`APPROVED` requires zero P0/P1. Do not invent a finding merely to populate the
array; `findings` may be empty.
