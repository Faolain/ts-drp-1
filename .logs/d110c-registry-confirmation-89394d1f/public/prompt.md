<task>
Bounded confirmation of the corrected D.110c registry design after the second
review. Verify that the accepted findings are resolved and that the corrections
introduce no material contradiction. Do not restart an unrelated broad audit.
Acceptance is for RED authoring only, not implementation or campaign success.
</task>

<inputs>
Repository /Users/aristotle/Documents/Projects/ts-drp-1, signed HEAD
89394d1f027e338e7b0ef78c9ce6f099af8c0f3d.
Read the immutable second-review findings and root-dispositions.md under
.logs/d110c-registry-corrected-design-review-343473f9/public/.
Its spec/ directory preserves the exact previous nine-file candidate.
The CURRENT frozen candidate is all TEN files under
specs/current-registry-governance/: README.md, consumer-supersession.md,
verification.md, derive-inventory.mjs, inventory.json, gate-plan.mjs,
typecheck.mjs, runner.sh, oracle-construction.mjs, oracle-vectors.json.
Compare relevant corrected passages/scripts, not only this summary.
Read .logs/d110c-registry-corrected-preparation-89394d1f/runtime-budget-audit.md
for inspected nested execution facts. Its recommendations are not authority:
current consumer-supersession.md and verification.md explicitly select the
root decisions. Inspect actual sources where needed to verify those decisions.
Old obligation anchors remain in
.logs/d110c-registry-current-contract-preparation-8d81c8f4/current-owner-map-v2.md.
</inputs>

<corrections_to_check>
The inventory now separates semantic/historical classification and custody,
adds the complete successor fixture closure, makes the exhaustion consumer
editable, explicitly declares new byte protection, and leaves CODEOWNERS plus
ordinary lifecycle sources semantic-only in future transitions. Historical
compound tuples and currentSha256/currentBlob records are censused as data.
The trusted root fixes required paths/roles. Schema multiplier property FIRST;
future changes require reviewed amendment and required bump, no in-band exception.
Candidate mode/type uses worktree lstat and stage-zero index agreement; base
uses Git tree. Root policy has external binding, not a self-hash. Derivation
uses fileURLToPath and frozen-digest non-mutating stage verification. Compiler
baseline occurs after RED authors files, before acceptance/GREEN handoff.
Collector distinguishes decoded text/file-byte hashes and Vite transient writes.
Child Ed25519/blueprint transition exports and live callers are explicitly removed.

Review these deliberate execution decisions particularly:
1. All 29 whole-file/controlled-variant invocations execute in BOTH dedicated
current-source checkouts A/B, with independent dependencies and outputs.
No direct-main runtime claim. Main static/custody/final checkpoint checks stay.
This accommodates real nested protocol builds without touching main outputs.
Preparation commands/limits are specified; concrete capsules and exact authored
case/child counts freeze before execution, not before test source exists.
2. Retire successor eager current readiness/certification and all skip branches.
Retain historical model/census/Git authentication and controlled positive/negative
obligations. The five predecessor native checker replays and historical root
closure checker executions are explicitly SUPERSEDED by historical object/mode/
parent authentication with original signed execution evidence preserved.
Do NOT claim those native checks were rerun. This differs intentionally from
the audit recommendation to replay historical native checkers. Assess fidelity
to greenfield one-current-owner intent, not backwards execution compatibility.
3. Benign forwarding preload positive is retained. No blanket compromised
Git/Node/Bash resistance claim; actual base-extracted process errors propagate.
4. Semantic-only root config has closed selection grammar including duplicate/
computed keys, hooks, config mutation/export/plugin shape. Valid alias additions,
formatting and ordinary CI display-name changes remain positive controls.
Coverage include/exclude is not test selection. Real ordinary pnpm test step
must not be conditional, dead, comment-only or ignored on failure.
</corrections_to_check>

<fixed_requirements>
Explicit user greenfield authority: no deployed rooms/external consumers.
One prospective current root, unchanged registry and production runtime bytes,
no candidate fallback, obsolete/partial/missing bases reject, historical signed
evidence not restamped, production-compatible five-key historical tuple/count47.
Real v2 and ancestry/workflow routing controls; independent oracle; separate
Astra-high RED/GREEN and requested Grok4.6 high/Sol5.6 high/Fable5.1 xhigh.
Do not ask again for authority. No project test/compiler/checker/build has run
for this candidate; do not demand GREEN observations as a RED-authoring gate.
Runtime cardinalities/capsules remain mandatory execution release conditions.
</fixed_requirements>

<action_safety>
READ ONLY. Sol may use shell cat/sed/rg/ls or equivalent file inspection.
Grok/Fable use permitted file read/search tools. No project execution, proposal
script execution, tests, compiler, lint, build, profiling, browser, network,
writes, Git mutations, process dumps or delegation. Root supplies custody.
Do not expose private reasoning or credentials. No MCP symmetry claimed.
</action_safety>

<output_contract>
Return one terminal JSON object with exactly:
verdict: PASS | FAIL | NO_VERDICT;
findings: array of {severity: P0|P1|P2|P3, file: string, line: integer,
title: string, evidence: string, violated_requirement: string};
checked_requirements: array of strings; limitations: array of strings.
Explicitly report closure or remaining gaps for prior finding families and
the four deliberate decisions above in checked_requirements/limitations.
FAIL if required design corrections remain. PASS only accepts design for RED
authoring, never implementation. NO_VERDICT if unable to complete.
</output_contract>
