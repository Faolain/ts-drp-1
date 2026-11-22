# Track T: the settlement profile for the shipped apps

**Outcome:** Merged in 2e272eb0 (ac17c698..dacb9870), Canvas only. Shipped Canvas signs creator-trusted-settlement-v1 with a version-3 ACL; its issuance is flat at 13 rows and every store is flat to 100 epochs. The Grid example and the v3-chat demo are pinned by existing tests and move in Track V. See [RESULT.md](RESULT.md).

**Working documents in this folder:** [BRIEF.md](BRIEF.md), [MAP.md](MAP.md), [RESULT.md](RESULT.md)

### Brief (plan given to the agent) (2026-10-20 21:51 UTC)

Your brief is in <evidence>/track-t/BRIEF.md. Read it in full before doing anything and follow it exactly. It holds the whole task (Track T: move the shipped Canvas, the Grid example and the v3-chat demo to the creator-trusted-settlement-v1 profile, prove storage and latency stay flat over 16+ epochs, and document that the legacy profile still grows), the order of work, the hard rules and the final report format.

Start with step 1, the map. If a RED, governance or contract test, frozen artifact, registry or vector pins an app's shipped profile, leave that app on the legacy profile and report it, as step 2 says. Keep <evidence>/track-t/PROGRESS.md current as you go, so the work can resume if you are interrupted.

### Report returned by the agent (2026-10-21 00:21 UTC)

#### Track T result

Track T is mostly done, with three things still open:
- Only Canvas moved to `creator-trusted-settlement-v1`. A RED test, and for v3-chat also the phase-6a contract, pin Grid and v3-chat to the legacy profile, so I left both on it as step 2 says.
- **Track P's test fails one check in (a), on the shipped profile.** The `next` count (`epoch 9: the author keeps issuing: expected 29 to be 28`) assumes MOVES rows per epoch, but settlement adds one author fence per successor. Every other (a) check passes, and (b) passes. I did not change the assertion; a one-line amendment is ready and needs your approval.
- Grid and v3-chat need your decision on amending the pins that hold them (Map, below).

Branch: `worktree-agent-ababeed392e2221c7` (base a3f3f6b0). Not pushed; the worktree is clean.

The full write-up is in the committed `RESULT.md`. Evidence is under `<evidence>/track-t/` (PROGRESS.md and MAP.md, plus the logs, latency, tests, bin and chromium folders and the patch file).
- RESULT.md: `<worktree agent-ababeed392e2221c7>/docs/realtime-latency/tracks/30-track-t-settlement-for-shipped-apps/RESULT.md`
- `<evidence>` = `<evidence>`

##### Commits
- `ac17c698` Canvas: sign creator-trusted-settlement-v1 into new rooms
- `b9dada54` Track P's Canvas long-room test follows the shipped profile
- `ea34d5a6` docs: the legacy creator-trusted-v1 profile keeps every issued row
- `dacb9870` docs: record the Track T result

##### Map
- **Canvas: switched.** No RED, governance or contract test, frozen artifact, registry or vector pins its profile.
- **Grid example: blocked.** `tests/phase-3-exit-genesis-roots-red.test.ts` (passes 9/9 at base) runs the real `createV3ZoneApi().create` and asserts:
  - profile `creator-trusted-v1` (`expectProductInput`, lines 271-278);
  - latched ACL version 1 (lines 624-640).
- **v3-chat: blocked.** The same RED test (lines 206-248) pins it, and so does the phase-6a contract:
  - `tests/fixtures/phase-6a-v3/creator-successor-product-contract.ts:721-775` (`isD108d2Authority`, `isD110cBSuccessorAuthority`);
  - `phase-6a-creator-successor-product.pw.ts:1097` and `2518-2560`;
  - the entry asset at lines 730-801;
  - `tests/phase-6a-creator-successor-product-red.test.ts:142-156`.
- **Recommendation:** these pins describe "the product's current profile", not a guarantee. If you confirm the decision for these apps, one reviewed amendment would change those literals to the settlement profile with ACL version 3. After that, each app is the same two-literal switch as Canvas.

##### Changes beyond the profile string
- **ACL version 1 to 3.** The protocol accepts the settlement profile only with a version-3 latched ACL (`latched-acl.ts:256`). Nothing else in the app changed.
- **New file `examples/canvas/src/profile.ts`** exports `CANVAS_GENESIS_PROFILE`, the single source of truth. The app, Track P's test and Track M's harness (`tests/fixtures/track-m-apps/long-room-core.ts` `openRole`) all import it.
- **Not needed:** the node type `V3RoomSuccessorAuthority.profileId` (no widening required), any resource bound, and any library code change.

