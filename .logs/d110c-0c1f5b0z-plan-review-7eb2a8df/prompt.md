<task>
Perform one bounded read-only plan review of f5b0z: backend-neutral discovery
of the EXISTING AHE maintenance capability. Decide whether its exact plan can
proceed to tests-only RED. Do not implement, edit, run tests, or invoke agents,
reviewers, network research, or shell-dependent tools. You are one independent
reviewer, not an orchestrator. RepoPrompt/MCP is not used; primary local source
is the evidence. No production GREEN or parent closure is claimed.
</task>

<grounding>
Review checkout: /private/tmp/d110c-f5b0z-review-Kg6cuq/checkout
Signed commit: 7eb2a8dfcec8af9a533b3308b6d1f060f52a90b4 (signature G),
verified pushed on codex/phase3a1b-p6-golden-path. This clean detached sparse
checkout contains NO seven-file uncommitted parent GREEN patch. Those changes
remain preserved in the main workspace and are not part of this review.

Read .logs/d110c-0c1f5b0z-plan-609ee4ba/design.md completely (authoritative
exact API, boundaries,16-case RED matrix and gates). Plan manifest was verified
by root:3entries, SHA256 c0b8948b67776b17595a6195927e4c61a5386e192f6d450af66e85d40e9cf172.
Read only the Current frontier subsection and D.110c-0c1f5b0z record in
docs/production-hardening/production-hardening-tdd-plan-v2.md; do NOT read the
entire 100k-line plan or reopen completed checkpoint designs.

Primary seams:
- packages/storage/src/maintenance.ts and types.ts, package.json.
- packages/issuance-store/src/maintenance.ts registry as existing precedent.
- packages/storage-browser/src/internal/ahe-reclamation.ts and src/maintenance.ts;
  registration caller src/internal/idb-adapter.ts near registerBrowserAheReclamationMaintenance.
- packages/storage-node/src/internal/ahe-reclamation.ts and src/maintenance.ts;
  registration caller src/internal/create-scaffold.ts near registerNodeAheReclamationMaintenance.
- Existing tests: packages/storage-node/tests/phase-6b-ahe-reclamation-red.test.ts;
  packages/storage-browser/tests/phase-6b-ahe-reclamation-red.pw.ts and assets entry;
  tests/phase-6b-ahe-reclamation-red.test.ts; tests/phase-6b-runtime-reclamation-red.test.ts.
- Only if needed for the boundary: packages/node/src/internal/creator-successor-live.ts,
  packages/node/src/v3-live.ts activateCreatorSuccessorLive. Parent caller work is deferred.
</grounding>

<review_questions>
1. Does the three-production-owner plan solve neutral discovery without
   adding an authority claim, backend dependency, ordinary facade field,
   alternate capability, deletion policy or cleanup invocation?
2. Do identity, first-bind-wins, backend-specific compatibility, duplicate
   registration and global module-instance rules compose with real constructors?
3. Is incompatible registry handling fail-closed and bounded for accidental
   incompatibility, without pretending to resist hostile same-process code?
4. Is the proposed16-test RED matrix genuinely causal and executable from the
   real existing backends, rather than missing-import/export failure, no-op
   mocks or false controls? Does GREEN actually exercise the later assertions?
5. Are retained lifecycle, no-I/O, closed/poisoned refusal, immutable source
   bodies and fresh-built import checks sufficient for this specific seam?
6. Identify concrete P0/P1 scope, correctness, compatibility or causal gate
   defects. P2 get an owner and disposition, not another review-only slice.
</review_questions>

<constraints>
User explicitly authorized f5b0z on2026-09-05, with review and separate RED/GREEN.
Do not ask for that authorization again. The former Fable-high consultation
is background input, NOT the formal approval under review. Parent cleanup,
64writer/threeclose and >=100transition claims remain unproved. No campaigns,
public Node/room API change, memory/time/workload threshold change, dependency
change, wire/schema change or new cryptography. Do not demand local adversarial
tamper resistance from a trusted-process registry. Ground any blocker in exact
code/contract consequences, not preferences or missing future parent work.
</constraints>

<output_contract>
Return one JSON object, no Markdown fence:
{"terminal":"VERDICT: PASS or VERDICT: CHANGES_REQUIRED","verdict":"PASS or CHANGES_REQUIRED","p0_count":0,"p1_count":0,"p2_count":0,"findings":[{"severity":"P0 or P1 or P2","title":"short","evidence":"exact source seam/line","impact":"concrete","required_action":"smallest correction and owner"}],"causal_red_assessment":"concise","compatibility_assessment":"concise","scope_assessment":"concise","ready_for_red":true}
PASS/ready_for_red=true requires zero P0/P1. Honest NO_VERDICT on service failure.
</output_contract>
