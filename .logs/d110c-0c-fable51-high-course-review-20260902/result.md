## D.110c-0c review: verdict `RESLICE_REQUIRED`

The pending-authenticator candidate is correct and minimal, but the 0c GREEN gate as written cannot be met inside 0c's authorized owner set. The post-commit `admission-rejected` is a deterministic, pre-existing cold-reopen seam in `v3-live.ts` that the plan's own 0b1 closure text deferred to D.110c-c. Continuing 0c means either silently editing `v3-live.ts` or weakening the fixture. Both are forbidden. A narrow prerequisite must be resliced before any further production edit.

### Verified evidence

- HEAD is `59330d85`, GPG-signed (`G`), equal to `origin/codex/phase3a1b-p6-golden-path`. Working tree carries only the three described modified files plus protected/untracked state, which I did not touch.
- Causal RED root `.logs/d110c-0c-red-causal-2cb28a1a/`: `validate-red.json` shows unexpected 1, two soft failures, orderings old-ahe and new-ahe, zero top-level errors, zero production-source diff. Manifest and validator status files are both `0`.
- The uncommitted `creator-adoption.ts` diff touches only `authenticatePendingCandidate()` plus removal of the now-unused `inspectCreatorTrustAdvance` import. No other function changed.
- Focused GREEN root: Playwright failed inside the fixture with `D110C_0C_FAILED_RECOVERY_FLOOR_MUTATED`. That invariant fired because the floor legitimately advanced.
- Diagnostic GREEN root: the old-ahe attachment shows `callCount 1, resultKind active-new, swapHeadCount 1`, floor before `{stable 2, pending 2→3}`, floor after `{stable 3, pending null}`, and the exact reopen error string.
- Fixture `d110c0cStage()` issues one message in epochs 0, 1, 2 through the real room, then seals and interrupts 2→3.

### Answers

**Candidate change.** It is the smallest correct closure and matches plan steps 1 to 7. No authority check was weakened. At N≥1 it defers genesis-carrier verification to `openCreatorCheckpointTrust()`, which verifies both predecessor and current signatures against the genesis key, profile/signer-set equality, and the expected next head, then pins predecessor and successor trusts to the floor pair. At epoch 0 the opener, successor opener, carrier equality, predicate, and chain values are semantically unchanged, and the epoch-0 branch now additionally applies the cold-reopen owner's projection bindings, which is strictly stronger. The branch is not byte-preserved as the plan's audit wording demands; prove semantic preservation by call sequence.

**The `admission-rejected` is a genuine separate seam.** The error is produced after `reopenCreatorSuccessorMaterial()` authenticated the full chain. In a fresh process there is no displaced authority. The predecessor view built by `creatorFilteredIssuanceStore(..., excludedAfterEpoch = 2, pinnedGenesis)` hides only successor rows above epoch 2 and pinned-genesis epoch-0 rows. The epoch-1 row falls through, cannot authenticate against epoch 2, and predecessor recovery rejects it. This matches the 0b1 closure text that deferred general intermediate-epoch issuance retirement/recovery to D.110c-c.

**Reslice.** The evidence supports a decision slice plus causal RED, not a chosen mechanism.

- Owner: `packages/node/src/v3-live.ts`, specifically predecessor/successor issuance views in `activateCreatorSuccessorLive()` and outbox classification in `recoverV3LiveReplica()`. If a durable retirement marker is required, the `@ts-drp/issuance-store` outbox contract joins the owner set and triggers wider schema review.
- RED: a deterministic real-store/product-path 0→1→2 sequence with one row per epoch and epoch-3 reopen, plus a control without the epoch-1 row, to establish that row as the sole cause before production edits. Retain both existing process-death orderings as consuming evidence.
- Security: fail closed for rows not authenticated against exact retained authority; never skip by claimed epoch alone; never erase or treat unpublished rows as published; use per-scan counters under one combined `maxEpochVertices` ceiling; bind retirement to authenticated lineage; preserve the bounded closure census.
- Relationship to D.110c-c: carve out only the minimum epoch≥3 cold-open/intermediate-row prerequisite. D.110c-c retains physical pruning, census, repeated cleanup, and the completed-head epoch pin.

Weakening the fixture by removing epoch messages, accepting only floor commit, or deferring same-process reopen would invalidate RED→GREEN causality and the golden-path intent.

### Findings

- **P1-A:** The plan requires epoch-3 cold reopen/post-restart work while forbidding the required `v3-live.ts` change and already deferring that capability. Split 0c into a committed-floor checkpoint and a cold-reopen consumption gate sequenced after the prerequisite.
- **P1-B:** The diagnostic run covers only old-AHE because a hard post-commit assertion aborts before new-AHE. Make it soft and continue so one run serializes both orderings before freezing the prerequisite RED.
- **P2-1:** Epoch-0 is semantically preserved and strengthened, not textually byte-preserved; use a call-sequence/semantic audit.
- **P2-2:** The diagnosis script's file-global substring checks are diagnostic only, not acceptance evidence.
- **P2-3:** After `active-new`, assert AHE equality modulo the single old-AHE head swap and full equality for new-AHE.
- **P2-4:** Do not widen production error strings; establish exact failure through the differential control.
- **P2-5:** Typecheck/lint/build gates remain mandatory before signing.

### Recommended next step

Freeze the plan amendment, sign the candidate and test refinements only as a labeled non-GREEN checkpoint, then run the reslice RED. Reject editing `v3-live.ts` inside 0c, skipping rows by epoch number, synthetic displaced authority, reopening before floor commit, marking intermediate rows published, relaxing the room epoch pin, or weakening the fixture.

### Provenance

Effective model `claude-fable-5-1`, effort high. Tools: Read, Grep, and read-only Bash. No subagents, workflows, edits, commits, stashes, tests, services, or process signals. Prior Fable reviews were not inspected.
