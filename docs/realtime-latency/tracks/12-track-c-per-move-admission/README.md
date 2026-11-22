# Track C: amortize per-move admission cost

**Outcome:** HELD, not merged: its held snapshot admission view blocks snapshot writers, which conflicts with concurrent admission (Track F).

### Brief (plan given to the agent) (2026-10-19 14:16 UTC)

You are a fork of me. Everything up to commit 4c4f192c is committed; your worktree starts from it. Objective: real-time game moves. You own TRACK C, per-move latency. Today creator move p50 is ~92 ms, creator per-move admission ~40 ms (local and every received move), and remote accept p50 is ~70 ms.

Do, in priority order:
1. Amortize admission. Today every move builds a fresh capacity proof: native reads, 2 full checks, quote and charges. Investigate pre-reserving capacity credit for a batch of moves, sized at the maximum per-move charge. Do it once per epoch, or at idle time when the credit runs low, under the same proof and accounting. Each move then only debits the credit and does the minimal currency check its safety argument needs. Unused credit must be released or accounted at the epoch boundary.
   - Study the existing incremental/ordinary template machinery first (prepareCreatorIncrementalIssuanceMaintenanceQuote, ordinaryProofSource, ordinaryTemplateReady); it may already be most of the way there.
   - Soundness is mandatory: no move may be admitted beyond what the bounded storage and proof accounting allow, and refusals keep their reasons and precedence.
2. Apply the four levers the per-move agent left (scratchpad/agent-perop/DESIGN.md):
   - a snapshot-store version stamp, or holding that store's exclusion during admission, so each remaining ~5 ms snapshot re-read becomes one lookup;
   - preparing the 12–15 ms signing-dependency borrow once per epoch;
   - caching the 8–11 ms per-move AHE read across moves under a currency token;
   - anything else on the per-move path, including the received-append path in v3-live.ts:~7600-7660, but only in the admission call region.
3. Investigate the open item: creator adoption t6–t7 measured ~0.25 s higher after the per-move patch (the parallel source reads and the check coalescing in creator-closed-rollback-data.ts). Find the cause and fix it if it is real.

Scope:
- Yours: the admission code in creator-closed-rollback-data.ts, the maintenanceConsumer region of creator-close.ts (~3398-3560), and packages/storage-browser snapshot-store files if needed for a version stamp, plus tests.
- Other agents own the creator maintainRecoveryPool region, v3-live ingress queuing, recipient install, and retirement/maintenance CPU (the maintenance parts of creator-closed-rollback-data.ts). Keep your hunks in the admission regions.
- Do not touch packages/storage-browser/src/internal/native-read-reservation.ts.

Rules:
- Build dists first: canonical, storage, storage-browser and control-plane. Copy the gitignored benchmark .logs inputs if needed.
- Never use rm -rf. Commit only in your worktree branch; do not push.
- Name benchmark runs with a `pc-` prefix and use interleaved paired runs at 8 rollovers.
- Report creator issue, creator live admission, recipient issue and remote accept, each p50/p95, with the admission sub-phase breakdown before and after.
- Tests: affected node suites before and after (`--exclude ".claude/**"`), plus new tests for any credit and caching logic, including refusal precedence and exhaustion.

Deliverables in scratchpad/track-c/: DESIGN.md (soundness proof per cached or amortized fact), patch.diff (against 4c4f192c), the test comparison, and the numbers. Keep the final report concise.

### Follow-up instruction — Resume Track C after turn limit (2026-10-19 15:00 UTC)

