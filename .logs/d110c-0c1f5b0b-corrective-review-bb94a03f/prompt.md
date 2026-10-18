# D.110c-0c1f5b0b final corrective GREEN review

Act as an independent senior security/correctness reviewer. Review the complete accepted design → causal RED → rejected first GREEN → corrective RED → final GREEN history for the narrow f5b0b Node slice. Inspect the repository and named immutable evidence; do not modify files, run long workloads, or propose scope expansion merely as cleanup.

Accepted design and authority:

- `.logs/d110c-0c1f5b0r-design-3a156aca/design.md`, especially "Author drain, plan and fence", TDD item 3, RED cases 3/5/10/13/21/25, and stop rules.
- `.logs/d110c-0c1f5b0r-design-3a156aca/pre-review.md` is the accepted design review. Do not review superseded f5b0/f5b0p/f5b0q grammar.
- f5b0a, f5b0s, W0 and D.110c-0c1j-0 are inherited closed prerequisites. This review must not reopen them.

History and evidence:

- Rejected first GREEN/evidence: production `93585bf3`, evidence `9b02f9c2`, formal rejected-review evidence commit `8225ffc7`; `.logs/d110c-0c1f5b0b-review-9b02f9c2/`.
- That review's blocking findings were: legacy creator-trusted-v1 join/causalJoin incorrectly reclassified as control; ordinary same-store displaced authorSequence 0 suppressed; settlement recovery omitted issued/outbox corruption comparison; generic issuance-outcome-unknown preempted terminal outcome-unknown latch. It also required typed malformed settlement-plan refusal.
- Corrective tests/evidence span signed commits `bc773799` through `449b95a3`. The canonical final REDs are `.logs/d110c-0c1f5b0b-red-9a4b35f4/` and `.logs/d110c-0c1f5b0b-red-6e542c3d/`; earlier roots remain immutable diagnostic history.
- Final production commit `e07f8a94d5e2449289bebd7aa89f1dcdbd4d9536` changes only `packages/node/src/v3-live.ts`. Final evidence commit is current reviewed anchor `bb94a03ff81dfedb9d7ae1865c6adaed6c05fc58`; evidence root `.logs/d110c-0c1f5b0b-green-e07f8a94/`, whose `production.diff`, `matrix.md`, `README.md`, `source-audit.txt`, `commands.md`, `result.json`, custody and manifest are authoritative.

Review obligations:

1. Verify the tests-only RED is genuinely causal, not missing-import/export failure, and that fixture corrections preserve public response shape and exact legacy singleton intent fields.
2. Verify the final one-file production diff closes every prior P0/P1 without widening APIs, wire/protobuf/schema, dependencies, thresholds, product authority, room behavior, pruning, W0, or lineagePolicy.
3. Verify `creator-trusted-v1` join and causalJoin remain application-visible through ingress, local issue, recovery, close/application accounting and rebase intents, while malformed ABI remains rejected; settlement profile join/causalJoin/fence remain control-only and never reach application accounting.
4. Verify same-store ordinary sequence 0 is surfaced, while genuine cross-object activation vertices and a known same-store activation digest remain excluded. Look for false classification of an ordinary sequence-0 row as bootstrap.
5. Verify settlement recovery still cross-checks issued versus outbox, malformed/absent/wrong-scope plans fail closed through `copySettlementPlan`, and fence refusal/halting semantics remain correct.
6. Verify terminal transaction outcome-unknown returns the terminal latch/result rather than the generic issuance error, without weakening nonterminal ambiguity handling.
7. Verify retained/static/isolated evidence is sufficient and honest. The initial shared-child failure used stale gitignored `dist`; it is retained as invalid runtime identity, followed by Node rebuild, built-shape proof, unchanged replacement pass, rebuilt 64/64 shared consumers, and detached built-child pass. Do not treat the stale-dist result as a product failure or erase it.
8. Check for any contradiction with the design stop rules: contiguity, device-local plan authority, or anchor fencing. If found, P0/P1 and stop/reslice; do not suggest retired grammar/global floor.
9. Identify all remaining issues. Only concrete correctness/security/evidence defects in this slice may be P0/P1. P2 must name an owner and disposition. Existing future ownership for authenticated frontier threading/classifier-local terminal suppression, replacement planEffect authority, and payload-seeded settlement control-set handling belongs to f5b0c/f5b; inherited Node typecheck output is byte-identical to parent.

Return exactly one JSON object and no prose before or after it:

{"verdict":"PASS|BLOCK","summary":"...","p0_count":0,"p1_count":0,"p2_count":0,"findings":[{"severity":"P0|P1|P2","title":"...","evidence":"path:line or evidence file plus concrete reasoning","required_action":"...","owner":"f5b0b|f5b0c|f5b|inherited"}],"causal_red_confirmed":true,"scope_preserved":true,"evidence_sufficient":true}

`PASS` requires zero P0/P1. Do not omit a real finding to achieve PASS.
