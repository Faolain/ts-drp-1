# Rejected parent f5b RED — 0c59869a

Disposition: rejected causal matrix; not accepted RED and not GREEN.

Starting signed/pushed HEAD was `0a09b1caea3f59cc5629905ca704167ba5cdcf20` on
`codex/phase3a1b-p6-golden-path`. The tests-only commit is
`0c59869a5199b880bb944aced8b7c82f5aaa59f0`. Its signature and matching upstream
were verified before the sole focused execution. The tracked worktree was clean;
unrelated untracked files and all 27 stashes were preserved. The run used the
workspace's existing Vitest source aliases, the explicitly unified genuine Node
adoption module identity, deterministic test-only Ed25519 identities, and fresh
fake-indexeddb databases. It was not an isolated-checkout or browser campaign.

The focused JSON is the complete two-test result. Exactly one execution occurred.
Expected: one settlement failure at the legacy-carrier/advance seam and a passing
v1 control. Actual: two failures, zero passing tests, zero import/setup/top-level
failures. The frozen failure was not reached. No test or production correction
was made before this evidence was recorded.

## Exact failures and attribution

1. Parent integration: `creator close actor failed: CERTIFIED_VALUE_MISMATCH`,
   `packages/node/src/creator-close.ts:1031`. Real room issue and publication,
   two-writer ingress, and the real batched displaced-source precondition ran.
   The failure precedes settlement checkpoint creation, legacy-carrier creation,
   bounded advance, adoption and authenticated-frontier classification.
2. v1 control: `v3 room successor authority composition is unsupported`,
   `examples/v3-room/src/index.ts:1537`. Its close returned successor epoch 1 and
   genuine adoption completed. The helper then incorrectly retained
   `creatorFinalitySigner` while adding `successorSnapshotDeclaration`; the
   existing public input guard at lines 1531–1537 forbids that combination.
   This is fixture debt, not permission to change v1 behavior.

Read-only source attribution reveals an earlier omitted production composition
seam than the accepted design's legacy-carrier terminus:

- `packages/protocol-v3/src/creator-close.ts:276`:
  `prepareCreatorAnchorSigningRequest` requires
  `profile.profileId !== "creator-trusted-v1"` to be false. It therefore rejects
  the genuine settlement profile with `ANCHOR_TUPLE_INVALID`.
- The same file, lines 473–480: `prepareCreatorSuccessor` calls that helper with
  the closing trust's exact profile bytes, and maps rejection to
  `CERTIFIED_VALUE_MISMATCH`. `packages/seal/src/creator.ts:374–379` propagates
  that rejection; Node surfaces it before the missing checkpoint producer.
- `completeCreatorSuccessor` at line 541 also hardcodes the emitted trust record
  to `profileId: "creator-trusted-v1"`.
- `openCreatorSuccessorTrust` at line 598 also requires the decoded trust record
  profile to equal `creator-trusted-v1`.

These are existing successor-codec compatibility sites. No new API, authority,
schema, wire field, cryptography or dependency was shown necessary. No finding
against contiguity, device-local abandonment authority or anchor-based
old-incarnation admission was established. The prior design's accepted profile
composition inventory missed these sites; they must not be silently relabeled
as the originally frozen legacy-carrier failure.

## Coverage honestly not reached

No genuine checkpoint-derived `openProgressSources` branch ran. No three-close
or 64-active-writer continuation, same-key reentry continuation, manual-review
continuation or Byzantine scan continuation ran. No 27-case acceptance, pruning
closure, >=100-transition result, memory result, retained-suite baseline or
isolated result is claimed. No separately owned Phase-3 publication test changed.

## Precommit bounded gates

- Prettier, exact-path ESLint and `git diff --check`: passed on committed bytes.
- Exact Vitest listing: passed; both tests loaded through existing imports.
- A direct ad-hoc `tsc` command without workspace alias mapping was diagnostic
  only: it rejected root `@ts-drp` resolution and source/dist nominal brands;
  it was not a passing repository typecheck. It also identified the local actor
  label `f5b`, corrected to the existing `alice` label before commit. Six initial
  lint findings were corrected before the final passing exact-path lint.
- No focused execution, campaign, reviewer, subagent, or production edit occurred
  before the signed/pushed tests-only commit.

Root subsequently authorized one corrective tests-only RED: omit the signer on
declaration reopen and pin the genuinely earlier successor-codec terminus. This
packet remains immutable rejected evidence and is not retroactively corrected.
