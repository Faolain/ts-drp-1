# Parent f5b corrected causal RED — 3a9e9329

The authorized corrective focused matrix matches: one causal settlement failure,
one passing genuine v1 control, no import/setup/top-level failure. This is RED,
not production GREEN, parent closure, retained-baseline acceptance, or proof of
all downstream cases.

## Signed history and execution custody

- Starting exact signed/pushed HEAD:
  `0a09b1caea3f59cc5629905ca704167ba5cdcf20`.
- Initial tests-only RED:
  `0c59869a5199b880bb944aced8b7c82f5aaa59f0`, executed exactly once with a rejected
  two-failure matrix. Immutable rejected evidence:
  `.logs/d110c-0c1f5b-red-0c59869a/`, signed/pushed in
  `50a3f494b64ec4935134b2acaa8bd6b90ff1cb9a`; its manifest SHA-256 is
  `304d719adacab999314ea3a8377d7c5f8fe200b0f1e1e246f52e35c879e071c0`.
- First corrective tests-only commit:
  `6610eec4`, signed/pushed and preserved. It was never executed: root's
  before-execution audit required preserving settlement creator signer custody.
- Final corrective tests-only candidate:
  `3a9e9329091b713022b2b36d371d1eb887633b6e`, signed/pushed before its sole run.
  Exact HEAD/upstream equality and signature were verified before execution.

The run used the tracked-clean shared checkout, existing Vitest source aliases,
genuine unified Node adoption module identities, deterministic test-only keys
and fresh fake-indexeddb databases. Unrelated untracked files and all 27 stashes
were preserved. No isolated checkout, real browser run, retained campaign,
reviewer, subagent, production edit, package/lock/schema/wire/API/dependency
change, or plan closure edit occurred.

## Exact observed matrix

`focused.json` contains the complete two-case result. Exactly one execution ran
at the final candidate, with no accommodation or rerun after it.

- FAIL: parent settlement integration. Exact token:
  `F5B_SETTLEMENT_PROFILE_SUCCESSOR_CODEC_REQUIRED`.
  Full message: `F5B_SETTLEMENT_PROFILE_SUCCESSOR_CODEC_REQUIRED: genuine
  settlement successor fails CERTIFIED_VALUE_MISMATCH before checkpoint
  production`.
  The cause is the real Node error `creator close actor failed:
  CERTIFIED_VALUE_MISMATCH`. All three accompanying successor-codec source-site
  assertions passed. The test first performed real room issue/publication,
  creator ingress and a genuine published displaced two-intent batch; it did
  not manufacture checkpoint bytes or call a private frontier branch.
- PASS: genuine v1 room issue, close, adoption, cold reopen and post-reopen issue.
  Its successor declaration path omits the creator finality signer, preserving
  the existing v1 input restriction. No v1 production behavior changed.

## Design/code contradictions and exact ownership

The accepted design's anticipated first missing seam was creator close's
legacy retirement/aggregate emission versus the settlement advance predicate.
The genuine run revealed an earlier compatibility omission:

1. `packages/protocol-v3/src/creator-close.ts:276`,
   `prepareCreatorAnchorSigningRequest`, requires the profile literal
   `creator-trusted-v1`. Its existing settlement profile input is rejected.
2. The same file, `prepareCreatorSuccessor:473–480`, passes the genuine closing
   trust's exact profile bytes to that helper and maps rejection to
   `CERTIFIED_VALUE_MISMATCH`; `packages/seal/src/creator.ts:374–379` propagates
   it and `packages/node/src/creator-close.ts:1031` throws before any checkpoint
   producer or legacy-carrier/advance mismatch can be reached.
3. `completeCreatorSuccessor:541` also emits the hardcoded v1 profile, and
   `openCreatorSuccessorTrust:598` also requires that hardcoded profile. The
   corrected test pins all three existing profile sites when classifying this
   actual failure. They are not synthetic-success adapters.

A separate downstream creator cold-restart composition seam is intentionally
retained. `examples/v3-room/src/index.ts:1531–1537` rejects the already-existing
`creatorFinalitySigner` plus `successorSnapshotDeclaration` input combination;
lines 2415 and 2453 bind creator close only without a declaration. Omitting the
declaration instead conflicts with the non-genesis stable floor at lines
1629–1636. The settlement creator continuation therefore preserves signer plus
genuine declaration and requires authenticated reopen followed by close rebind.
Only the legacy fixture omits the signer. No new API is proposed; the existing
public shape supplies both inputs. This is not permission to weaken floor,
snapshot, projection, signer or v1 checks.

No finding against contiguity, checkpoint admissionEpoch sufficiency,
device-local plan authority or old-incarnation anchor admission was established.
No retired per-source grammar, global floor or retired-key dictionary was added.

## Coverage caveat — verbatim handoff

Coverage caveat for handoff/evidence: this is now a valid causal parent RED
foundation, not a demonstrated full 27-case parent matrix. The file has
executable partial-progress/cold-reopen, 64×4 issue, same-key reentry,
manual-review/unlinked retention and fence-jump continuations, but they are all
blocked before the first checkpoint. Dedicated parent duplicate-slot-below-fence,
rollback, delayed-fence/delayed-replacement variants and full positive
pruning-gate coverage are not yet authored; closed codec/store/Node suites cover
several corresponding primitives only. I will make that explicit rather than
label the whole parent acceptance complete.

No checkpoint-derived `openProgressSources` execution is claimed in RED. The
continuation requires a real partial-progress source with an unlinked suffix to
survive despite a genuine later checkpoint placing that source below the
terminal boundary. Its first linked chunk must remain unchanged while only the
missing suffix is issued. That behavior must genuinely run after the earlier
producer/recovery seams are implemented; the branch is never called directly.

The 64-writer continuation is bounded: one object, 64 independent session
issuance stores, exactly four epochs (0–3), exactly three close/adopt transitions,
one genuine public application issue per writer per epoch (256 contributions),
and creator/noncreator restart/cold reopen. Exact published creator AHE and
snapshot bytes plus the genuine published floor are copied as a test transport
for deferred availability only. Receiver signature, closure, pinned-genesis,
floor, snapshot and projection checks are not bypassed. Its issuance and
journal stores are never replaced with creator rows. Membership alone is not
counted as contribution. None of this continuation executed in the RED run.

`acceptance.json` freezes the later >=100-transition gate as bounded acceptance
data only. No long workload ran, and no such result is claimed. Dedicated RED
review owns whether additional parent-specific tests are blocking before GREEN.

## Bounded gates

Exact-path ESLint, Prettier check, `git diff --check`, and exact two-case Vitest
listing passed on the final candidate. Its GPG signature was good and upstream
matched before execution. The initial rejected evidence records the earlier
ad-hoc tsc/alias diagnostic honestly; no repository-wide passing typecheck is
claimed. The inherited Phase-3 publishPending test was neither touched nor run.
