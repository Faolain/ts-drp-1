You are the single expressly authorized Fable 5.1/high read-only architecture
reviewer for ts-drp. This is a one-off course/trajectory review. Do not edit any
file, run tests or workloads, invoke agents/subagents, or review unrelated
untracked work. Inspect the current repository with Read, Glob, and Grep only.

Repository and immutable review anchor:

- branch: `codex/phase3a1b-p6-golden-path`
- signed/pushed HEAD: `da3e75514e3921b71d57d611d9e2b61785124b07`
- HEAD tree: `28ec9ed7762888193ee42d1803b7cb0a9a8f8a33`
- signed/pushed combined D.110c-0c1f2/f4 GREEN:
  `9e1781e0966953d7adce8cf6b0a4d9e56d12299a`
- signed/pushed corrected causal RED / plan anchor:
  `fcd8735c8316b048166560ab904704102ce90705`

Review whether our recent decisions and present trajectory are correct for the
actual golden-path need: a single long-lived room must perform genuine,
authenticated `epoch 0 -> 1 -> 2 -> ... -> N` transitions, survive restart and
reopen, continue issuing/publishing, keep active control/durable structures and
fresh-process post-GC memory bounded, safely prune only after authenticated
replacement plus rollback/availability gates, and feed Phase 7's genuine
multi-epoch archive/cold-join path. Distinct-room churn and synthetic epoch
records do not satisfy this.

Inspect at minimum:

- `docs/production-hardening/production-hardening-tdd-plan-v2.md`, especially
  D.110c-0c1f2, D.110c-0c1f4, D.110c-0c1f5, D.110c-c/d, the >=100-transition
  gate, and Phase 7 dependencies;
- `.logs/d110c-0c1f5-source-audit-fcd8735c/audit.md`;
- `.logs/d110c-0c1f24-green-working-fcd8735c/validation.md` and `commands.md`;
- `.logs/d110c-0c1f24-clean-9e1781e0/proof.md`;
- the current owners in `packages/node/src/v3-live.ts`,
  `packages/node/src/creator-adoption*.ts`,
  `packages/node/src/internal/creator-transition-advance.ts`,
  `packages/protocol-v3/src/index.ts`, and the focused D.110c tests.

Recent decisions to assess precisely:

1. D.110c-0c1f2/f4 now authenticate multi-author recovery frontiers and pinned-
   genesis bootstrap authority. The focused 41-test set, exact two-title browser
   proof, retained 195-test suite, affected builds/typechecks/lint/format/diff,
   and isolated offline checkout passed.
2. We removed an invalid transition-side successor-ACL check because the
   proposed closure has no detached successor ACL candidate and the check made
   genuine close fail. The creator instead derives the successor writer set
   from the authenticated successor snapshot ACL before signing; the aggregate
   carrier binds current/successor ACL digests. Decide whether this is a sound
   authority boundary or whether independent transition rederivation is a real
   blocker.
3. We did not declare the same-room loop complete. The f5 audit found a genuine
   rebase-supersession/contiguous-frontier gap: replacement rows get new target
   sequences, source rows become published, but the successor lacks an
   authenticated per-author proof that missing source sequences were superseded,
   so blindly raising a maximum frontier would authenticate unseen lower rows.
4. We created D.110c-0c1f5 as a blocking high-risk prerequisite and prohibited
   production edits until an exact proof construction and compatibility boundary
   are selected and reviewed. Candidate families include an authenticated
   source-retirement interval/bitmap, a signed per-author source-to-target rebase
   receipt, and a stronger aggregate supersession proof; a bare max is rejected.
5. The intended next order is: finish one formal Grok/Kimi/Opus review of the
   signed f2/f4 plan->RED->GREEN history, close those narrow semantics only if
   their blocking union is empty, then select/review an exact f5 design, execute
   deterministic causal RED/GREEN, and only afterward proceed to repeated same-
   room functional/restart/pruning and >=100-transition gates. No long campaign
   is currently authorized by this review.

Audit for hidden problems, especially:

- whether cross-source filtered issuance/rebase scans ever use the target
  successor bootstrap policy where the displaced source policy is required;
- whether aggregate/opening verification really binds object, author, exact
  contiguous frontier, current/successor ACL digests, genesis pin, and creator
  authority without trusting untrusted storage;
- whether f5 is the actual minimal missing product seam or merely a test/model
  artifact;
- whether the proposed f5 families preserve offline/rebase outbox continuity,
  fail closed on skipped/duplicated/substituted rows, and avoid O(N) hidden
  control growth;
- whether any completed narrow evidence is being overclaimed or needlessly
  reopened;
- whether the next ordering reaches the golden paths efficiently without
  skipping authority, restart, pruning, memory, durable-census, or Phase-7
  archive/cold-join obligations.

Return a concise, source-grounded result. Separate demonstrated defects from
risks and optional improvements. P0/P1 must identify an executable semantic,
security, evidence-integrity, or golden-path blocker with exact file/section
evidence; do not elevate prose/bookkeeping preferences. Recommend the smallest
justified next action and say explicitly whether to proceed, correct narrowly,
or stop/reslice. This review is advisory and cannot authorize production edits
or a campaign.

Model disclosure: Fable 5.1 (`claude-fable-5-1`), high effort, read-only, no
nested subagents. After this run, no further Fable invocation is authorized.
