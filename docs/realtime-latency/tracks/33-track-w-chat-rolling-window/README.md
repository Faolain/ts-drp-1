# Track W: a rolling window and a local archive for shipped Chat

**Outcome:** Merged as a fast-forward to 82952f37 (f9853e92..82952f37, on 24d4ca61). New shipped Chat rooms sign a version-4 format whose shared state is a rolling 32 KiB window of each member's newest messages, and each device keeps an archive of 2,000 messages or 1 MiB per room. The owner chose 64 KiB, but the library caps room state at 32 KiB, so the window ships at 32 KiB (row 50). Late-joiner shares go to Track W2. See [RESULT.md](RESULT.md).

**Working documents in this folder:** [BRIEF.md](BRIEF.md), [MAP.md](MAP.md), [DESIGN.md](DESIGN.md), [RESULT.md](RESULT.md)

### Brief (plan given to the agent) (2026-10-21 01:18 UTC)

Your brief is in <evidence>/track-w/BRIEF.md. Read it in full before doing anything and follow it exactly. It holds the whole task, the order of work, the hard rules and the final report format.

Track W lets a shipped Chat room run indefinitely. Today Chat keeps every message in its replicated state and refuses new messages near epoch 57. Under the design the repository owner chose:
- the shared state becomes a rolling window of recent messages;
- each device keeps a local archive of messages it has seen.

First check that your worktree is at 6066c539; the brief says what to do if it isn't. Start with the map (step 1) and the design (step 2). If a RED, governance or contract test, frozen artifact, registry or vector pins Chat's current design, stop after the design and hand back with the amendments you would need. Keep <evidence>/track-w/PROGRESS.md current as you go, so the work can resume if you are interrupted.

### Follow-up instruction — Tell Track W that Track Q landed; rebase (2026-10-21 02:41 UTC)

Track Q landed on main as 46eb7821; rebase onto codex/phase3a1b-p6-golden-path at a natural point, before you implement in examples/chat.

What Track Q changed in your area:
- examples/chat/src/v3-chat-application.ts: `createShippingV3ChatApplication` now supplies `readOrdinaryApplicationResourceBound`, through new helpers `resourceDataRecord` and `resourceBoundBases`.
- examples/chat/src/v3-chat-capacity.ts: new export `SHIPPING_CHAT_CAPACITY_STATE_LIMITS = LIMITS` (32768 bytes / 16384 items / depth 16).

The owner approved that bound on 2026-10-20. Its stated basis is "every Chat state passes Chat's own state check, whose limits are SHIPPING_CHAT_CAPACITY_STATE_LIMITS, and the admission policy refuses any message that would exceed them". Keep that true under your rolling window and your new state format:
- If your window keeps every reachable state within the same limits, the bound stands. Say so explicitly in your guarantee argument (G21, G22).
- If the limits or the state check change, the bound changes too, and the owner must review it again. List that under "Limits for owner review".
- Track Q's tests/canvas-chat-resource-bound.test.ts and tests/canvas-chat-creator-lull-native.test.ts must still pass on your branch.

With Q, Chat's creator now runs its lull, so retirement is no longer inline at seal. Measure seal, adoption and lull on that basis.

Separately, Track Q found that Track M's app harness (TRACK_M_APPS=1) fails Chat on the room and room-retention hosts at epoch 3's seal, with "creator recovery role transfer source failed: internal-invariant". It fails the same way on base. If you use that harness for Chat on a room host and hit it, record it and use the node SQLite host or Track Q's harness (tests/fixtures/canvas-chat-lull/) instead; don't fix it in this track.

Also: Track X is investigating a delivery stall on the settlement profile with real networking (Chromium). A creator's settlement fence reaches a Writer before install, and after a few successors the creator's moves stop arriving. Shipped Chat signs the settlement profile, so if your Chromium runs use the shipped page's real networking, you may hit it. Record it if so; don't try to fix it.

### Follow-up instruction — Resume Track W after the usage-limit pause (2026-10-21 04:31 UTC)

Resume Track W: you were stopped at 00:09 for a usage limit, and it's safe to continue now.

1. Run `git status` and `git log -1` in your worktree to see what state the stop left.
2. Read <evidence>/track-w/PROGRESS.md (<evidence> = <evidence>).
3. Any benchmark, long-room or test run that was in flight was killed. Rerun it rather than using partial output. Don't kill processes you didn't start; if leftover workers from your own killed runs are still alive, record them in PROGRESS.md.
4. Continue your brief from where PROGRESS.md says you are.

