# D.110c-0c1a single material plan confirmation

Resume the prior read-only D.110c-0c1a authority-design review. Do not restart
the architecture audit, edit files, run tests/campaigns, invoke D.110a, or spawn
subagents. Review signed/pushed correction commit
`037b82442167ef27b750b2349ec66f1285780e59` (tree
`a0afed6257fb0ba75f0ace792036351fac923126`, parent
`fc384d1fe3d503bb9e3706e97bf62bea39fe8a7c`) on
`origin/codex/phase3a1b-p6-golden-path`.

Read the exact correction diff and current complete `D.110c-0c1a` decision and
slice text in
`docs/production-hardening/production-hardening-tdd-plan-v2.md`. Consult the
same pinned owners only where needed to verify closure of the prior blocking
findings. Raw prior findings and dispositions are under
`.logs/d110c-0c1a-plan-review-fc384d1f/`.

This is the sole material confirmation. Answer only whether the corrected text
closes the prior P0/P1 union without introducing a new P0/P1:

1. Pending liveness: the signed frontier now authenticates dense historical
   admission in the genuine closing graph and sealed replay, independently of
   publish/prune state. A pending row admitted at its own close is covered but
   remains pending, visible to offline/rebase, and not prune-eligible. Does this
   remove the close deadlock without laundering publication state?
2. Cross-epoch pending: because every admitted row is certified at the close
   whose graph contains it, a later recovery can authenticate the old address
   from the cumulative signed frontier. The future filter must hide only a
   covered published row and must expose a covered pending row to existing
   rebase custody. Does this close the permanent-boundary pin while preserving
   fail-closed behavior?
3. Bounded derivation: the close graph/replay is the authority and bounded
   candidate set; at most `maxEpochVertices + 1` paged observations are allowed;
   lineage is only a consistency upper bound; gaps/duplicates/substitution or a
   later admitted row after a hole refuse; empty initialization refuses; and
   exhausted lineage refuses once without scanning toward
   `Number.MAX_SAFE_INTEGER`. Is the derivation now finite and exact?
4. Closure law: epoch-0 adds exactly one record; N≥1 replaces exactly one prior
   record with exactly one successor. Each stage/verify consumer first opens
   the candidate against pinned-genesis creator trust and the authenticated
   floor. The Node-private `inspectCreatorTransitionAdvance()` wrapper then
   verifies/strips only that exact delta before invoking the unchanged existing
   control-plane predicate and returns the original proposal. Can this preserve
   all existing exact closure rejections without editing control-plane owners?
5. Confirm the source-owned domain constant (no registry-v1 edit), explicit
   genesis sentinel, 8,192-byte bound, transition-vs-cold opener checks,
   active/pending-vs-rollback census, D.109d reconciliation, and asserted RED
   preconditions close the prior P2 guidance without expanding this
   prerequisite into filtering or pruning.
6. Is the tests-only RED still causal and feasible, and is production work now
   authorized? Identify any remaining P0/P1 with the smallest exact correction.

Only P0/P1 blocks RED. P2 is nonblocking and must have a concrete disposition.
Return exactly one JSON object matching the provided schema, with no prose
before or after it.