##### Track P's test (`tests/canvas-long-room-issuance-retention-native.test.ts`)
- **What I changed:** only where the profile comes from (now `CANVAS_GENESIS_PROFILE`) and the comments. No assertion, bound or epoch count changed.
- **Legacy measurement:** opt-in with `CANVAS_LONG_ROOM_PROFILE=creator-trusted-v1`. It skips (a) and prints `CANVAS_LONG_ROOM_LEGACY` census lines without asserting growth.
- **(b) passes** for the creator and the Writer recipient through 16 successors and the reopen.
- **(a), offline check:** with the committed count, 18 of 136 checks fail, all of them `next`. With the count at MOVES+1, 136 of 136 pass.
- **(a), patched copy:** an untracked copy with only that count changed passes (a) and (b) in vitest (`logs/probe-amended-a-head-16.log`).
- **Proposed amendment (not applied):** `<evidence>/track-t/proposed-a-next-amendment.patch`. It expects `MOVES + FENCES_PER_SUCCESSOR`, with the fence count taken from `settlementProfileFor`.
- **Legacy census:** +2 rows per epoch on both peers (35 at the reopen). The creator's point reads grow +8 and rows visited +20 per epoch per move, matching Track P's numbers.

##### Where settlement retirement runs
- **Seal:** inline reconciliation advances the retirement decision to e-2 and changes no rows. This is because the shipped Canvas lull is `deferred:unsupported` (no resource bound).
- **Adoption:** the creator issues its fence, then `cleanupCreatorSettlementSuccessor` calls `pruneAuthenticatedSettledPrefix` (`v3-live.ts:21065` / `20258`), which deletes 3 rows per epoch.
- **Writer recipient:** Track N's drain runs in its lull, which reports `maintained`.
- **Cost:** about +280 ms per adoption in Chromium and +145-170 ms on Node, flat.

##### Storage per epoch
- **Canvas on SQLite:** both peers hold 13 issued rows (4×3+1) from epoch 6 through epoch 17 and the reopen. Bytes are 12,796-12,817 for the creator and 13,060-13,081 for the recipient. Per-move work is constant from transition 7 (creator 60 point reads : 6 page scans : 86 rows visited; recipient 4:2:30).
- **Canvas in Chromium:** every store's row count is flat from epoch 7 (171 rows for the creator, 150 for the recipient).
- **Legacy, for comparison:** grows by 4 rows and 1.65 kB per epoch across all stores.
- **Grid and v3-chat:** not switched, so no node-level check was added. examples/chat already uses settlement, and its stores are identical on base and HEAD.

##### 20-moves probe (30 epochs plus reopen, settlement)
- It ran 3,231 s; the first test hit its per-test timeout under load, but the run itself completed.
- No move was refused at any point, against epoch 17 on legacy.
- Both peers stayed flat at 85 rows (4×21+1) from epoch 6.
- Per-move work was constant: creator 276:10:862, recipient 4:2:210.
- Track N's 1,024-row bound still caps a Writer at about 100 moves per epoch; that is unchanged.

##### Latency per epoch (base vs HEAD)
- **Chromium Canvas** (ABBA, 20 epochs, load 42-69; medians and slopes over transitions 6-20):
  - HEAD slopes range from -22 to +12.5 ms per epoch.
  - Base grows: seal +60 and +69, creator issue +5.5 and +2.9, recipient lull +11 and +33 ms per epoch.
  - Adoption is 463 ms on HEAD against 185 on base, flat; install is about +30 ms.
  - A full transition costs a median 3.5 s on HEAD (slope -9.8). On base it is 3.0 s at transition 6 and grows +74 ms per epoch, so they cross around transitions 13-16.
- **Chromium Chat** (control, already on settlement): 0 store differences between trees. I make no latency claim from it.
- **Node** (Track M harness, ABBA w1 16 epochs and w2 24 epochs):
  - HEAD's w2 slopes are between -1.2 and +6.4 ms per epoch.
  - Adoption costs +145-170 ms, flat.
  - The deterministic per-move work counts above are the Node evidence of growth on legacy.
  - SQLite file plus WAL grows to about 4 MB per database and then plateaus, the same on both trees (WAL sizing, not rows).
- **Grid:** the bench signs its own settlement invite and cannot run the shipped Grid profile without editing it, so I did not run it.

##### 100-epoch endurance
- **Canvas in Chromium: passed.** Every store's row count is constant from epoch 8 to 100, and issued bytes grow only 46 B over 92 epochs. All slopes are within ±0.72 ms per epoch; seal's late-half slope is +2.0.
- **Chat:** stopped at epoch 58. Chat's own 32 KiB retained-state cap (`SHIPPING_CHAT_RETAINED_BYTES`) rejected new messages, which is by design and identical at base. Issuance stayed flat at 13 rows up to epoch 57.
- No 100-epoch Node run.

