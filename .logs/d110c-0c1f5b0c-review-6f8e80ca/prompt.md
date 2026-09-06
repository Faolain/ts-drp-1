# D.110c-0c1f5b0c final plan -> RED -> GREEN review

Act as an independent read-only implementation reviewer. Do not edit files,
run a long workload, invoke subagents, or propose scope unrelated to this
slice. Inspect the repository sources and evidence named below rather than
relying only on this summary.

## Authority and custody

- Accepted design and waived design gate:
  `.logs/d110c-0c1f5b0r-design-3a156aca/design.md`, especially "Author drain,
  plan and fence", the crash/attack matrix, TDD item 4, RED cases 2-4, 10-11,
  15-16, 19-21 and 24-25; and sibling `pre-review.md`.
- Governing plan: `docs/production-hardening/production-hardening-tdd-plan-v2.md`,
  records D.110c-0c1f5b0r and the current frontier. The prospective 64-writer
  amendment at signed `fa254682` belongs to the later f5b integration and
  D.110c-d; it does not expand f5b0c.
- Tests-only RED: `d062c5f64ad7255f67eb91d0eb1c8441acc147c1`.
- RED evidence/current after RED: `9f55370c7f7da926f86f6e308703f7541c522337`,
  `.logs/d110c-0c1f5b0c-red-d062c5f6/`.
- Production GREEN: `3b6a66a9b5257c9011611fc2955ac6ee1ab90bfc`.
- GREEN evidence/current review anchor:
  `6f8e80cafbd5258dd2bfa7c23e103c6f75991506`,
  `.logs/d110c-0c1f5b0c-green-3b6a66a9/`.
- Production changed only `examples/v3-room/src/index.ts`; the RED added only
  `tests/phase-6b-d110c-0c1f5b0c-room-red.test.ts`.

## Required review

1. Confirm the RED is causal: exactly one selected file, nine tests, eight
   failures at missing room settlement orchestration, one legacy control pass,
   and no missing import/export or fixture failure.
2. Confirm GREEN durably reads, builds/merges and CAS-writes the plan before
   issuing; holds on `manual-review`; issues exactly one valid lineage fence
   before replacements; atomically links each replacement through the existing
   internal `planEffect`; handles displaced fences, published sources, ACL and
   reserved empty-intent rows; and reads back ambiguous issue outcomes without
   retrying or claiming success.
3. Check restart/idempotence and crash laws carefully: linked entries are not
   reissued, unlinked entries are, displaced replacements become new sources,
   displaced fences clear and cause a larger fence, terminal entries may leave
   only under authenticated classification, and no source is completed through
   the legacy `completeRebaseSource` path under settlement profile.
4. Check that plan merging cannot silently lose, mutate, reorder, or relink a
   still-live entry; source digest/disposition conflicts fail closed; an empty
   plan still receives a fence; mixed policies remain deterministic; and plan
   CAS/issue failure handling cannot double-apply or bypass the startup/public
   issue barrier.
5. Confirm `creator-trusted-v1` behavior is unchanged and the public room
   `issue()` API, wire/protobuf/schema, cryptography, dependencies, thresholds,
   lineage policy, f5b0d reclamation, and f5b integration are not widened.
6. Enforce stop rules: checkpoint-carried `admissionEpoch` insufficiency,
   noncontiguity, insufficient device-local plan authority, or anchor fencing
   not being the old-incarnation admission check would require reslicing.
7. Validate evidence honesty: focused 9/9, build/typecheck/static, retained
   87/87, legacy 26/26, and isolated focused 9/9 plus retained 87/87. The
   D.110c-0c1j-0 noncanonical-genesis fixture failures count as inherited only
   if the evidence really demonstrates the same failures at pre-GREEN
   `9f55370c`; do not let that label hide a regression in an owned retained
   gate.
8. Report every concrete issue. P0/P1 are correctness, security, scope, or
   evidence-integrity defects that block this f5b0c GREEN. P2 must name an
   owner and disposition. Do not promote already-owned f5b integration,
   manual-review resolution, f5b0d reclamation, the 64-writer/100-transition
   gates, or genuinely inherited lineage fixtures unless this diff worsens
   them.

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
			"owner": "f5b0c|f5b|f5b0d|D.110c-d|inherited"
		}
	],
	"causal_red_confirmed": true,
	"scope_preserved": true,
	"evidence_sufficient": true
}
```

`PASS` requires zero P0 and zero P1.