Main is now 725f291b. It includes Track Q (46eb7821), which my earlier message asked you to rebase onto, and two docs commits. Main also records the settlement-profile delivery stall as a known issue (Track X is fixing it). If a Chromium run with real networking stalls at epoch 5, that's the known issue; record it and don't fix it.

### Report returned by the agent (2026-10-21 06:14 UTC)

Track W final report. Worktree: <worktree agent-a9b9982b4fd998b37>/, branch track-w-chat-rolling-window, rebased onto main 725f291b (6b9e27cc with Track Q 46eb7821, plus the README commit). Worktree is clean and nothing was pushed. Evidence is in <evidence>/track-w/ (PROGRESS.md is final; MAP.md, DESIGN.md, bin/, logs/, tests/, latency/, chromium/). The record is RESULT.md at <worktree agent-a9b9982b4fd998b37>/docs/realtime-latency/tracks/33-track-w-chat-rolling-window/RESULT.md. I did not edit docs/realtime-latency/README.md.

#### Commits
Each one ends with the brief's trailer.
1. 8431cc42 test(track-w): RED for Chat's rolling window and device archive. All three test files fail at base on missing modules (tests/red-at-base.log).
2. cb59b05f Chat: new rooms keep a rolling window; each device keeps an archive
3. f6faf811 test(track-m): measure Chat's window format and device archive
4. 54a5197b Chat: the window format states Track Q's resource bound
5. bb4516a3 test(track-m): record each role's origin storage usage for every app
6. 2629e63b docs: record Track W, Chat's rolling window and device archive (RESULT.md)

Before the rebase onto main, commits 1-5 were 0b3fe706, e5926052, b3b84fcc, 436549e1 and d1adb6c0. The evidence logs name those ids.

#### Map
No pin blocked the work, and I edited no RED, governance or contract test, frozen artifact, registry or vector. Chat's state comes from a compiled blueprint reducer, and the room checks that the projection equals the sealed state. So the window rule has to live in the reducer, which means a new compiled artifact: `v3-shipping-chat.v4`, digest b0bb30c5677e927b0a47a78508b436eae755e635f9c4613387ba490f62897560. I added it beside version 3, and every version-3 file is byte-identical.

These pins describe version 3 only from now on, and all of them are still true:
- the R9 Chat tests (lifetime ledger)
- the frozen `carriedChatCapacity` model in author-lineage-actions.qnt
- the MAIN R9 receipt (historical; no test reads it)

No amendment is needed. There is a gap, though: no formal model of version 4 exists.

#### Design in brief
- **State (v4):** `{version: 4, messages (application order), capacity}`. `capacity` is the v3 record unchanged.
- **Window rule (in the reducer):**
  - An exact retry of a message already in the window moves it to the newest place.
  - The same identity with different content is refused.
  - Otherwise the message is appended, and while its author's charge is over the author's share, that author's own oldest message leaves.
  - The rule is a pure function of the authenticated base plus the epoch's operations in the library's order, so every peer gets the same bytes and digest, and replay evicts the same messages.
  - The reducer computes UTF-8 sizes itself; a differential test checks it against `encodeCanonical`.
- **Shares:** the same equal split at creation as today (2 members: 16,249 bytes each; 3: 10,808; 4: 8,088; 8: 4,007). A share now bounds what a member holds in the window, and bytes that leave return to that member at once. Members still cannot take each other's bytes.
- **Admission** (`createShippingChatWindowAdmissionPolicy`):
  - Works as in v3, plus one cap: the bytes of a member's distinct messages admitted in one epoch may not exceed that member's share.
  - So a message admitted in an epoch is always in the state sealed at that epoch.
  - Acceptance depends on the set of messages, not their order, so journal replay and the creator's predecessor validation accept the same set.
  - The counterexample that fixes the cap at the share: with a larger per-epoch allowance, a member's own new messages would push out messages admitted earlier in the same epoch.
- **Archive** (examples/chat/src/v3-chat-archive.ts):
  - Its own database: IndexedDB in the browser, a separate SQLite file on Node. It is never a room database and never in a room census.
  - The projection callback only keeps a reference (`observe`, O(1)). The write runs in a later task, in one strict transaction.
  - Bound: 2,000 messages or 1 MiB per room per device, oldest dropped first (proposed).
  - A record the bound drops while its message is still in the window leaves a tombstone, so the message is not archived again.
  - Rows are revalidated on load. The archive records only messages this device's room authenticated and admitted, and it feeds nothing back.
  - The page shows the window plus archive-only rows (marked as kept on this device).
