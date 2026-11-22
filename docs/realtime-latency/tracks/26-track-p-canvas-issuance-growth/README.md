# Track P: Canvas issuance growth and O(outbox) issue cost

**Outcome:** Merged in a3f3f6b0 (8ed37d08..47a936fe). (b) fixed: each hot successor stacked one more issuance facade over its source, so per-move recovery work compounded with room age; a successor now wraps its source's native store, and per-move outbox page reads are constant (creator 10, recipient 2). (a) stopped for review as a spec gap: issuance without a settlement profile has no deleter, so Canvas still keeps every row. The user chose R-A (Track T). See [RESULT.md](RESULT.md).

**Working documents in this folder:** [RESULT.md](RESULT.md)

### Brief (plan given to the agent) (2026-10-20 16:11 UTC)

Track P: stop Canvas rooms slowing down and growing with room age. Repository: ts-drp, a TypeScript local-first CRDT meant to power real-time games. The user approved this track.

THE BUG (Track M's findings 12 and 13; present on every path, base included)
- Canvas uses the creator-trusted-v1 profile, which has no settlement profile, so nothing ever retires its issuance rows.
  - The creator's issuance outbox and issued records each gain one row per move: 33 rows at epoch 16, with 2 moves per epoch.
  - A Canvas Writer recipient's own outbox grows the same way.
  - Chat and the Grid have settlement profiles and stay flat. Track N fixed the Grid's Writer recipient.
- Latency grows with it.
  - In Track M's profile run (8 moves per epoch, high load), the creator's per-move issue time went from 829 ms at epoch 2 to 6,686 ms at epoch 16.
  - In Chromium, seal and lull times rise by 43–134 ms per epoch.
- Track M's diagnosis of the latency: `creatorFilteredIssuanceStore`'s `readOutboxPage` wrapper (packages/node/src/v3-live.ts) authenticates every retained historical outbox row before skipping it, so each issue is O(outbox).
- Guarantees at stake, from specs/bounded-storage-lifecycle/golden-path-guarantees.md:
  - G1: no growth with room age.
  - G19: issuance retention keeps only paired, published, epoch-bound rows; pending or malformed rows block with no writes.
  - G21: bounded work, with reviewed limits.
  - G27: no game-specific carve-outs; pruning must be census-proven.

READ FIRST
- Track M's RESULT.md §11 (Canvas and Chat) and §13, on Track M's branch (not merged). Read it with:
  `git show worktree-agent-a6747ca659c74d66c:docs/realtime-latency/tracks/23-track-m-verified-fact-retirement/RESULT.md`
- Track M's evidence: <evidence>/track-m/ (sub-cc/ holds the Canvas and Chat runs).
- Track M's measurement harness for Canvas and Chat is in commit da3704ac on that branch:
  - tests/fixtures/track-m-apps/;
  - tests/track-m-canvas-long-room.test.ts, tests/track-m-chat-long-room.test.ts, tests/track-m-apps-creator-issue-profile.test.ts.
  - You may cherry-pick it or adapt it. First check that it does not depend on Track M's unmerged product code (its retention host option). If it does, take only what runs on the default host and the room host without retention.
- Track N's fix and RESULT: docs/realtime-latency/tracks/24-track-n-recipient-issuance-growth/RESULT.md. It shows the same kind of leak on the Grid, its method, and its node-level long-room test (tests/recipient-long-room-issuance-retention-native.test.ts).
- specs/phase-6b-bounded-pruning/slices/01-issuance-retention.md: the issuance retention rules. Find out what they say about profiles without settlement.
- <evidence> = <evidence>

BASE
- codex/phase3a1b-p6-golden-path at 5c6b949d.
- Check `git log -1`. If it differs, run `git switch -C <your-branch> codex/phase3a1b-p6-golden-path`. (`git reset --hard` is blocked.)

ORDER OF WORK
1. Reproduce deterministically at node level, RED, committed first:
   - Canvas creator and Canvas Writer recipient issued and outbox row counts must stay constant from the first steady epoch through epoch 16.
   - Per-move issue work must not grow with room age. Assert a count of authenticated rows per issue, or similar; not wall time.
2. Root-cause both parts, with code citations:
   - (a) Why no rule retires Canvas issuance rows. Is there an existing owner rule for issued rows without settlement that never runs? Or is the rule missing from the spec?
   - (b) The O(outbox) issue cost: why the wrapper scans all retained history, and whether it can start from an authenticated position (the pruning watermark or a cursor) while still authenticating every row it returns or relies on.
3. Fix with the smallest change on the shared path that keeps every guarantee. Argue each one, as Track K's RESULT.md §3.2 does.
   - Fix (b) even if (a) needs a spec decision. Issue cost should not be O(history) in any case.
   - For (a): if the spec has no rule for retiring issuance without settlement, don't invent one. In particular, never treat unpublished or unacknowledged rows as retirable, and never add a Canvas-only carve-out (G27). Write the spec gap up with the candidate rules and their guarantee arguments, and stop that part for review.
   - If the right answer is an explicit reviewed bound, say so with reasoning; don't invent a limit (G21).
4. Evidence:
   - Node tests above GREEN (or, for (a), the documented stop).
   - Canvas per-move issue latency flat across 16 epochs. Use interleaved pairs against base, Chromium if the harness allows.
   - Chat and the Grid unchanged: Track N's test, Chat long room, and the six Canvas and Chat native tests:
     - tests/r9-canvas-receive-only-native.test.ts
     - tests/v3-canvas-equivalence.test.ts
     - tests/r9-chat-capacity-room-native.test.ts
     - tests/r9-chat-metadata-native.test.ts
     - tests/r9-chat-role-network-native.test.ts
     - tests/r9-chat-shipping-room-native.test.ts
   - One 8-rollover Grid run with LULL=1 (docs/realtime-latency/README.md recipe) to show no Grid regression.
5. Suites: compare per test against base (node; storage-node retirement; the root room tests including the K, L, R3 and N native tests). `pnpm -r typecheck` must report 0 errors.
6. Commit your RESULT.md into docs/realtime-latency/tracks/26-track-p-canvas-issuance-growth/, with local paths written as <evidence>/…. Keep <evidence>/track-p/PROGRESS.md current.

PARALLEL WORK
- Track Q gives the shipped Canvas and Chat creators an ordinary application resource bound so their lull runs. It may touch packages/node/src/applications/canvas.ts and the Chat example.
- Tracks O and M2 work on Track M's unmerged retention path; Track M2 covers issuance in its ledger.
- Keep your change local to issuance retention, classification and the filtered issuance store wrapper. List every file and function you touch.
- Don't edit docs/realtime-latency/README.md.
- Known pre-existing race (Track M's finding 5): a seal immediately after a received move can fail with NATIVE_READ_RESERVATION_BUSY on fake-indexeddb with a Writer recipient. Track M's fixtures wait 300 ms before each seal. Do the same, and record it if you hit it.

HARD RULES
- Never weaken G1–G28.
- Never edit existing RED or governance tests, frozen artifacts, registries or vectors to make something pass.
  - Some node tests evaluate original source text of v3-live.ts functions. If one breaks, keep your code outside that text rather than editing the test.
- If a fix cannot keep a guarantee, stop, record the counterexample and hand back.
- Run prettier on new files.
- Never run `tsc -p` without `--noEmit`. Guard: `node scripts/check-shadowed-sources.mjs`.
- A hook blocks `rm -rf`, `unlink`, `git checkout <ref> -- <path>` and `git reset --hard`. Move unwanted files into <evidence>/track-p/trash/. Never delete logs.
- Commit only on your own worktree branch. Never push. Never touch the main checkout, except to copy the untracked bench inputs .logs/bounded-storage-lifecycle/r8-warm-capacity-01/ into your worktree (never commit them).
- End every commit message with exactly: Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
- Grid bundle: `STARTUP_ENTRY=r8-source-binding pnpm exec tsx tests/fixtures/startup-discovery/build.ts <new-outdir>`. It reads canonical, storage, storage-browser and compaction from dist. Rebuild them; build protocol-v3 before compaction.
- Run vitest from the repository root with `--exclude ".claude/**" --no-coverage`.
- The machine is heavily loaded. Compare per test against base, and rerun timeouts alone. Make timing claims only from interleaved pairs. Never kill processes you did not start.

FINAL REPORT
- The commit list.
- Reproduction.
- Root cause of (a) and (b), with code citations.
- The fix, and why it is safe; or, for (a), the spec gap and candidate rules.
- The guarantee argument.
- Canvas per-epoch row counts and per-move issue latency, base against yours.
- Chat and Grid checks.
- Per-test suite diff against base; typecheck.
- What remains, and the risks.

### Follow-up instruction — Resume Track P after rate limit (2026-10-20 21:01 UTC)

You were cut off by an API rate limit. It has reset, so continue from where you stopped: you were implementing option B, reusing the existing `creatorOriginalIssuanceStore` relation through the hot handoff instead of a new registry. Check `git status` and your PROGRESS.md first. Nothing else has changed for you, except that the main branch is now c67c66b7, which differs from 5c6b949d only in a docs commit.

### Report returned by the agent (2026-10-20 21:26 UTC)

#### Track P: Canvas rooms slowing down and growing with room age

Part (b) is fixed: per-move work no longer compounds with room age. Part (a) is stopped for review, because the spec has no rule for retiring issuance in a profile without settlement. Until (a) is decided, Canvas rows still grow and issue cost is linear in them. No guarantee was weakened and no RED, governance or frozen test was edited.

- Worktree: <worktree agent-ae04c762f9072aea6>/
- Branch: track-p-canvas-issuance-growth (base 5c6b949d). Nothing pushed.
- Full write-up: <worktree agent-ae04c762f9072aea6>/docs/realtime-latency/tracks/26-track-p-canvas-issuance-growth/RESULT.md
- Progress log: <evidence>/track-p/PROGRESS.md

##### Commits
- 8ed37d08 test: a Canvas room's issuance must not grow or compound with room age (RED)
- 28e34f80 fix: a successor filters its source's original issuance store, not its facade
- 47a936fe docs: record the Track P result

All three end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. An earlier version of the fix (c42db91e) was replaced by amending; it is not on the branch.

##### Reproduction
New test: tests/canvas-long-room-issuance-retention-native.test.ts.
- Shipped Canvas (creator-trusted-v1) on the Node SQLite host: a creator and one Writer recipient, 2 moves each per epoch, the shipped seal/adopt/install/lull order, 16 epochs, then a persisted reopen and one more epoch.
- A `StatementSync` observer counts the SQL work of each move: point reads, outbox page scans and rows visited.
- Two assertions in one run:
  - **(b):** from epoch 8, a move's outbox page reads never exceed epoch 8's.
  - **(a):** from epoch 8, row counts are constant, nothing is pending, no kept row is older than 8 epochs, and per-move work is flat.
- Both fail at base:
  - Each peer holds 3, 5, … 33 rows at epoch 16, then 35 after the reopen. The pruning watermark is null and the oldest kept row is from epoch 0.
  - Creator per move (point reads : page scans : rows visited): 87:54:940 at epoch 8 and 157:103:3236 at epoch 15.
  - Recipient per move: 21:22:396 at epoch 8 and 35:43:1376 at epoch 15.
  - After the reopen, the owners hold more rows yet do only 134:10:332 (creator) and 4:2:68 (recipient). Room age, not row count, drove the compounding.

##### Root cause (b): each hot successor stacked one more facade
Track M pointed at the `readOutboxPage` wrapper of `creatorFilteredIssuanceStore`. It does authenticate every retained row it skips, but one pass is only O(rows). The growth with age came from stacking:
- **Where the stores come from:**
  - The adoption and install material carries the live registration's store (v3-live.ts:19732; creator-adoption.ts:1251 and 2295).
  - A hot handoff requires that store to be the registration's own (v3-live.ts:7249).
  - For a profile without settlement, that store is a filtered facade from epoch 2 on.
- **How the stack builds:** `activateCreatorSuccessorLive` (20584) wrapped that store again, in both successor facades (20793-20818), the predecessor recovery facade, the historical owner and the displaced source. So at epoch s, one read went through s-1 facades.
- **Why it cost O(epoch × rows):** each facade re-pages the store beneath it. Each native page call also validates the whole table (node-issuance-store.ts:1518-1526; browser-issuance-store.ts:1383).
- **Side effect 1:** the publication cursor carry (20186-20198) never applied to Canvas from epoch 3. Its same-original-store check saw the previous facade instead of the native store.
- **Side effect 2:** a chain of facades and contexts, one per epoch, stayed reachable in hot state.
- **Why a watermark or cursor start doesn't help:** the census pages from null and relies on every row (10025, 10149, 10210-10214). Native reads are O(table) whatever their start. Exact-bytes memoization already exists (`vertexFacts`, 8559-8596). So per-issue cost stays O(retained rows) by design, and only (a) can bound it.

##### Fix (b) and why it is safe
The change is only in `activateCreatorSuccessorLive`: 7 lines added, 5 changed, no new state.
- A new local `nativeIssuanceStore = transportHandoff === undefined ? material.issuanceStore : creatorOriginalIssuanceStore(transportHandoff)` (20654-20660). For a genuine live handoff, it is the store beneath the source's own facade, taken from its own historical context (8432-8441; 12494-12499; 12650).
- It is used at 20682, 20698, 20782, 20799 and 20810.
- Unchanged: the raw branches, the two branch-selection checks (20789-20792 and 20822-20828), and the handoff identity check. Branch selection is therefore the same as at base.
- By induction over the hot chain, the store is the native owner. The result is exactly what a persisted reopen builds.

Equivalence with base:
- Aggregate coverage is monotone, so the outer facade hides every row the inner facades hid.
- The only rows that can now show are pending epoch-0 rows of a native branch, and a reopened owner already shows those. No run had a pending row.
- The local-settlement pairings (8829, 8860, 10951) still compare equal exactly when they did.
- The cursor carry now applies to Canvas as its precondition intends. It is existing reviewed code that already ran for Grid and Chat at every epoch.

Guarantees (argued in RESULT §3.3):
- **G1:** per-move work no longer depends on room age, and the per-epoch chain is gone. Storage growth remains; that is (a).
- **G5, G10, G11:** what is reused is an object identity, not a verdict. Every row is still re-read and re-authenticated on every pass.
- **G19:** the facade code is unchanged and nothing is deleted.
- **G3, G7, G9, G15, G17, G18, G21, G26, G27, G28:** no deleter, limit or check changed. The change never branches on profile or application.

Why the earlier version was replaced: it added a module-level `WeakMap` registry. tests/phase-3a1-ac-live-persistence-red.test.ts counts those (18 at base, a RED test) and treats an added one as a mutant; the registry made it 19. The final change gives an identical census and per-move work.

##### Root cause (a): spec gap, stopped for review
- **Classification does run.** From epoch 4-5, the completed decision covers through epoch e-2 and protects 6 holes per author (creator-closed-rollback-data.ts:19066).
- **Every deleter on the path needs settlement:**
  - `cleanupCreatorSettlementSuccessor` finds no frontier for creator-trusted-v1 (20227). When a coordinated decision exists it returns at once (20411-20412); otherwise it does AHE-only cleanup.
  - `pruneAuthenticatedSettledPrefix` requires `settlementPlanPermitsAuthenticatedPruning` (retirement.ts:1783-1804).
  - D.109b `prunePublishedPrefix` covers a single epoch and has no production caller (its slice, 6B01:297, "does not modify node runtime wiring").
  - D.109d reclamation runs only for the "v1" settlement profile (5635).
- **The spec has no rule.** Its boundary is "settlement-derived" (specs/bounded-storage-lifecycle/README.md:186), and its storage bound has no term for issuance that is never settled (BSL:259). This is a missing rule, not a rule that fails to run, so I invented none.
- **Candidate rules:**
  - **R-A:** move Canvas to a settlement profile. A product decision that needs a G25 migration.
  - **R-B (recommended):** a new reviewed native mode that deletes a published, paired prefix bounded by the completed coordinated decision's `throughEpoch`. It would be read natively in the same transaction, stay outside the holes, require that no plan entry references the range, and be wired only in the no-frontier coordinated branch. It needs a spec slice and G28 evidence.
  - **R-C:** treat a null plan as complete. Rejected: absence is not authority, and that path allows pending rows.
  - **R-D:** an explicit bound only. It turns growth into refusal, which existing bounds already do.
- **What the open gap costs.** A probe at 20 moves per epoch was refused in epoch 17, with 341 rows (330,433 bytes) held: "creator issuance maintenance proof reserve is exhausted" (creator-close.ts:2877/2887, the G22 proof reserve). That comes before the 1,024-row owner bound. The probe was not run at base.
- The test's (a) assertion stays RED on purpose, as the acceptance test for whichever rule is chosen.

##### Canvas rows and per-move issue latency, base against HEAD
**Rows:** identical on both trees at every epoch (node census, and every Chromium store, row and byte). They still grow by 2 per epoch at 2 moves and by 8 per epoch at 8 moves.

**Node per-move work at HEAD:**

| issued in epoch | creator | recipient | rows held |
|---|---|---|---|
| 3 | 30:10:72 | 4:2:16 | 7 |
| 8 | 70:10:172 | 4:2:36 | 17 |
| 15 | 126:10:312 | 4:2:64 | 31 |
| 16, reopened | 134:10:332 | 4:2:68 | 33 |

Page scans are constant (10 for the creator, 2 for the recipient), and hot owners now match reopened ones.

**Chromium latency:** room host, Writer recipient, shipped lull, 8 moves per epoch, interleaved base / HEAD / HEAD / base with the final bundle. Slopes are over epochs 6-16.

| metric | base, run 1 | HEAD, run 2 | HEAD, run 3 | base, run 4 |
|---|---|---|---|---|
| creator issue per move | +16.4 ms/epoch | +0.7 | +5.3 | +16.3 |
| recipient issue | +14.7 | +1.5 | +2.3 | +14.2 |
| seal | +732 | +46 | +183 | +767 |

- At epoch 16, the mean creator issue is 345 ms at base against 213 ms at HEAD; seal is 11,245 ms against 4,422 ms.
- Two earlier interleaved sets from the replaced version agree: one at 8 moves and one at 2 moves.
- Issue latency is close to flat. Seal still grows with the retained rows; I infer that only (a) ends it, but did not profile it.

##### Chat and Grid checks
- **Chat long room** (node host, Writer recipient, 16 epochs): flat at 13/13 rows from epoch 6. Rows, bytes and lull kinds are identical to base. No latency claim: one pair only, not interleaved.
- **Six native tests:** 35 pass / 15 fail on both trees, identical per test and matching Track M's table.
- **Other native tests:** Track N's test passes at HEAD, as do K (journal retention), L (lull reopen close), R3 (room-database-retirement) and r9-grid-outcome-transfer.
- **Grid, 8 rollovers with LULL=1:** passes, `proofEventsTruncated` false.
  - Recipients hold 13/13 rows from adopted-5 and the creator 13/13 from adopted-6; the reopen and continued gameplay pass.
  - This matches Track N's table checkpoint for checkpoint.

##### Per-test suite diff against base

| set | base (pass/fail/skip) | HEAD | new failures |
|---|---|---|---|
| quick | 370/24/0 | 370/24/0 | 0 |
| node | 1021/45/5 | 1023/48/0 | 0 |
| storage-node retirement | 158/49/2 | 158/49/2 | 0 |
| six native tests | 35/15/0 | 35/15/0 | 0 |
| root | 672/354/24 | 674/352/24 | 0 |
| observer | 23/0/0 | 23/0/0 | 0 |

- **node:** at base, the 5 heap tests were skipped because a `pnpm` build timed out. Rerun alone at base, they match HEAD.
- **root:** the two "fixed" tests are my (b) test and a phase-4c test that timed out under load at base; rerun alone, phase-4c passes at base too.
- **Reruns:** the 16 files that timed out on either tree were rerun on both. Both trees give 173 tests, 103 passing and 70 failing, with 0 differences in status or first failure line. The remaining timeouts are the same deterministic ones on both trees.
- **Typecheck:** `pnpm -r typecheck` exits 0 with 0 errors (46 of 47 projects). `node scripts/check-shadowed-sources.mjs` exits 0.

##### What remains, and risks
1. (a) needs a spec decision (R-B recommended). Until then Canvas rows grow, issue cost is linear in them, and seal latency still grows.
2. The cursor carry now covers Canvas from epoch 3. If a reviewer finds it unsound under G10, the change applies to every profile, not just Canvas.
3. A non-hot activation over a facade still nests by one level: the gap is bounded per activation and cleared by a reopen. No run produced one.
4. Coverage: node assertions run on SQLite, and the Chromium runs are measurements, not assertions. Firefox and WebKit were not run.
5. Track Q (Canvas resource bound) should rerun this test after merging; (b) must stay GREEN. Tracks O and M2 could conflict textually only around the store selection in `activateCreatorSuccessorLive`.

##### Files touched
- packages/node/src/v3-live.ts: `activateCreatorSuccessorLive` only.
- tests/canvas-long-room-issuance-retention-native.test.ts (new).
- docs/realtime-latency/tracks/26-track-p-canvas-issuance-growth/RESULT.md (new).

Nothing else was edited: classification, planners, native owners, limits, `cleanupCreatorSettlementSuccessor`, `creatorFilteredIssuanceStore`, canvas.ts, the Chat example and docs/realtime-latency/README.md are untouched.

Uncommitted measurement inputs:
- Track M's harness (from da3704ac; it uses no unmerged retention code) and my probe test are moved to <evidence>/track-p/trash/
- The Grid bench inputs in .logs/bounded-storage-lifecycle/r8-warm-capacity-01/ stay untracked in the worktree.

NATIVE_READ_RESERVATION_BUSY (Track M finding 5) was not hit in any of my runs; I waited 300 ms before each seal.
