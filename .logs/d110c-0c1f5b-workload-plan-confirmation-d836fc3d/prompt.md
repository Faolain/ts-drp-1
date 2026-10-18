# D.110c-0c1f5b bounded workload-plan confirmation

You are one of three independent reviewers. Review only the signed and pushed
plan correction at commit `d836fc3da007c21984ee990ec7b9be1b9062e0d2` on
branch `codex/phase3a1b-p6-golden-path`. This is the single confirmation round
after an initial material P1. Do not propose additional review ceremony.

## Question

Does the corrected plan fully close the initial P1 without weakening the
genuine multi-chunk crash/restart proof or the 64-active-writer Discord/MMORPG
golden-path composition proof? Report any remaining P0/P1. P2 observations are
allowed but do not block.

## Initial P1 to confirm

The first amendment bounded case 3 and the wide case, but the shared
`openRoom()` helper still transformed displaced chat messages to 33,000
characters for sibling parent cases. Those sibling cases could therefore hit
the same 32,768-byte application-state ceiling, making the proposed RED fail
for fixture cost rather than the frozen production seam.

## Correction in signed commit d836fc3d

- Every parent consumer of the shared append-only chat fixture other than case
  3—including cases 1, 4/15/16/19, 24a, 25, and the independent 64-writer
  case—must use the deterministic 256-character transform and update exact
  effect expectations.
- The complete focused parent matrix must contain no
  `INVALID_APPLICATION_STATE` or other state-ceiling failure.
- The 64-writer case's modeled final canonical state is 14,303 bytes, and the
  executable test must assert the actual state is at most 32,768 bytes while
  preserving all 64 writers issuing real operations in every epoch, exact
  publication/application/plan/fence/replacement accounting, three genuine
  close/adopt transitions, offline/rejoin behavior, restart, cold reopen, and
  exact ACL/authority/anchor/history lineage.
- Case 3 alone owns the multi-chunk stimulus. It keeps a genuine two-intent
  displaced source, committed-prefix crash, same-epoch restart, intervening
  close, later restart, exact no-reissue/once-only suffix accounting, and
  three-close continuation. It may use the already-established tests-only
  batch-boundary blueprint pattern (or equivalent local blueprint): each
  operation has deterministic transient padding, remains under the unchanged
  65,536-byte per-operation limit, preserves action and identity, the pair is
  over the unchanged 65,536-byte application-batch limit, and the reducer's
  exact application state remains under the unchanged 32,768-byte ceiling.
  Transient padding is test stimulus only, not archived state or a product API.
- Closed f5b0u chunk-splitting evidence remains immutable.
- No production source, product API, wire/schema, cryptography, dependency,
  resource ceiling, timeout, or accepted prior evidence changes in this
  correction.
- The corrected tests-only RED must fail only at already accepted production
  seams, never due to a missing import/export, malformed blueprint, state-limit
  failure, or changed control.

The actual plan text is in
`docs/production-hardening/production-hardening-tdd-plan-v2.md`, record
`D.110c-0c1f5b`, especially the paragraphs beginning “The first parent GREEN
attempt” and “One bounded tests-only workload correction”. You may inspect the
signed diff `f50a4637..d836fc3d` and relevant test helpers read-only.

## Scope/decision rules

- Golden paths are the goal: do not accept a correction that turns the
  64-writer proof into membership-only coverage or removes case 3's real
  multiple replacement chunks.
- Do not request a new product API: none is needed for this correction.
- Only a concrete P0/P1 blocks the tests-only RED.
- Do not treat prose/bookkeeping preferences as blocking.

Return one bare JSON object and no surrounding prose:

```json
{
	"verdict": "PASS or BLOCK",
	"p0_count": 0,
	"p1_count": 0,
	"p2_count": 0,
	"findings": [
		{
			"severity": "P0, P1, or P2",
			"title": "short title",
			"evidence": "specific plan/code evidence",
			"required_action": "smallest necessary correction or disposition"
		}
	],
	"summary": "concise assessment"
}
```