Continue Track C from where you stopped (turn limit hit mid-edit: "Pass `held` explicitly so the decision is made once"). Be economical with turns: finish the in-progress change (snapshot version stamp / signing borrow / AHE cache — keep only what is sound and measurably helps), get the worktree typechecking (note packages/seal has the pre-existing seal-vote-intent.ts:663 build error — don't conflate), run the affected node + storage-browser tests against a baseline, and do one or two interleaved paired bench runs (pc- prefix) against your base1 build. Report on the adoption t6–t7 +0.25 s question if you got data. Then write scratchpad/track-c/REPORT.md (what changed, soundness argument, measured before/after, test delta) and finish with a concise final report. Do not commit; leave changes in the worktree.

### Report returned by the agent

### Track C final report (per-move latency)

Track C cut the creator's per-move admission p50 by about 10 ms (roughly 25%). The full transition times (seal, adoption, recipient install) did not change measurably. Nothing is committed; all changes are in worktree `agent-a07f036ff78ae1b7d` (base `4c4f192c`). The patch for tracked files is `<evidence>/track-c/patch.diff`. The new test file `packages/storage-browser/tests/snapshot-admission-hold.test.ts` is untracked and not in that patch. I could not write REPORT.md (subagents can't write report files), so the report is here.

#### What changed and why it is sound

**1. One joined check batch** (`packages/node/src/internal/creator-closed-rollback-data.ts`, `checkPoints`/`eligible`)
- **Change:** the separate "before" and "after" point checks are now one batch. All the read-only checks start together and are judged in the original order: owned, then eligibility, then images/floor, then journal, then issuer fallback.
- **Why it is sound:** every check only reads, so running them concurrently changes timing, not results.
  - No result is judged until every check in the batch has finished.
  - Revocation (release, abort, frame, source) is re-checked between judging groups, so a revocation during the batch still refuses before the issuer:full fallback.
  - Tests cover the refusal order and reasons.

**2. Held snapshot admission view**
- **Change:** a new `acquireRetirementAdmissionHold` in `packages/storage-browser/src/snapshot-transfer.ts`, used by the node code. One scheduled read captures the admission image, role inventory and owner status under the store's read reservation, which spans every snapshot store.
- **Why it is sound:**
  - While the view is held, no snapshot write from any connection can commit. So if `check()` still proves the same view, the captured values are current, and the full check no longer re-reads the image and inventory.
  - The returned values exactly match the separate reads, including key order (tested).
  - **Release:** at `begin`, right after the begin check and before `endReadPhase`. Also in `release()`/`endWrite`, and on failure. All source reads finish before anything can throw, so the hold is always assigned before cleanup runs.
  - **Fallback:** if the method is missing, or the reservation is busy, closed or fails in any way, the original separate reads are used and own every result.
  - **No deadlock:** the holder never waits on another scheduled operation of the snapshot store before releasing.

**3. Retry for readers refused at release** (`snapshot-transfer.ts`, `transact`)
- **Bug it fixes:** read-only reads from other callers on the same connection get routed into whatever view is held. Releasing a per-move hold rejected them with `NATIVE_READ_RESERVATION_RELEASED`. That is what broke recipient install in the first new run ("snapshot serving request was rejected").
- **Fix:** a refused reader now repeats in its own fresh read-only transaction, never in the view being released.
- **Why it is sound:** the refused read saw nothing. A holder proves its own reads with `reservation.check()`, which fails after release, so a plain read can never pass as a held one.
- **Confirmed:** all three bench runs with this fix passed.

**4. Keep the signing views on an exact verified-content hit** (`packages/seal/src/creator.ts`, `acquireSigningDependencies`)
- **Conditions:** there is no DATA consumer, the context is the same, and every captured row is byte-identical (same incarnation) to a previously verified row.
- **Change:** the first views stay held as final custody, which skips release, re-acquire and compare.
- **Why it is sound:**
  - Row, QC and quorum checks still run on the actual captured image. Only signature checks hit the existing verify-once cache, so preparation makes no verifier call and never waits.
  - The release/re-acquire round trip only existed because the views used to be released during preparation. Held, checked views prove custody directly.
  - Any mismatch takes the original full path. A revoked kept view refuses.

#### Measured before/after

Setup: interleaved runs in ABBA order (new2, base1, base1, new2), 8 rollovers, load about 21–24. Pooled figures add the earlier runs: 4 base runs and 3 new runs at load 24–58.

Per-move latency, p50 / p95 in ms:

