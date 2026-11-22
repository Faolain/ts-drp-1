# D.110c-0c1a material correction confirmation

Act as a strict, read-only senior security/correctness reviewer. This is the
single permitted material confirmation after the final review of the initial
GREEN. Inspect the repository at signed/pushed HEAD and return only the JSON
schema below. Do not edit files, run tests, invoke subagents, or broaden the
review into later implementation design.

Custody:

- branch: `codex/phase3a1b-p6-golden-path`
- accepted plan: `037b82442167ef27b750b2349ec66f1285780e59`
- causal RED: `7e2f2694cdd1b3a2feb0265dd0a73fa52dcb52dc`
- initial GREEN: `d77ee315a7688cffb5fd55870c38231403ecc41f`
- signed/pushed correction under review: `7414fa6bad30edc34de162f274ecee1504637579`
- correction tree: `4daa440035ba8cde11719701d0fcc8e4a807d7c8`
- local and remote branch refs were verified equal

The initial review results are preserved under
`.logs/d110c-0c1a-final-review-d77ee315/`. Grok and Kimi had no P0/P1. Opus
found two P1s and one P2:

1. The close derivation's fail-closed branches lacked direct executable
   mutant coverage.
2. `issueOneVertex()` can durably commit issuance before journal/graph
   admission. A post-commit failure can leave a row that truncates the current
   close but, after adoption, carries the old epoch/anchor and blocks the next
   close. The existing plan required a stop/reslice if this state was
   reachable.
3. The later D.110c-0c1 consumer must independently bind the retirement
   carrier author to its resolved issuance scope.

The correction deliberately does not repair the production issuance window.
It:

- extracts the existing close-boundary algorithm without behavior change into
  Node-internal, non-package-exported
  `packages/node/src/internal/creator-issuance-retirement-boundary.ts`;
- adds direct deterministic cases for full prefix, safe unadmitted suffix,
  gap, duplicate, issued/outbox substitution, graph omission then re-entry,
  lineage mismatch, exhausted lineage, over-limit scan, and empty
  initialization;
- adds named blocking D.110c-0c1b, owned by the real post-`transactIssue()`
  outcome window, before D.110c-0c1 or repeated-epoch continuation;
- assigns the independent carrier-author binding P2 to D.110c-0c1; and
- commits the earlier final GREEN and review evidence.

Evidence:

- correction root:
  `.logs/d110c-0c1a-green-review-correction-d77ee315/`
- correction manifest SHA-256:
  `e62e8ec6f3c3aa854cb8fdacb0984f801b2972451ad8484e820bb08b888bf7bd`
- focused test: 3/3 passed
- retained unit set: 230/230 passed, 24 files, 52 suites
- Node production-source typecheck/build, exact-owner ESLint/Prettier, and
  executable/documentation diff check passed
- all ten named evidence manifests validate at the correction commit

Review only these material questions:

1. Is the extraction behavior-preserving relative to initial GREEN, including
   pagination, dense prefix, exact issued/outbox/canonical/graph checks, bound,
   error token, and returned lineage?
2. Does the direct matrix genuinely exercise every frozen failure class, or
   is a material branch still untested or falsely passing for another reason?
3. Does D.110c-0c1b correctly recognize and block the reachable post-commit
   issuance hole before the D.110c-0c1 consumer and continued repeated epochs,
   without weakening the authenticated dense frontier or prematurely choosing
   a production repair?
4. Is the Opus P2 assigned to the correct later consumer boundary?
5. Are the evidence-custody corrections and plan claims materially honest?
6. Is there any P0/P1 defect in this correction that prevents D.110c-0c1a from
   closing while D.110c-0c1b remains a blocking next slice?

Do not reopen resolved initial-GREEN questions or demand implementation of
D.110c-0c1b inside this correction. Only P0/P1 blocks. P2 receives a concrete
owner/disposition and does not cause another confirmation round.

Return exactly one terminal JSON object and no prose outside it:

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

`APPROVED` requires zero P0/P1. Findings may be empty.
