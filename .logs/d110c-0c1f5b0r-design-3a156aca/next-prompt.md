# Handoff prompt: implement D.110c-0c1f5b0r and D.110c-0c1k W0

Paste the block below as the first message of a fresh session on branch
`codex/phase3a1b-p6-golden-path`. It assumes the multi-agent TDD pipeline the
plan uses elsewhere; the role names are yours to keep or change.

---

Continue the ts-drp production-hardening plan on branch
`codex/phase3a1b-p6-golden-path` at signed commit `d542b98d` or a descendant
(verify with `git log --format='%h %G? %s' -1`; if the branch is not on the
remote yet, push it before spawning any subagent that runs in another clone).

Entry point. Read, in this order:

1. `docs/production-hardening/production-hardening-tdd-plan-v2.md`, the
   subsection "Current frontier — author settlement and writer capacity" under
   "Sequencing at a glance". It lists what is authorized now, what is blocked
   and on what, and the method. It wins over any "Prior status" text in a
   superseded record.
2. `.logs/d110c-0c1f5b0r-design-3a156aca/design.md` (verify `manifest.sha256`)
   and its sibling `pre-review.md`. The three-model design gate is waived for
   this design by user decision on 2026-09-03; `pre-review.md` is the accepted
   review. Do not run another design review. Do not read the superseded f5b0,
   f5b0p or f5b0q designs for grammar.
3. The plan records `###### D.110c-0c1f5b0r`, `###### D.110c-0c1k` and
   `###### D.110c-0c1f5b`.
4. `.logs/d110c-0c1k-fable51-research-20260903/solution.md` §1 and §3 W0/W1.
5. `.logs/d110c-0c1f5b0-fable51-research-20260903/plan-change.md` Parts A and
   C, and `lineage-profiles-impact.md` §3.
6. The code seams named in design.md "Settlement checkpoint", "Fence carrier",
   "Settlement plan store contract" and "Compatibility", before writing any
   test.

Task. Four independent slices, tests-only RED first, runnable in parallel:

1. **f5b0a protocol codecs** (design "TDD implementation slices" item 1): fence
   codec and global action reservation; settlement checkpoint codec with the
   `[author, admissionEpoch, terminalThrough]` frontier, derivation and binding
   rules (genesis members 0, added members `successorEpoch`, keyed on the
   current ACL), signer-agnostic prepare/open (sign under successor material,
   verify under floor trust, no current-key comparison), shape-only predecessor
   validation, `frontierFor`/`frontierCount`, a 256-line frontier under a
   32,768-byte ceiling with 257 and 32,769 pinned as rejections, the version-3
   latched-ACL constants accepted only under the settlement profile (cap 256,
   65,536 bytes, decode limits `{maxBytes: 65_536, maxDepth: 4, maxItems:
   8_192}`) with versions 1 and 2 and their 65-pins untouched;
   `settlementProfileFor(profileId)` and its seven consumers; same-anchor
   equivocation rule. Design RED cases 17, 18, 22, 26, 27 and the codec halves
   of 5 and 12; 0c1k RED cases 5, 6, 7.
2. **f5b0s settlement plan store** (item 2): the `SettlementPlan`,
   `SettlementPlanEntry`, `planEffect`, `readSettlementPlan` and
   `transactWriteSettlementPlan` contract in `@ts-drp/issuance-store`; memory,
   browser (fourth object store `settlementPlans`, schema bump, exact
   store-name check) and node (table migration) implementations; conformance
   vectors for CAS on `revision`, atomic `planEffect` inside `transactIssue`,
   fence-already-set and entry-absent/linked/manual-review failures, ambiguous
   outcome readback, corruption refusal, and the prune gate that refuses rows
   referenced by an unlinked entry. Design RED cases 3, 5, 10, 13, 25 store
   halves.
3. **D.110c-0c1k stage W0 defects** (solution.md §3 W0): staging enforces the open path's decode limits; 31, 64 and 65 writer-only
   members and 41 full-shape members agree across stage, close, adoption and
   recovery under the unchanged 8,192-byte ceiling of ACL versions 1 and 2
   (raise `maxItems` so it never binds below the byte ceiling; never raise the
   byte ceiling; 64 full-shape members are impossible in v1 and belong to W1's
   version-3 snapshot); the duplicated `SCANNABLE_BYTES` filter in
   `packages/node/src/creator-close.ts` becomes a loud per-kind rejection;
   per-snapshot O(1) membership lookup with an accept/reject set identical to
   `members.find` on 8,192 vertices, permissionless and not; a per-author epoch
   share so one writer cannot exhaust a shared epoch, fences counted, epoch
   still closes. 0c1k RED cases 1 to 4.
4. **D.110c-0c1j-0 genesis lineage-policy reservation** (end of the 0c1j plan
   record): one optional `parameters.lineagePolicy` key in the registry
   `parameters` kind and the genesis builders; absent key is byte-identical
   to today's parameters and digest; only `fixed-creator` is room-accepted at
   genesis; no protocol-v3 or Node change. 0c1j-0 RED cases 1 to 5.

Pipeline per slice. One RED agent writes the tests-only RED commit; the tests
must fail for the reason the design names, not for a missing import or a
missing export. One GREEN agent makes them pass with the narrowest production
change that the design allows, in a separate commit. Independent reviewers
(the plan's default is Grok 4.6/high and Kimi K3 with
`KIMI_LOOP_MAX_STEPS_PER_TURN=100`; add Opus xhigh if the slice touches
`packages/protocol-v3`) review RED and GREEN against the design; the slice
closes only when their P0/P1 union is empty, and every P2 gets an owner and a
disposition in the plan. Evidence under `.logs/<record-id>-red-<sha>/`,
`.logs/<record-id>-green-<sha>/` and `.logs/<record-id>-review-<sha>/`, each
with a self-excluding `manifest.sha256`. Focused, static, retained and isolated
gates as in the plan's slice governance. Signed conventional commits with
`git commit --only <paths>`; never `cd`, always absolute paths or `git -C`.
Update the slice's status paragraph and the "Current frontier" subsection in
the commit that closes it. Pushed refs before a slice is called closed.

Constraints. No production edit before its slice's RED is committed. No
wire-envelope or protobuf change. No new cryptography. `creator-trusted-v1`
behavior stays byte-for-byte, except that W0 lets an ACL that already fits the
byte ceiling decode when staging admitted it. No campaigns or long workloads.

Stop rules (design "Acceptance and stop rules"; 0c1k record). If RED or GREEN
shows the checkpoint-carried `admissionEpoch` is insufficient, the fallback is
`admissionEpoch` in a later latched-ACL member-record version (version 4 in
D.110c-0c1k W2), never the retired dictionary. If it shows contiguity does not
hold on some path, that a device-local plan is insufficient authority for the
author's own abandonment, or that anchor fencing is not the admission check
for old incarnations, stop and reslice; do not reintroduce the per-source
grammar or a global floor. Never raise `maxEpochVertices` without fixing the
quadratic `sequences.includes` in the close scan first.

After the first three (0c1j-0 gates nothing): f5b0b Node (needs f5b0a and f5b0s GREEN), then f5b0c room,
f5b0d reclamation (needs f5b0a and f5b0s GREEN), then f5b creator settlement
and recovery integration (needs f5b0a to f5b0d and W0 GREEN) with design RED
case 14 across at least three closes with restart and cold reopen. Stage W2 is
not authorized; its path is at the end of the 0c1k record. Report each commit
hash, what failed in RED and why, the reviewers' union, and anything in the
design that the code contradicted.
