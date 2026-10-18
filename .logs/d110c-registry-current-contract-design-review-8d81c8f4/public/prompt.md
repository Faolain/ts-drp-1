<task>
Review the proposed D.110c current registry governance design before its exact
RED/GREEN freeze. This is a design review, NOT implementation approval or a
request to run tests. Review the candidate on its merits; do not infer approval
from the author's proposed conclusions. Return actionable correctness/security,
scope or implementability findings, with file/line evidence. Explicitly assess
whether the remaining unspecified seams prevent an implementation release.
</task>

<inputs>
Repository: /Users/aristotle/Documents/Projects/ts-drp-1
Frozen HEAD: 8d81c8f47b9f5df0ff4e67caa01ae6f4008db707
Primary proposal:
.logs/d110c-registry-current-contract-preparation-8d81c8f4/current-contract-design.md
Independent source/RED proposal:
.logs/d110c-registry-current-contract-preparation-8d81c8f4/red-proposal.md
Authority: docs/production-hardening/production-hardening-tdd-plan-v2.md,
"Authorized greenfield contract resolution (2026-09-06)" around line 104534;
W0 final acceptance around line 105000. Do not read the whole 100k-line plan.
Inspect relevant actual source identified in these two bounded proposals.
Important anchors: packages/protocol-v3/scripts/check-protocol-v3-freeze.mjs;
packages/protocol-v3/conformance/freeze-policy-v3.json;
packages/protocol-v3/conformance/freeze-successor-v1/{check-freeze.mjs,freeze-policy.json};
packages/protocol-v3/registry/{registry-v1.json,registry-v1.schema.json};
seal-digest-identity-v1 and pacemaker-profile-v1 under packages/protocol-v3/supplements;
the active protocol-v3 workflows; existing schema-bijection and governance tests.
The eight dirty production owners are inherited, preserved, and OUT OF REVIEW.
</inputs>

<requirements>
The user fully authorized repair of registry governance, W0 compatibility and
grid authority composition under separate Astra-high RED/GREEN and Grok high,
Sol high, Fable xhigh reviews. This application is greenfield: no deployed rooms
or external consumers require old runtime/API compatibility. This review is ONLY
registry governance. No need to ask the user for the same authority again.
One current contract; no historical tree projection, dual registry, accept-either
hash or recursive bootstrap/custody chain. Preserve old signed evidence and do
not relabel old sign-offs as approval of current bytes. Preserve semantic and
anti-self-blessing invariants. Current registry already has optional multiplier;
do not change registry bytes or Node's supported runtime profiles.

Assess the prospective-baseline trust reset explicitly: old/missing bases reject;
CI loads the unique merge-base checker; base policy and inventory control the
candidate; no candidate fallback. Signed reviewed baseline establishment is
outside the old checker transition contract and is not claimed to pass an
old-base PR. Local current/current acceptance is explicitly not proof of the
old-to-new transition. Host branch protection is neither changed nor verified.
Does this preserve intended governance under the user's greenfield authority,
or hide an operational/security contradiction? Name exact fixes if needed.

Check full active consumer coverage, preserved subsystem custody/commands,
schema and independent oracle adequacy, true causal RED entry through an existing
export, mutation-baseline independence, and honest historical-test supersession.
Do not demand an obsolete development contract remain the current owner merely
because a historical test asserted it; demand its safety obligation be replaced.
</requirements>

<action_safety>
READ ONLY. Only inspect files, list paths and search text. No shell execution,
tests, builds, compilers, linters, profilers, browsers, network research, Git
mutations, file writes, process dumps or delegation. Do not invoke any other
model. Root has checked quiescence before launch. Do not display private
reasoning streams or credentials. Ground findings in current files; label
inferences. No RepoPrompt/MCP symmetry is needed or claimed.
</action_safety>

<output_contract>
Return a single terminal JSON object with exactly these keys:
verdict: PASS | FAIL | NO_VERDICT;
findings: array of {severity: P0|P1|P2|P3, file: string, line: integer,
title: string, evidence: string, violated_requirement: string};
checked_requirements: array of strings;
limitations: array of strings.
FAIL if a required design correction remains; PASS means this candidate's
specified design is sound, not that implementation or remaining exact freeze
details are accepted. Explain any still-required freeze detail in limitations
and raise a finding if its absence makes the proposed contract unsafe/unusable.
Do not infer a verdict from exit status. Be concise; prioritize material issues.
</output_contract>