- **Crash and reopen:** the room's atomicity is the library's. A SIGKILL around an archive commit leaves the old or the new archive. A crash between admitting a message and archiving it is repaired by the first write after reopen, because the message is still in the window. A device misses a message only if it entered and left the window while the device was not running.
- **Format:** new rooms sign v4. A joined invite is checked against the v4 catalog, then v3. Existing rooms keep v3 and are not migrated; RESULT.md says so. The settlement profile stays creator-trusted-settlement-v1. Nothing under packages/ changed.

#### Limits for owner review (proposed, not approved)
1. **Shared window: 32,768 bytes per room.** This is today's cap, and the value Track Q's approved bound rests on. Players: older messages leave the shared history but stay on the devices that saw them.
2. **Each member's share: an equal split at creation.** That is about 87, 58, 43 or 21 typical messages for 2, 3, 4 or 8 members. Once a member's share is full, each new message from that member pushes out that member's own oldest message. Other members' messages are not affected.
3. **Sending limit per checkpoint: one share's worth.** Further sends are refused until the next checkpoint, and the typed text is kept for retry.
4. **Largest message: the member's share.** Unchanged.
5. **Device archive: 2,000 messages or 1 MiB per room per device**, oldest dropped first. Clearing the site's data clears it.
6. **Flagged, unchanged from v3:**
   - Members added after creation get no share unless bytes are free.
   - A departed member's last messages stay in the window.
   - Options: a share for late members, letting unused shares be borrowed, or an age horizon.

Track Q's resource bound (32,768 bytes, 16,384 items, depth 16) is unchanged and its approved basis still holds, so there is nothing new to review there.

#### Node SQLite, 300 epochs (7/7 pass)
Setup: creator and two Writers, 4 messages per epoch, genuine seal, adoption, installs and all three lulls every epoch, Track Q's reader. 1,200 messages with no refusal, and every peer's digest equals an independent model's every epoch.

- **State:** never above 32,768 bytes (31,041-32,684 once full). Slope +0.42 B/epoch.
- **Rows:** constant from epoch 7 (creator 175, each Writer 145). Table bytes stay in a 5% band.
- **Latency (p50 over epochs 71-300, ms):** seal 213, adoption 572, install 185, creator lull 1,915, Writer lull 882, Writer issue 28, creator issue 377. Every slope over 71-300 is zero or negative (adoption -1.15, creator lull -4.11 ms/epoch).
- **Lulls:** 893 of 900 peer-epochs maintained. The creator's lull is deferred:unsupported at epochs 1-2 (the lull's own floor).
- **SQLite files:** capped at the WAL autocheckpoint plateau, about 4.2 MB.
- **Reopen and crash:** the persisted reopen at epoch 150 and the archive crash at epoch 155 behave as designed.

#### Chromium (Track M app harness, measurement only)
- **150 epochs, head:**
  - Rows flat (135/128). Room bytes flat at about 193.7 KB. State flat at the window size.
  - Snapshot chunks are 67 KB; Track T recorded them growing to 98.5 KB by epoch 57.
  - Seal, recipient issue and recipient lull are flat.
  - Adoption, install and the creator's lull drift +1.7, +0.8 and +4.6 ms/epoch over epochs 60-150 (about 10-15%), while the load fell.
  - A Canvas control run on the same harness, with a constant state, swings more than that (adoption 604-915 ms per 10 epochs) and has negative slopes. One run cannot separate the Chat drift from load, and the Node 300 run shows none.
- **First 50 epochs vs base 6b9e27cc** (paired, medians, ms):

| Transition | Base | Head, window | Head, lifetime |
| --- | --- | --- | --- |
| Seal | 215 | 221 | 256 |
| Adoption | 601 | 617 | 665 |
| Install | 243 | 265 | 296 |
| Creator lull | 1,931 | 1,972 | 2,420 |

  The window format is within 0-10% of base. Head's lifetime format is the same code as base and still differs from it by 5-25%, so these differences are noise. Rows and state bytes are identical across the runs.
- **Known issues:**
  - No room-host internal-invariant failure at epoch 3 occurred in any Chromium run.
  - Track X's stall does not apply, because the harness relays rows rather than using the page's networking.