##### Legacy note added (comments only, commit `ea34d5a6`)
- JSDoc at `settlementProfileFor` (`packages/protocol-v3/src/index.ts`).
- JSDoc at `V3RoomCreatorInviteMaterialInput.exactCanonicalProfileBytes` (`packages/node/src/v3-room.ts`).
- The comment in `examples/canvas/src/profile.ts`.
- No README or spec documents profiles today, so I added none.

##### Suites, compared test by test against base
None of the five vitest sets nor the e2e run has a new failure at HEAD.

| Set | Base (passed / failed / skipped) | HEAD |
| --- | --- | --- |
| packages/node | 1023 / 48 / 0 | 1021 / 45 / 5 |
| storage-node (6 files) | 158 / 49 / 2 | identical |
| root (104 files) | 759 / 344 / 84 | 760 / 343 / 85 |
| observation | 23 / 0 | identical |
| native Canvas/Chat (6 files) | 35 / 15 | identical |
| Canvas/Chat e2e | 9/9 | 9/9 (on rerun) |

- **Node, 5 skipped at HEAD:** the `sync-state-heap-recharacterization-1o-f-ii` tests were skipped under load. Run alone they give base's exact results (3 failed, 2 passed).
- **Root, one test only at HEAD:** the skipped legacy census test.
- **Root, one test fixed at HEAD:** phase-4c 64 MiB, which failed at base on timing.
- **Root, Track P's (a):** its failure message changed as expected (base: oldest kept row; HEAD: `next`).
- **Root, envelope-purity entrypoints test:** it failed with a different error in the HEAD suite run (a ReferenceError from two concurrent imports). Run alone at HEAD it fails with base's exact message.
- All other message differences are PIDs and temp paths.
- **e2e:** the first HEAD run hit two `beforeEach` hook timeouts under load. Both passed alone, and a full rerun passed 9/9.

##### Typecheck and shadow check
- `pnpm -r typecheck`: 0 errors, 46 packages, exit 0.
- `node scripts/check-shadowed-sources.mjs`: exit 0.

##### What remains, and risks
1. Track P's (a) stays red on this branch until you approve the patch above.
2. Grid and v3-chat stay on legacy and keep growing until the pins are amended.
3. Existing Canvas rooms keep `creator-trusted-v1`; there is no migration (G25).
4. The creator's lull is `deferred:unsupported`, so reconciliation stays inline at seal (about 2.7 s in Chromium, flat). Track Q's resource bound would move it into the lull.
5. Adoption is a flat 150-280 ms slower per transition.
6. The cap of about 100 moves per Writer per epoch remains.
7. The RED fixture `tests/fixtures/startup-discovery/shipped.ts` `startupShippedCanvas` still builds a legacy invite labelled "shipped". It still passes, but the label is now stale; I did not edit it because it is a RED fixture.
8. Chat's 32 KiB cap ends a Chat room near epoch 57 at 4 messages per epoch, so any long-room Chat benchmark has to account for it.
9. Not run: Firefox, WebKit, a 100-epoch Node run, the Grid bench.
10. **Housekeeping:**
    - An early mistaken command started a full vitest run. I killed my process, but its worker processes were left running. The safety check would not let me inspect processes I did not start, so they may still be there.
    - An untracked `_apalache-out/` folder appeared during the suite runs; I moved it to `<evidence>/track-t/trash/`.

##### Files and functions touched
- `examples/canvas/src/profile.ts` (new): `CANVAS_GENESIS_PROFILE`.
- `examples/canvas/src/index.ts`: `creatorInvite`, plus one import.
- `tests/canvas-long-room-issuance-retention-native.test.ts`: `canvasLongRoomFixture`, comments, `LEGACY_MEASUREMENT`/`PROFILE`, a `beforeEach` guard, the legacy census test.
- `tests/fixtures/track-m-apps/long-room-core.ts`: `openRole`.
- `tests/track-m-canvas-long-room.test.ts`: header comment.
- `packages/protocol-v3/src/index.ts` and `packages/node/src/v3-room.ts`: JSDoc only.
- RESULT.md.

Parallel-track files were not touched (Track Q's `canvas.ts` and examples/chat, Track S's `creator-closed-rollback-data.ts`, Track M2's retention code). No reopen failed. Possible textual overlap: Track Q may edit `examples/canvas/src/index.ts` (different lines), and the `v3-room.ts` JSDoc sits in a shared file.
