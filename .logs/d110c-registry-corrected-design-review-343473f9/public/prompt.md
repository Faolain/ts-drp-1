<task>
Review the corrected D.110c prospective current-registry governance contract
before separate RED/GREEN implementation release. Find material correctness,
security, scope, consumer-coverage or implementability gaps. This is design
review, not implementation acceptance. Judge the candidate independently.
</task>

<inputs>
Repository /Users/aristotle/Documents/Projects/ts-drp-1
Signed HEAD 343473f96243885d379da28a0f62c53bc03984ac
Read specs/current-registry-governance/README.md, verification.md, inventory.json,
runner.sh, gate-plan.mjs, typecheck.mjs, oracle-vectors.json,
oracle-construction.mjs and derive-inventory.mjs. These nine untracked files
are the frozen corrected candidate. No project test/compiler/checker has run.
Read .logs/d110c-registry-current-contract-preparation-8d81c8f4/current-owner-map-v2.md
for exact old test obligations and current source anchors. Inspect actual code
needed to challenge the proposal, especially root/child checkers and policies,
all eleven listed workflow consumers, historical fixture current-path tests,
author-authorization analyzer/harness and blueprint runtime profile validation.
Prior rejected review and dispositions are preserved under
.logs/d110c-registry-current-contract-design-review-8d81c8f4/public/.
Authority is in docs/production-hardening/production-hardening-tdd-plan-v2.md
around 104534, and first-review disposition around 105040. Do not read the
entire 100k-line plan. Eight dirty production owners are preserved/out of scope.
</inputs>

<requirements>
User explicitly authorized greenfield registry governance repair and separate
Astra-high RED/GREEN, Grok high, Sol high and Fable xhigh reviews. No deployed
rooms/external consumers require old development contracts. Do not ask again
for this authority. Registry bytes and production runtime remain unchanged.
One prospective transition owner; five child CLIs become integrity-only and
relinquish alternate current transition APIs. Missing/obsolete/partial bases
reject; no recursive historical projection, candidate checker fallback or
accept-either registry. Old signed attestations stay historical, not restamped.
Blueprint profile tuple stays exactly five keys and historical count 47 because
runtime validation requires it. Historical payloads do not pin live root policy.
The baseline amendment is explicitly outside approval by obsolete policy; local
tests must not claim old-base PR or remote host protection installation passed.

Assess complete inventory, hash-bound source/view validation on both snapshots,
mode/type/path custody, policy self-hash exclusion, fixed required source roster,
base-semantic mutants versus candidate-only custody mutants, no hardcoded
registry digest bypassing semantic tests, unchanged v2 execution, real Git
ancestry controls, preserved workflow jobs/setup/subsystem semantics, lifecycle
eight exclusions including **/.logs/**, actual readiness execution, historical
test supersession without suppression, independent canonical/hash oracle and
fresh strict compiler provenance. Check the scripts for concrete defects.
The exact runtime paths/log directories and observed test counts cannot exist
until implementation; judge whether the specified frozen commands/contracts
are sufficient to release RED, not whether GREEN code already exists.
</requirements>

<action_safety>
READ ONLY. File reads, path listing and text search only. Sol may use its shell
interface for cat/sed/rg/ls and equivalent read-only file inspection; this is
allowed explicitly because its read interface is shell-based. Do not execute
project code, proposal scripts, tests, compilers, builds, linters, profilers,
browsers, network research, Git mutations, file writes or process dumps. Do not
delegate or invoke another model. Grok/Fable use their permitted file tools.
Root has checked quiescence and handles custody. No private reasoning/credential
disclosure. Ground findings in files, label inference. No MCP symmetry claimed.
</action_safety>

<output_contract>
Return a single terminal JSON object with exactly these keys:
verdict: PASS | FAIL | NO_VERDICT;
findings: array of {severity: P0|P1|P2|P3, file: string, line: integer,
title: string, evidence: string, violated_requirement: string};
checked_requirements: array of strings; limitations: array of strings.
FAIL if required design corrections remain. PASS accepts only this specified
design for the next TDD stage, not implementation or future campaign acceptance.
NO_VERDICT if unable to complete review. Do not infer verdict from exit status.
</output_contract>
