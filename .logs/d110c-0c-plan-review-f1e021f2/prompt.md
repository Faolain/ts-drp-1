# D.110c-0c bounded plan review

Act as a read-only senior distributed-systems/security reviewer. Do not edit
files, run tests or campaigns, invoke D.110a, or spawn subagents. Review signed
and pushed plan commit `f1e021f283048e8e80771fa62347902c94a40227`
(tree `fa843fcd813076bbfac7163d6bbe0e30ed892db5`, parent
`ff1a9807528b1f29c8d1f381f0c093baf5a5d506`). The exact remote branch is
`origin/codex/phase3a1b-p6-golden-path`.

Read the complete plan subsection `D.110c-0c durable pending-adoption resume
plan` in
`docs/production-hardening/production-hardening-tdd-plan-v2.md`, all files in
`.logs/d110c-0c-plan-audit-ff1a9807/`, and the current complete relevant owners:

- `packages/node/src/creator-adoption.ts`
- `packages/node/src/creator-adoption-recover.ts`
- `packages/node/src/internal/creator-adoption-recover.ts`
- `packages/node/src/internal/creator-transition-advance.ts`
- `packages/node/src/creator-adoption-activate.ts`
- `examples/v3-room/src/index.ts`
- `packages/node/src/v3-live.ts`
- `packages/storage-browser/tests/assets/phase-6a-creator-successor-product-entry.ts`
- `packages/storage-browser/tests/phase-6a-creator-successor-product.pw.ts`
- `tests/phase-6b-d110c-0b0a-staged-handoff-red.test.ts`
- `tests/fixtures/phase-6b-d110c-a/repeat-close-contract.ts`

Review these exact questions:

1. Does the audit identify the real epoch-2→3 pending-recovery defect: the
   existing recovery entry and room composition are present, while only the
   private pending authenticator remains pinned to projection/trust/closure/
   carrier/chain assumptions for 0→1?
2. Is reusing the accepted D.110c-0b1 checkpoint opener plus the one Node-private
   transition classifier sufficient for N≥1 without a new public API, wire
   field, authority carrier, dependency, schema, or O(N) proof chain? Flag any
   missing authenticated input or unsafe trust of storage.
3. Does the plan preserve exact 0→1 compatibility and keep the existing
   generation-lineage, fork, CAS-reread, room-head commit, snapshot, catalog,
   parameters, ACL, and active-reopen owners authoritative?
4. Is the persistent-profile two-ordering RED genuinely causal and feasible?
   It must create real product state through 0→1→2, stage a genuine epoch-3
   candidate, establish the authenticated pending room-head pair, terminate all
   runtime custody without graceful cleanup, reopen the same durable profile
   and origin, and fail only at the current production pin. It must not forge
   epoch-3 records or pass in-memory capabilities across restart.
5. Are the old-AHE/new-AHE crash orderings and room-head/AHE commit order safe?
   Recovery may publish only an authenticated candidate, commit the floor only
   after AHE publication, never treat pending as adopted, and activate only via
   the separate cold-reopen owner against the committed floor.
6. Are the exact RED token/count and GREEN functional/adversarial gates enough
   to establish causal closure, idempotence, fork/stale/substitution resistance,
   exact state/history/ACL/anchor/snapshot/journal/operation continuity, and
   post-restart issue/publish?
7. Is deferring the noncausal issuance-filter counter/combined-ceiling and
   arbitrary-intermediate issuance retirement work to D.110c-c correct and
   explicitly blocking before D.110c-d, or does it invalidate this pending
   recovery slice? Distinguish a fail-closed limitation from a security bypass.
8. Is any acceptance internally contradictory, unimplementable with the
   current test seams, broader than the demonstrated defect, or liable to hide
   test-authored positive state? Propose the smallest exact correction.
9. Confirm scope and custody: no production edit before review, no D.110a or
   campaign, no Fable/collaboration subagent, literal audit command, good plan
   signature/push, 27 stashes/protected paths, and a valid self-excluding audit
   manifest.

Only P0/P1 findings block RED. P2 findings receive an owner/disposition and do
not make the blocking union false. Return exactly one JSON object matching the
schema, with no prose before or after it.
