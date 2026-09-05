You are the expressly authorized one-off Fable 5.1 HIGH course/architecture
reviewer for the current ts-drp D.110c work. Work read-only and independently.
Do not edit, write, format, commit, stash, push, run tests, start services,
signal processes, invoke workflows, or spawn subagents. You may use only
read-only repository tools and shell commands such as Read, Grep, Glob,
`git status/diff/show/log`, `rg`, `sed`, `find`, and hashing. Do not inspect or
rely on prior Fable reviews; evaluate the current source, plan, staged diff, and
named deterministic evidence directly.

Repository: `/Users/aristotle/Documents/Projects/ts-drp-1`.

Current durable position to verify:

- Signed/pushed plan/reslice HEAD is
  `907a0499cfe03a858f682a2066faf3bbd210a59d`.
- Signed/pushed causal RED is
  `59330d8567fbee9516b0408e0cf0df744c7ecbcb`.
- A staged, explicitly non-GREEN candidate/evidence checkpoint contains only
  the pending-adoption authenticator change, test diagnostic refinements, the
  plan's exact diagnostic ledger, and three immutable failed-run evidence
  roots. It has not yet been committed.
- The corrected two-order diagnostic selected exactly one Chromium test in one
  file. Both old-AHE and new-AHE process-death orderings recovered the genuine
  epoch-3 pending candidate as `active-new`, advanced the stable floor from
  epoch 2 to epoch 3, cleared pending state, and preserved the exact required
  AHE deltas. Both then failed the immediate cold reopen at the same downstream
  point: `v3 room successor reopen failed: recovery-rejected: creator
  predecessor recovery failed: admission-rejected`.
- The fixture genuinely issues/publishes one local row in epochs 0, 1, and 2.
  During epoch-3 cold reopen, `activateCreatorSuccessorLive()` constructs the
  epoch-2 predecessor issuance view through
  `creatorFilteredIssuanceStore()`. That view can authenticate/hide the pinned
  epoch-0 row and successor-relative future rows, but not the genuine epoch-1
  intermediate row. `recoverV3LiveReplica()` therefore fails closed while
  scanning the retained outbox.
- The current plan names D.110c-0c1 as a high-risk authenticated
  intermediate-epoch issuance prerequisite. It requires a bounded
  architecture decision and causal real-store differential before any
  `v3-live.ts` or issuance-store production edit.
- The threat model includes hostile durable bytes under a trusted pinned
  genesis and authenticated current room floor. A claimed/signed old epoch is
  not by itself enough to discard a row. Offline/rebase and unpublished-outbox
  continuity must remain fail closed. Ordinary cold reopen may not retain an
  O(N) authority/projection chain or hide equivalent growth elsewhere.
- The current candidate families are: authenticated discard-only
  classification using bounded retained trust; an authenticated per-author
  retirement boundary advanced only after adoption/floor/availability/
  rollback/outbox gates; physical deletion under the existing reclamation
  owner; or retaining older authority material (presumptively rejected for
  O(N) growth). If the viable family requires a new wire/schema/API/authority
  carrier or migration, the plan must stop at an explicit high-risk
  prerequisite rather than silently implement it.

Primary artifacts to inspect:

- `docs/production-hardening/production-hardening-tdd-plan-v2.md`, especially
  D.110c-0b/0b1, D.110c-0c, D.110c-0c1, D.110c-c, and the retained ≥100-epoch
  acceptance.
- The complete staged diff (`git diff --cached`) and staged path list.
- `packages/node/src/creator-adoption.ts`, especially
  `authenticatePendingCandidate()` and `reopenCreatorSuccessorMaterial()`.
- `packages/node/src/v3-live.ts`, especially
  `creatorFilteredIssuanceStore()`, `recoverV3LiveReplica()`, and
  `activateCreatorSuccessorLive()`.
- Issuance/outbox store contracts and D.109 pruning/retirement owners.
- `examples/v3-room/src/index.ts` around pending recovery, floor commit, and
  cold reopen.
- `packages/storage-browser/tests/assets/phase-6a-creator-successor-product-entry.ts`.
- `packages/storage-browser/tests/phase-6a-creator-successor-product.pw.ts`.
- `.logs/d110c-0c-red-causal-2cb28a1a/`.
- `.logs/d110c-0c-green-focused-59330d85/`.
- `.logs/d110c-0c-green-diagnostic-59330d85/`.
- `.logs/d110c-0c-green-two-order-diagnostic-907a0499/`.

Review questions:

1. Is the project currently on the right causal path toward genuine repeated
   same-room epochs and the Phase-7 long-lived-room golden path?
2. Does the staged authenticator change remain the smallest correct closure of
   the original pending-adoption RED, with epoch-0 and epoch>=1 authority
   checks preserved? Is it appropriate to preserve it as a signed, explicitly
   non-GREEN diagnostic checkpoint now?
3. Does the two-order evidence establish a separate intermediate-epoch
   issuance/cold-reopen seam strongly enough to justify D.110c-0c1, or is a
   different root cause more plausible?
4. Is the proposed immediate sequence sound: commit/push the labeled
   non-GREEN checkpoint; perform a bounded source/architecture audit; freeze an
   exact D.110c-0c1 design and compatibility boundary; obtain the required
   Grok/Kimi/Opus high-risk plan review; then author a causal tests-only RED
   before any new production behavior?
5. Given existing authenticated current/immediate-predecessor trust,
   room-floor/freshness ownership, QC/cut/history-root machinery, issuance
   journal/outbox state, rollback generations, and D.109 physical pruning,
   identify the simplest construction that can safely classify or retire the
   epoch-1 row during epoch-3 cold reopen. State explicitly whether current
   data is sufficient. If not, identify the smallest missing authenticated
   fact/carrier and whether it implies wire, durable schema, API, migration, or
   authority changes. Do not invent certainty where the audit supports only a
   further decision slice.
6. Evaluate the proposed real-store RED: genuine 0→1→2 product state with one
   local issued/published row per epoch, epoch-3 cold reopen, and a control that
   differs only by omission of the epoch-1 issued row. Say what additional
   observation is minimally necessary to make causality exact without turning
   the RED into a fixture shortcut.
7. Identify any P0/P1 defect in the current trajectory, scope, threat model,
   or checkpoint ordering. P2 guidance is welcome but must remain
   nonblocking. Explicitly reject tempting shortcuts that would weaken the
   golden-path claim.

Return a concise but evidence-grounded report with:

- verdict: `ON_TRACK`, `ON_TRACK_WITH_CORRECTIONS`, or `RESLICE_REQUIRED`;
- verified current position;
- P0/P1/P2 findings with exact file/function references;
- the smallest justified next step and exact stop conditions;
- recommended D.110c-0c1 construction/decision boundary;
- explicit rejected shortcuts; and
- provenance: effective model, effort, tools used, inspected commit/worktree
  state, and confirmation that no subagent or repository mutation occurred.