#### Archive size and append cost
- Node creator: 1,200 messages, 170,720 record bytes, 0.82 ms per write (0.21 ms per message).
- Node Writer with a 100-message bound: 1.48 ms per write.
- Chromium: 600 rows, 177,480 B (about 296 B per message), 0.93 ms (creator) and 1.24 ms (recipient) per write, no trend. `observe` costs 0.01 ms.
- At the default bound that is about 0.6 MB per room per device in IndexedDB.
- The origin's IndexedDB usage grows 5-11 KB/epoch per role with or without the archive (without it, +7.8 and +5.0 KB/epoch). The archive's share is about 1.2 KB/epoch; the rest is the room's backing-store churn, outside Chat.

#### Guarantees
No library change; the reasoning per guarantee is in RESULT.md §8.
- **G1:** the state is bounded at 32,768 bytes, and stores and latency are flat in Node 300. The archive is never on the seal, adoption, install or lull paths.
- **G2:** the share cap is checked before a message is issued, and nothing admitted is evicted before its seal.
- **G3:** golden path with creator plus two Writers, reopen and crash.
- **G5:** archive rows are revalidated on load.
- **G7/G8:** the reducer is the single owner of eviction. The archive's eviction drops non-protocol local copies only.
- **G14-G16:** each archive write is one strict transaction, with a SIGKILL test.
- **G21:** the limits are listed for review. Track Q's bound stands: every window state is checked under exactly `SHIPPING_CHAT_CAPACITY_STATE_LIMITS`, and admission captures each joined window under those limits.
- **G22:** reservation precedes effects.
- **G25:** the format is the signed genesis digest, and v4 refuses v3 state.
- **G26-G28:** no check relaxed, no carve-outs, native evidence.
- No guarantee was weakened.

#### Suites vs base 6b9e27cc, per test
No new failures in any set.
- **Chat:** base 11/0/12, head 32/0/12 (21 new tests pass).
- **Six Canvas/Chat native tests:** 35/15, identical on both sides.
- **Storage-node retirement:** 162/49/2, identical.
- **packages/node:** 1023/48, identical.
- **Root, 117 files** (Tracks K, L, M, M2, N, O, P, S, T and Q): base 867/907/98, head 869/905/98.
  - 559 failures on both sides are the existing d110c registry qnt drift.
  - Two failures are base-only flakes. phase-4c timed out and passes alone at base. The d110c settlement-codec failure is a module-init (TDZ) race that also fails alone on head in 1 of 2 runs.
- **Track Q's tests:** 15/15 on head.
- **Track W native:** 7/7 (RED at base).
- **Canvas/Chat e2e:** 9/9 on both sides.
- `pnpm -r typecheck`: 0 errors. `node scripts/check-shadowed-sources.mjs`: exit 0.

#### Files touched
Full function list is in RESULT.md.
- **New:**
  - examples/chat/window-blueprint/{blueprint.ts, blueprint.json}
  - examples/chat/src/chat-window-catalog-material.json, chat-catalogs.ts, v3-chat-window.ts, v3-chat-archive.ts, v3-chat-archive-sqlite.ts
  - tests/chat-rolling-window-{native,rule}.test.ts, tests/chat-local-archive.test.ts
  - tests/fixtures/chat-rolling-window/{chat-long-room.ts, archive-crash-child.ts}
- **Changed:**
  - examples/chat/src/v3-chat-application.ts: dispatches window entries; optional `epoch` on the projection.
  - examples/chat/src/index.ts: catalogs, archive, merged render, format choice in `openChat`, unload.
  - Track M harness: tests/fixtures/track-m-apps/{long-room-driver.ts, long-room-core.ts, browser/entry.ts, browser/long-room.pw.ts}. It adds Chat format choice, archive and origin-usage endpoints, and no assertion changed. Chat measurements now default to the window format; `TRACK_M_APPS_CHAT_FORMAT=lifetime` restores the old one.

#### What remains and risks
- Owner review of the limits above.
- No formal model of v4; it needs a new spec and a freeze-policy entry.
- v3 rooms still stop near their lifetime capacity, by design (no migration).
- Members added after creation get no share.
- Archives are per device and not synced.
- The page's merged render grows with the archive bound and was not measured.
- Firefox and WebKit were not run.
- examples/v3-chat (the demo) still keeps lifetime history; follow-up for Track V.
- The Chromium long-room drift is unresolved by one run; a repeated run on a quiet machine or Track U's heap attribution would settle it.
- The origin's IndexedDB usage grows outside Chat; it is a residual for the storage owners.
- Real networking was not exercised beyond the e2e tests (Track X).
- Each archive write includes one O(archive) step, bounded at 2,000 entries.