| Metric | ABBA base | ABBA new | Pooled base | Pooled new |
|---|---|---|---|---|
| Creator issue | 89.7 / 176.5 | 82.9 / 126.1 | 98.2 / 161.7 | 84.7 / 132.5 |
| Creator issue: maintenance admission | 39.7 / 57.7 | 30.5 / 48.1 | 42.7 / 66.2 | 31.3 / 50.4 |
| Creator live: maintenance admission | 42.0 / 61.6 | 31.4 / 70.8 | 43.9 / 82.5 | 32.4 / 67.7 |
| Creator live admission + projection | 63.2 / 104.7 | 52.3 / 147.1 | 65.0 / 127.9 | 52.9 / 121.4 |
| Adoption: maintenance admission | 87.8 / 322 | 63.3 / 313 | 108.1 / 391 | 64.7 / 321 |
| Remote accept | 63.9 / 149 | 62.1 / 124.5 | 74.3 / 169 | 64.2 / 128 |
| Recipient issue (path untouched) | 42.1 / 66.7 | 42.5 / 66.0 | — | — |

The live admission + projection p95 got worse in the ABBA pair (104.7 → 147.1) but better in the pooled set.

Admission sub-phases, pooled p50 in ms:

| Sub-phase | Base | New |
|---|---|---|
| Capacity read (a-c1) | 6.75 | 2.4 |
| Capacity full check (cap-c3) | 6.6 | 2.2 |
| Whole check | 4.2 + 2.1 | 1.8 |
| Signing | 17.35 | 8.9 |
| Reserve capacity | 10.0 | 5.5 |
| Acquire proof | 33.05 | 26.2 |
| All reads joined | 17.55 | 15.2 |

- **AHE is now the floor.** The joined reads now equal the AHE read (15.2 ms: 12.55 bounded read plus 2.4 image). The serial bounded-read protocol (about 47 requests per move) is the next lever.
- **Snapshot read time rose, but off the critical path.** It went from 3.5 to 6.15 ms because one held capture replaces two parallel reads (image 3.5, inventory 6.1).

#### The adoption t6–t7 +0.25 s question

It is run-to-run noise, not a regression.
- With the same base build, the adoption change from t6 to t7 was −37, +11, +372 and +151 ms across the four runs. With the new build it was +10, −154 and +72 ms.
- At the transition level, seal and adoption ranges overlap between builds. Adoption t4–t7 was 686–1056 ms on base and 611–891 ms on new.
- The cheaper adoption admissions (about 24–40 ms each, 3 per transition) are under the noise floor. My earlier claim of a 0.15–0.3 s adoption drop came from high-load runs and did not hold at lower load.

#### Tests and typecheck

| Suite | Base | After | Notes |
|---|---|---|---|
| Node: `creator-*`, `closed-epoch-*`, `tests/phase-5e` | 871 tests, 43 failed | 875 tests, 43 failed | Same failing set; 4 new tests pass |
| storage-browser | 285 tests, 10 failed | 285 tests, 10 failed | Same 10 pre-existing failures; 5 new hold tests pass |

- **Node:** the 43 failures include 12 `phase-5e` RED tests that were already failing. One test file (`creator-ordinary-accepted-effect-index`) broke during the change; I fixed it and it passes 11/11.
- **storage-browser:** the raw-IndexedDB ownership audit still fails as before (1046 violations at base, 1045 after).
- **Typecheck:** `tsc -p tsconfig.build.json` is clean for storage-browser and node. Seal shows only the existing `seal-vote-intent.ts:663` error.

#### Not done

- **Cross-move capacity credit:** not sound without durable mutation stamps. That needs a stamp row bumped in every read-write transaction on the primary, snapshot and floor databases, plus a schema bump as a fence.
- **Parallel holds:** sound, but dropped for scope.
- **Pipelining the AHE bounded read:** this is now the critical path, and it sits in the loader where a sibling agent is working.
- **Native issuance census:** about 10 ms.
- **For the coordinator:** recipient install is now the largest transition cost. It grows with every rollover in both builds (about 1.1 s at t3 to 1.7–2.0 s at t7), which looks like a scan over retained history.

I left an instrumented build at `<evidence>/track-c/build-pc-new2`. The sources in the worktree have the instrumentation stripped. I deleted the temporary probe test. The untracked `.logs/bounded-storage-lifecycle/r8-warm-capacity-01/` directory is test-run output and not part of the change.
