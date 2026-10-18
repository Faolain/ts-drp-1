# D.110c-0c1f5b0d final plan -> RED -> GREEN review

Act as an independent read-only implementation reviewer. Do not edit files,
run long workloads, or invoke subagents. Inspect the named sources and
evidence, not only this summary.

## Authority and custody

- Accepted design:
  `.logs/d110c-0c1f5b0r-design-3a156aca/design.md`, especially "Settlement
  plan store contract", "Recovery, terminal rule and pruning", crash matrix,
  TDD item 5, RED case 13, and acceptance/stop rules; sibling `pre-review.md`.
- Governing plan/current frontier:
  `docs/production-hardening/production-hardening-tdd-plan-v2.md`.
- Tests-only RED: `9ab5924a34faf9cd1e0f42b79026ef5313318da8`;
  evidence `f05048f9dd51b63da38b3c3224ccfede950227cc` at
  `.logs/d110c-0c1f5b0d-red-9ab5924a/`.
- Production GREEN: `1063feca39d60d24972ee101ab4051b4c1a23bb9`.
- GREEN evidence/review anchor:
  `307825ef35312dd76ca40d8997cfc990598cbdfa` at
  `.logs/d110c-0c1f5b0d-green-1063feca/`.
- Production changed only the five paths in `changed-paths.txt`.

## Required review

1. Confirm RED causality: one selected file, 21 tests, two controls passing and
   19 failures at the missing authenticated prune owner, complete-plan gate,
   mixed-epoch/pending deletion, production invocation, and bounded recovery
   scan—not import/export/mock/stale-build failures.
2. Confirm all three backends implement one storage-neutral authenticated
   compare-and-delete owner with monotone watermark, expected lineage and prior
   watermark/head inputs, any-number-of-old-epochs support, pending and
   published rows, complete rollback on partial deletion, and idempotent replay.
3. Confirm the plan gate observes the transactionally current exact-scope plan
   and rejects absent plan, null fence, manual review, and every unlinked
   non-expire entry anywhere—not only entries within the selected prefix—before
   deleting either issued or outbox rows or advancing the watermark. Corrupt
   plan/row/lineage data must fail closed.
4. Trace the real production path end to end. The authenticated method must be
   the mutation that performs deletion after `planClosedEpochCleanup` has
   established verified adoption, two rollback generations, availability,
   complete outbox classification and expected-head state. It is not enough to
   call `pruneAuthenticatedSettledPrefix` as a post-hoc replay after a legacy
   `prunePublishedPrefix` receipt already represents deletion. Prove that an
   incomplete plan cannot lose rows before the new gate runs and that
   mixed-epoch pending/published authenticated reclamation is actually reachable
   in production. If the current caller still supplies a receipt produced by
   legacy deletion and the new method only replays it, classify the severity.
5. Check the identity registry carefully: exact facade/backend binding, duplicate
   rejection, source/built-package copy behavior, filtered-facade aliasing,
   clone/proxy/foreign-store refusal, no forgeable public mutation authority,
   no second deletion implementation, and no unbounded retention. Assess the
   `Symbol.for`/`globalThis` boundary and whether same-realm code can pre-bind or
   replace a capability.
6. Confirm the recovery bound is exactly one active plus two rollback
   generations (`maxEpochVertices * 3`) and does not reject required retained
   rows or silently hide age-dependent scanning elsewhere. Do not approve a
   raised workload/threshold in place of the intended watermark/window law.
7. Confirm legacy `prunePublishedPrefix` and `creator-trusted-v1` behavior remain
   unchanged, no schema/store/wire/protobuf/crypto/dependency/threshold/public
   product API or authority change occurred, and journal/snapshot/seal/AHE
   physical retirement remains D.110c-c-owned.
8. Validate evidence: focused 21/21, retained 124/124 and 112/112, browser 4/4,
   affected builds, static gates, isolated focused 21/21 plus retained 124/124.
   Broad typecheck and f5b0a diagnostics are inherited only if the changed paths
   cannot cause them; evidence must not relabel an owned regression.
9. Report every concrete issue. P0/P1 correctness, security, scope, or evidence
   defects block closure; every P2 needs an owner/disposition. Apply the accepted
   design stop rules rather than inventing a wider fix.

Return exactly one JSON object and no prose before or after:

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
	"causal_red_confirmed": true,
	"scope_preserved": true,
	"evidence_sufficient": true
}
```

PASS requires zero P0 and zero P1.