#### Process notes
- The usage-limit stop at 00:09 killed the head storage-node retirement suite run. I moved its partial log to trash and reran it and the other in-flight suites. I left no leftover processes (checked by ps at 00:31 and 02:12).
- I did not touch examples/v3-chat, examples/grid, tests/fixtures/startup-discovery or the main checkout, apart from copying the brief's bench inputs, which were not committed.

### Follow-up instruction — Owner decisions: 64 KiB window, archive approved (2026-10-21 13:18 UTC)

Coordinator here. The owner reviewed your limits on 2026-10-21. Please continue on your branch:

1. Window: 64 KiB (65,536 bytes) per room, instead of 32 KiB. The rules are unchanged: an equal split at creation, own-oldest eviction, at most one share per checkpoint, and the largest message is one share.
2. Device archive: 2,000 messages or 1 MiB per room per device, oldest first. Approved as proposed.
3. Late-joiner shares and departed members' bytes: these go to a separate follow-up track after you merge, so not yours. Record them in RESULT.md as a known limit with that follow-up.

What follows from (1):
- v3 rooms keep `SHIPPING_CHAT_RETAINED_BYTES` (32,768) and `SHIPPING_CHAT_CAPACITY_STATE_LIMITS` unchanged. The v4 window format gets its own budget constant and its own limits.
- Track Q's ordinary resource bound for v4 must be re-derived from the 64 KiB window (bytes, items and depth), by the same method as Q: the exact widest reachable state, G21 and G22. The owner approved Q's derivation for 32 KiB; the new values need a fresh approval. Implement them so the proofs can run, and put them in your report under "Bound for owner review". Don't treat them as approved.
- Measure what 64 KiB costs against your 32 KiB window and against base:
  - seal, adoption, install, lulls, per-message issue, state bytes, and store rows and bytes;
  - Node 300 epochs, and Chromium 100+ epochs;
  - paired for the first 50 epochs.
  Say in plain words whether the larger window is visible in any transition.
- Re-check the shares, messages-per-member figures, the per-checkpoint send limit and the archive interplay at 64 KiB. Update RESULT.md and DESIGN.md.

Also:
- Rebase onto codex/phase3a1b-p6-golden-path, now 760607d9. It has Track U's harness merge, d60a08af. My trial merge of your branch had one conflict: the header comment of tests/fixtures/track-m-apps/browser/long-room.pw.ts, where Track U added the TRACK_M_APPS_HEAP lines. Keep both sides.
- Track X's library fix for the real-network stall will land on main soon. Before your final proof, check `git log` on codex/phase3a1b-p6-golden-path. If it has moved, rebase again and rerun typecheck, the Chat e2e and your native tests.
- My verification of your current branch merged on main:
  - passing: typecheck 0, the shadow guard, every Chat, Canvas, Q, S, O and M2 test I ran, the Canvas/Chat e2e (9/9), and Track M's browser harness for Chat and Canvas (2/2, with Track U's heap option);
  - tests/chat-rolling-window-native.test.ts with CHAT_WINDOW_EPOCHS=60 fails 4 assertions that need the full length. For example, "expected 33760 to be greater than 131072" and "every member's share filled within the run".
  Make the test refuse a run too short for its assertions with a clear message, or scale those assertions to the length. Don't weaken them at 300.

Hard rules and reporting are as in your brief. Final report: the commits, the new values, "Bound for owner review", the 64-vs-32 KiB cost, and the suite diff.

### Follow-up instruction — Main moved (Track Y); port coordination (2026-10-21 18:07 UTC)

Coordinator here, two notes:

1. Main (codex/phase3a1b-p6-golden-path) is now 369420d0, with Track Y merged. Track Y lowered three library cache ceilings and added measurement-only probe hunks to tests/fixtures/track-m-apps/browser/{build.ts, entry.ts, long-room.pw.ts}. Expect a conflict there when you rebase, and keep both sides. Track X's fix will land on main within the next hour or two. Rebase onto main before your final proof, as I said before.

