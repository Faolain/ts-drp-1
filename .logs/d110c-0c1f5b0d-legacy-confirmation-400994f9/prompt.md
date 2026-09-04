# D.110c-0c1f5b0d legacy-cap corrective confirmation

Act as an independent read-only reviewer. This is the single confirmation
round for the two P1 findings in rejected confirmation `508d700a`. Do not edit,
invoke subagents, run long workloads, or broaden into parent f5b.

Inspect these exact artifacts:

- accepted design `.logs/d110c-0c1f5b0r-design-3a156aca/design.md` and its
  valid manifest/pre-review;
- governing reslices in
  `docs/production-hardening/production-hardening-tdd-plan-v2.md`, commits
  `adab0f56428bf0290a4437c83083db18e17eb2dc` and
  `721d1c0e0675b16ca45ca61f4b264de67cbff5f6`;
- rejected confirmation `508d700a9edae065716721cbbc8c9c918bb088f5`,
  root `.logs/d110c-0c1f5b0d-corrective-review-502198f3/`;
- causal tests-only legacy RED
  `7d037ed825a092cf985d1a271d3f56d965992ed3`, evidence
  `932db10609a4f354ee6f20967d74019f09cf844e`, root
  `.logs/d110c-0c1f5b0d-legacy-red-7d037ed8/`;
- one-line production GREEN
  `b384c7d9bdb3b3b3f5fa5b7de05cbafb3da7f4af`, evidence/current anchor
  `400994f9e18e4cc8d7d45039a61c00a8cc0edf06`, root
  `.logs/d110c-0c1f5b0d-legacy-green-b384c7d9/`;
- earlier accepted backend future-epoch correction remains
  `0cafd357` -> `292fc14f`, with evidence `a0bd87f1`/`502198f3`.

Required checks:

1. Confirm the new RED is tests-only and causal: exactly 19 tests, 18 pass and
   one failure with token
   `D110C_0C1F5B0D_LEGACY_HISTORICAL_SCAN_EXCEEDS_ONE_EPOCH_WINDOW`. It must
   select exactly one top-level `countHistoricalIssuanceRow` declaration by
   TypeScript AST, transpile/execute that exact body (not copy its predicate),
   accept 8,192 distinct rows, leave duplicate accounting idempotent, and show
   the live `* 3` body wrongly accepts row 8,193. No import/export/fixture or
   source-substring acceptance may count.
2. Confirm the three invalid old assertions are removed: comment-only
   production invocation, substring prohibition of the legacy cap, and regex
   pin of 3x. Corrected retained totals must not count those claims.
3. Confirm GREEN changes only the actual private production predicate from
   global `maxEpochVertices * 3` to the legacy one-window
   `context.count <= context.maxEpochVertices`; RED tests must be byte-identical
   across GREEN. No settlement-profile rollback-window behavior or genuine
   reachability is claimed.
4. Validate the gates: focused 19/19, unchanged backend ceiling 12/12, real
   Chromium backend 1/1, recalculated store/reclamation 134/134,
   settlement/recovery 122/122, isolated 19/19 + 134/134 + 122/122, Node build
   and exact-owner lint/format/diff. Typecheck inheritance requires the exact
   normalized baseline evidence.
5. Confirm parent f5b remains explicitly blocking for the genuine
   creator-trusted-v1 8,192-success/8,193-refusal hot/restart/cold-reopen path,
   settlement-profile rollback-window bound, real every-peer authenticated
   first deletion, no-legacy-first behavior, and checkpoint/terminal boundary
   authority. The direct private unit test cannot discharge those gates.
6. Confirm the failed real-browser 8,193 experiment and invalid small-limit
   parameters attempt are recorded only as rejected diagnostics, not evidence
   or consumed campaign identities.
7. Review all prior P2 dispositions. Only elevate one if it is a concrete
   correctness/security/scope/evidence defect in the now-corrected f5b0d scope.
   Parent-owned genuine lifecycle, receipt authority/bounds, transaction
   chunking and removal of the rejected post-hoc block remain parent f5b work.

Return exactly one JSON object with no prose before or after:

```json
{
	"verdict": "PASS|BLOCK",
	"summary": "...",
	"p0_count": 0,
	"p1_count": 0,
	"p2_count": 0,
	"findings": [
		{
			"severity": "P0|P1|P2",
			"title": "...",
			"evidence": "path:line and reasoning",
			"required_action": "...",
			"owner": "f5b0d|f5b|D.110c-c|inherited"
		}
	],
	"p1s_closed": true,
	"causal_red_confirmed": true,
	"scope_preserved": true,
	"evidence_sufficient": true,
	"parent_gates_preserved": true
}
```

`PASS` requires zero P0 and zero P1.
