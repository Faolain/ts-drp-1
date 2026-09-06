# D.110c-0c1f5b0d corrective plan -> RED -> GREEN confirmation

Act as an independent read-only implementation reviewer. Do not edit files,
run long workloads, invoke subagents, or broaden this slice. Inspect repository
sources and evidence directly rather than relying only on this summary.

## Authority and custody

- Accepted design: `.logs/d110c-0c1f5b0r-design-3a156aca/design.md`, especially
  "Recovery, terminal rule and pruning", TDD item 5 and the stop rules. Verify
  its `manifest.sha256` and read sibling `pre-review.md`.
- Governing plan and explicit call-graph reslice:
  `docs/production-hardening/production-hardening-tdd-plan-v2.md`, current
  frontier and D.110c-0c1f5b record, signed/pushed at
  `adab0f56428bf0290a4437c83083db18e17eb2dc`.
- Rejected first GREEN and immutable review:
  production `1063feca39d60d24972ee101ab4051b4c1a23bb9`, evidence
  `352db7894c599872aaf2bbaace5250e775483e4f` and
  `307825ef35312dd76ca40d8997cfc990598cbdfa`, rejected review
  `e7c591910df47c4fa78569373cfe1ab533766bbf`, root
  `.logs/d110c-0c1f5b0d-review-307825ef/`.
- Corrective tests-only RED:
  `0cafd35762a8a1c3c5767c89227f9f42c5e89729`; RED evidence
  `a0bd87f131d467879d888c45c9cfdfa9042fc162`, root
  `.logs/d110c-0c1f5b0d-corrective-red-0cafd357/`.
- Corrective production GREEN:
  `292fc14f15a27befcd782a0eddf9aed23551619c`; GREEN evidence and
  current review anchor `502198f3c8355f20dc64ab10a9d70595b1998a63`, root
  `.logs/d110c-0c1f5b0d-corrective-green-292fc14f/`.
- Corrective production changes are limited to the authenticated pruning
  predicates in memory, browser and Node issuance stores. Tests remain in the
  four paths introduced/extended by the corrective RED.

## Scope boundary to review

The rejected review proved a call-graph contradiction: the first GREEN called
authenticated pruning only after a caller-supplied legacy deletion receipt,
and neither `planClosedEpochCleanup` nor `reclaimInstalledV3Runtime` had a real
product caller. Exploratory hot and cold settlement-profile fixtures stop
earlier at `CERTIFIED_VALUE_MISMATCH`; manufacturing a fixture call or checking
a comment would not prove production reachability.

The signed reslice preserves the accepted obligation but divides it at the
existing dependency boundary:

- corrective f5b0d owns the actual backend deleting transaction and its
  complete-plan/fence/link gate, mixed old-epoch pending/published deletion,
  closed-epoch ceiling, crash/rollback/replay/watermark behavior, backend
  parity and corruption classification;
- parent f5b integration, which is blocked until f5b0d GREEN, owns the first
  genuine every-peer production invocation after real checkpoint
  staging/close/adoption/rollback/availability/expected-head eligibility, the
  proof that no legacy delete runs first, incomplete-plan pre-mutation
  preservation, and behavioral settlement-versus-legacy recovery-scan bounds.

Do not block f5b0d merely because the explicitly assigned parent obligations
are not implemented yet. Do block if this split makes the backend contract
unsafe, falsifies evidence, weakens accepted security, or cannot support the
parent integration without a forbidden public/wire/schema/authority change.

## Required review

1. Confirm corrective RED causality: exactly 12 selected Vitest cases, 9
   controls passing and only memory/browser/Node future-epoch cases failing;
   each failure must show epoch 8 deleted under `closedEpoch = 7`, watermark
   advanced, and no `ISSUANCE_INVALID_ARGUMENT`. Confirm real Chromium fails
   for the identical reason. No missing import/export, stale build or fixture
   error may count.
2. Confirm the RED tests are unchanged by GREEN and cover pre-mutation refusal
   for absent plan, null fence, manual-review and unlinked entries; complete
   mixed epoch 5/6/7 pending+published deletion and replay; Node atomic rollback
   on injected partial deletion; permanent corruption classification; and
   exact-store/trusted-same-realm maintenance identity.
3. Inspect all three GREEN transactions. Every candidate issuance row with
   `epoch > closedEpoch` must cause exact `ISSUANCE_INVALID_ARGUMENT` before
   issuance/outbox deletion or watermark mutation. Eligible old epochs remain
   deletable across pending and published rows. Legacy exact-epoch pruning must
   be byte/behavior compatible.
4. Check transactionality, compare-and-delete custody, expected lineage/prior
   watermark, plan/fence/link/manual-review semantics, idempotent replay,
   partial failure rollback and corruption/refusal classification. Look for
   TOCTOU, parsing, integer, empty-prefix, cross-author/object or alias-store
   holes introduced or left material by this corrective diff.
5. Confirm scope: no public API, schema, wire/protobuf, cryptography, authority,
   dependency, threshold or workload change. Assess whether the exact-store
   maintenance binding remains sufficient under the trusted same-realm model.
6. Validate evidence honestly: focused 12/12, Chromium 1/1, retained 136/136,
   settlement/recovery 124/124, three affected builds, static gates, and clean
   isolated focused 12/12 plus retained 136/136. Broad typecheck diagnostics
   may be inherited only if evidence proves they are unchanged.
7. Review the reslice itself against the code and dependency graph. The parent
   f5b RED must remain blocking and causal for genuine product reachability,
   no-legacy-first deletion and recovery bounds; flag any wording that could
   let those obligations disappear.
8. Report every concrete issue. P0/P1 block this corrected f5b0d scope. Every
   P2 must name an owner/disposition: `f5b0d`, parent `f5b`, `D.110c-c`, or
   inherited. Do not promote already explicit parent work unless the current
   backend design makes it impossible or unsafe.

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
	"causal_red_confirmed": true,
	"scope_preserved": true,
	"evidence_sufficient": true,
	"reslice_sound": true
}
```

`PASS` requires zero P0 and zero P1.