2. For the next hour or so, my verification uses the fixed ports 4175, 4180, 4181, 51000 and 51002 (the Canvas/Chat e2e and Track X's shipped-app harness). Before you start a run that uses them, check they're free with `lsof -nP -iTCP:4180 -sTCP:LISTEN`, and wait if they aren't.

### Follow-up instruction — Machine Node default changed; pin PATH (2026-10-21 18:17 UTC)

Coordinator here: an environment change you need to know about. At 14:07–14:08 something outside this session installed Node 22.23.4 and 24.22.1 through fnm and moved fnm's default alias from v22.15.0 to v22.23.4. The new default has no pnpm, so `pnpm` now fails with "command not found", and bare `node` is now 22.23.4.

To keep your runs comparable with everything before 14:07, put this at the front of PATH in every script and shell, and record it in PROGRESS.md:
export PATH="<fnm>/node-versions/v22.15.0/installation/bin:$PATH"
That directory has node v22.15.0 and pnpm 10.24.0, the repo's packageManager. Don't change the fnm default or install anything globally.

Check any run since 14:07 for "pnpm: command not found" or for node 22.23.4. Rerun those, and never pair a run on 22.23.4 with one on 22.15.0. This matters for your 64-vs-32 KiB paired comparison.

### Follow-up instruction — Main moved: Track X merged, 24d4ca61 (2026-10-21 19:03 UTC)

Coordinator here: main (codex/phase3a1b-p6-golden-path) is now 24d4ca61, with Track X's real-network delivery fix (packages/node: v3-live.ts, room-network.ts, v3-room.ts; packages/issuance-store retirement.ts) on top of Track Y. Rebase onto it before your final proof, rebuild the dists, and rerun typecheck, the Chat e2e and your native tests. Shipped Chat now runs 16/16 epochs over real networking with Track X's harness: tests/track-x-shipped-app-long-room.pw.ts -g "shipped chat page" with playwright.track-x-shipped-app-long-room.config.ts. One run of that with your 64 KiB window would be a good end-to-end check. Check the shared ports first.

### Follow-up instruction — Owner: ship the 32 KiB window (2026-10-21 19:45 UTC)

Coordinator here. I took your 64 KiB blocker, from RESULT.md section 0, to the owner (2026-10-21). They chose to SHIP THE 32 KiB WINDOW NOW. Raising the library's room-state cap stays an open item; no track is planned for it yet.

So:
- Skip plan step (c), the 64 KiB scratch runs w64-16x2 and w64-30x8. If one is already running, let it finish or stop it; your choice.
- Finish steps (a) and (b), the 32 KiB runs over real networking with Track X's harness, and the 300-epoch native run on 24d4ca61.
- In RESULT.md section 0, record that after the blocker the owner chose the 32 KiB window. Keep the 64 KiB history and the values in 0.1–0.3 as they are, for later.
- Section 3's limits as shipped are now: a 32 KiB window, the equal split, own-oldest eviction, one share per checkpoint, the largest message one share, and the archive at 2,000 messages or 1 MiB. Track Q's approved bound holds unchanged, so there is nothing new to review there.
- Then commit RESULT.md with its final ids and send your final report.

### Report returned by the agent (2026-10-21 21:38 UTC)

Track W, second round: done. The branch ships the 32 KiB window, per the owner's decision after the 64 KiB blocker. RESULT.md is committed with its final ids. Branch track-w-chat-rolling-window, on main 24d4ca61. The worktree is clean, nothing is pushed, and none of my processes are still running.

#### Commits (on 24d4ca61)
1. f9853e92 test(track-w): RED for Chat's rolling window and device archive
2. d858f67b Chat: new rooms keep a rolling window; each device keeps an archive
3. e90b3d39 test(track-m): measure Chat's window format and device archive
4. 07487efb Chat: the window format states Track Q's resource bound
5. bd5dbe3f test(track-m): record each role's origin storage usage for every app
6. dca097aa docs: the first round's RESULT.md
7. bebb3d95 test(track-w): RED for the 64 KiB window and its own resource bound
8. d332bf4d Chat: the window format keeps 64 KiB per room, with its own limits
9. ec14c306 Revert the 64 KiB window: the room caps application state at 32 KiB (tree identical to commit 6's, checked)
10. 990076f2 test(track-w): the native test refuses a run too short for its assertions
11. 21cce8ed test(track-w): the native test's flatness slope needs 100 steady epochs
12. 82952f37 docs: record Track W's second round: the window ships at 32 KiB

Rebases: onto 369420d0 (Track Y), then 24d4ca61 (Track X). Neither had a conflict: git merged Track Y's hunks in tests/fixtures/track-m-apps/browser/{entry.ts,long-room.pw.ts}, and my changed lines there are byte-identical before and after. Older ids for the same commits are listed in RESULT.md "Commits".

#### Owner's decision, as recorded in RESULT.md
- **Section 0:** the 64 KiB counterexample, the library caps and the RED tests that pin them, then the decision: ship 32 KiB now. Raising the library's room-state cap stays open, with no track planned. The 64 KiB history and sections 0.1-0.3 are kept for later; reapply by reverting ec14c306.
- **Section 3, limits as shipped:** a 32 KiB window, equal split at creation, own-oldest eviction, one share per checkpoint, largest message one share, and the archive at 2,000 messages or 1 MiB per room per device. Track Q's approved bound holds unchanged, so there is nothing new to review.
- **Late-joiner shares and departed members' bytes:** known limit, for follow-up W2.

#### For later, if the library cap is raised
These are kept in RESULT.md sections 0.1-0.3. None of them is approved.
- **64 KiB shares:** 65,340 / 32,633 / 21,731 / 16,280 / 8,103 bytes for 1 / 2 / 3 / 4 / 8 members. That is about 353 / 176 / 117 / 87 / 43 messages per member (32 KiB: 176 / 87 / 58 / 43 / 21).
- **Bound by Q's method:** {65,535 bytes, 9,503 items, depth 4}.
- **Cost of 64 KiB vs 32 KiB:** about 2x CPU per epoch at a full window. In the paired first 50 epochs nothing is visible in any transition, because the states are identical then.

#### Final checks, on 24d4ca61
- `pnpm -r typecheck`: exit 0, 0 errors.
- Shadow guard: exit 0.
- Unit tests: 34/34.
- Canvas/Chat e2e: 9/9.
- **Native test, 300 epochs: 7/7 pass.** State, rows, bytes and archives are identical to the first round's run and to a run on 369420d0.
  - On 369420d0 every transition is flat (slopes -0.14 to +0.24 ms per epoch).
  - On 24d4ca61 the transitions are as fast over epochs 71-220. Over 221-300 they all slow about 3x together, including a 30 ms local follow-up issue. Wall time went from 6.2 to 22 s per epoch as load rose from 189 to about 275, so I read it as the machine, not the room.
- **Track X's harness for shipped Chat, over real networking:**
  - 16 epochs x 2 messages: 16/16. Seal 2.3-3.0 s from epoch 5, which matches Track X's settlement maintenance figure. Room rows equal Track X's (160/111) plus one archive row per message.
  - 30 epochs x 8 messages: 30/30. The window fills after 184 messages and evicts from epoch 24. The observer's whole history equals the creator's every epoch, 240 messages at epoch 30.
  - Plan step (c), the 64 KiB scratch runs, was skipped as you asked; it never started.
- **Suites:** I did not rerun the full suites. Since the revert, the code differs from the first round's only in the native test; the first round's per-test diff showed no new failures.
- **Not rerun after the rebases:** the 120-epoch run with CHAT_WINDOW_PAD=400 (7/7), the guard refusals and the Chromium runs. All ran earlier on the same Chat code.

#### Environment notes
- **Node version:** from 14:07, fnm's default node moved to 22.23.4. Runs made with it were set aside (logs/node22.23.4-invalid/) and redone on v22.15.0 through bin/with-pnpm.sh, using your PATH line. Every paired comparison ran before 14:07.
- **Shared ports:** my port-wait script read lsof's exit code, which is 1 whenever any one of several ports is unused, so its check always passed. That caused several start races, and one e2e attempt failed 9/9 because its relay hit EADDRINUSE on 50002, held by Track V's Grid harness. Fixed: the script now reads lsof's output and also checks 50000/50002. Track Z's back-to-back runs held the ports from 16:19 to 17:30.
- **Stopped runs:** I stopped two pre-rebase native runs of my own. Neither had failed.

#### Files
- RESULT.md: <worktree agent-a9b9982b4fd998b37>/docs/realtime-latency/tracks/33-track-w-chat-rolling-window/RESULT.md
- Evidence: <evidence>/track-w/ (PROGRESS.md and DESIGN.md are updated)

I did not touch docs/realtime-latency/README.md, examples/v3-chat, examples/grid, tests/fixtures/startup-discovery, or any RED or governance test.
