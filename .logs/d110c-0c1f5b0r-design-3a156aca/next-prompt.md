# Handoff prompt: begin D.110c-0c1f5b0r implementation (f5b0a ∥ f5b0s)

Paste the block below as the first message of a fresh session on branch
`codex/phase3a1b-p6-golden-path` at or after signed commit `809745b2`.

---

Continue D.110c author settlement on branch `codex/phase3a1b-p6-golden-path`
from signed commit `809745b2` (verify with `git log --format='%h %G? %s' -1`).

Authority. The accepted design is
`.logs/d110c-0c1f5b0r-design-3a156aca/design.md` (verify
`manifest.sha256`). Its plan record is `###### D.110c-0c1f5b0r` in
`docs/production-hardening/production-hardening-tdd-plan-v2.md`. The
three-model Grok/Kimi/Opus design gate is waived for f5b0r by user decision on
2026-09-03; `pre-review.md` in the same directory is the accepted review. Do
not run another design review. Do not read the superseded f5b0, f5b0p or f5b0q
designs for grammar; their slice definitions are retained evidence only.

Read completely, in this order: `design.md`; `pre-review.md`; the f5b0r and
f5b plan records; `.logs/d110c-0c1f5b0-fable51-research-20260903/plan-change.md`
Parts A and C (crash walk and drop-in deltas); `lineage-profiles-impact.md` §3.
Then read the code seams named in design.md "Settlement checkpoint", "Fence
carrier", "Settlement plan store contract" and "Compatibility" before writing
any test.

Task. Start the two independent slices, in parallel or in either order:

1. f5b0a protocol codecs (design "TDD implementation slices" item 1): fence
   codec and global action reservation; settlement checkpoint codec with the
   `[author, admissionEpoch, terminalThrough]` frontier, derivation/binding
   rules (genesis members 0, added members `successorEpoch`, keyed on the
   current ACL), signer-agnostic prepare/open (sign under successor material,
   verify under floor trust, no current-key comparison), shape-only predecessor
   validation, `frontierFor`/`frontierCount`, 256-line frontier under a
   32,768-byte ceiling and version-3 ACL constants under the profile
   (D.110c-0c1k W1, `.logs/d110c-0c1k-fable51-research-20260903/solution.md`
   §3); `settlementProfileFor(profileId)` and its seven
   consumers; same-anchor equivocation rule. RED cases 17, 18, 22, 26, 27 and
   the codec halves of 5, 12.
2. f5b0s settlement plan store (item 2): the `SettlementPlan` /
   `SettlementPlanEntry` / `planEffect` / `readSettlementPlan` /
   `transactWriteSettlementPlan` contract in `@ts-drp/issuance-store`; memory,
   browser (fourth object store `settlementPlans`, schema bump, exact
   store-name check) and node (table migration) implementations; conformance
   vectors for CAS on `revision`, atomic `planEffect` inside `transactIssue`,
   fence-already-set and entry-absent/linked/manual-review failures, ambiguous
   outcome readback, corruption refusal, and the prune gate that refuses rows
   referenced by an unlinked entry. RED cases 3, 5, 10, 13, 25 store halves.
3. D.110c-0c1k stage W0 defects (independent; solution.md §3 W0): staging
   enforces the open path's decode limits and 31/64/65 members agree across
   stage, close, adoption and recovery; the duplicated `SCANNABLE_BYTES`
   filter becomes a loud per-kind rejection; per-snapshot O(1) membership
   lookup with an identical accept/reject set; per-author epoch share so one
   writer cannot exhaust a shared epoch. W0 RED cases 1-4.

Method. Each slice is one causal tests-only RED commit before any GREEN: the
tests must fail for the reason the design names, not for a missing import.
Record RED evidence under `.logs/d110c-0c1f5b0a-red-<sha>/` and
`.logs/d110c-0c1f5b0s-red-<sha>/` with a self-excluding `manifest.sha256`,
then update each slice's status in the plan. Focused, static, retained and
isolated gates as in the plan's slice governance; signed conventional commits;
`git commit --only <paths>`; never `cd`, always absolute paths or `git -C`.
No production edit before its slice's RED is committed. No wire-envelope or
protobuf change. No new cryptography. `creator-trusted-v1` behavior stays
byte-for-byte. No campaigns or long workloads. Subagents only with express
user authorization.

Stop rules (design "Acceptance and stop rules"). If RED or GREEN shows that
the checkpoint-carried `admissionEpoch` is insufficient, fall back to
`admissionEpoch` in a version-3 latched-ACL member record, never the retired
dictionary. If it shows contiguity does not hold on some path, that a
device-local plan is insufficient authority for the author's own abandonment,
or that anchor fencing is not the admission check for old incarnations, stop
and reslice; do not reintroduce the per-source grammar or a global floor.
P2 findings get an owner and disposition in the plan, not a new design round.

After both REDs: f5b0b Node (needs both GREEN), then f5b0c room, f5b0d
reclamation (needs f5b0a and f5b0s GREEN), then f5b creator settlement and
recovery integration with RED case 14 across at least three closes with
restart and cold reopen. Report each commit hash, what failed in RED and why,
and anything in the design that the code contradicted.
