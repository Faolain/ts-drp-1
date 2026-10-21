# Track T: the shipped apps and the settlement profile

Worktree: <worktree agent-ababeed392e2221c7>/
Branch: worktree-agent-ababeed392e2221c7 (base a3f3f6b0, codex/phase3a1b-p6-golden-path)
Commits: see "Commits" at the end. Evidence: <evidence>/track-t/ (PROGRESS.md, MAP.md, logs/, latency/, chromium/,
tests/, bin/, proposed-a-next-amendment.patch).

The user's decision "R-A for all shipped apps" (2026-10-20) asks that the shipped apps sign
`creator-trusted-settlement-v1`, so that each Writer's issuance settles and the room's existing retirement drains it.
Track P showed the legacy `creator-trusted-v1` keeps every issued row (tracks/26 RESULT.md).

## Summary

- **Canvas switched; Grid and v3-chat did not.**
  - The shipped Canvas now signs `creator-trusted-settlement-v1` into new rooms, with the version-3 latched ACL the
    protocol requires for it. One exported source of truth, examples/canvas/src/profile.ts, feeds the app, Track P's
    test and Track M's harness. Nothing else in the app changed.
  - The Grid example and the v3-chat demo stay on `creator-trusted-v1`: a RED test
    (tests/phase-3-exit-genesis-roots-red.test.ts) pins both apps' real create paths to the legacy profile and ACL v1,
    and the phase-6a product contract also pins v3-chat's. Section 1 lists them, with a recommendation.
- **Storage stays flat on the settlement profile.** A Canvas creator and Writer recipient hold 13 issued rows from
  epoch 6 through 16 successors and a reopen on SQLite, and through 100 epochs in Chromium, where every store's row
  count is constant from epoch 8. At 20 moves per epoch they hold 85 rows through 30 epochs and a reopen, and no move
  is refused (legacy refused one in epoch 17). The legacy profile, measured with the opt-in variant, still grows by
  MOVES rows per epoch per peer.
- **Latency stays flat.** In Chromium (ABBA, 20 epochs) every HEAD slope is between -22 and +12.5 ms per epoch; base's
  seal grows +60-69 ms per epoch and its creator issue +3-6. On Node, HEAD's slopes are within -1.2 and +6.4 ms per
  epoch at low load, and per-move native work is constant. The price is a flat +150-280 ms at adoption, where the
  creator now issues its fence and deletes its settled prefix; the legacy room overtakes that within about 15 epochs
  at 2 moves.
- **Track P's test.** The profile now comes from the shipped app. (b) passes. **(a) fails on one check only**: its
  exact `next` count assumes MOVES rows per epoch, but settlement adds one author fence per successor. Every other (a)
  check passes, and with the count changed to MOVES + 1 the test passes (a) and (b) in full. The brief forbids changing
  the assertion, so I did not; the one-line amendment is in <evidence>/track-t/proposed-a-next-amendment.patch for a
  decision.
- **Documentation.** `settlementProfileFor` and the creator invite's profile field now say that `creator-trusted-v1`
  keeps every issued row and that new rooms should use the settlement profile. Comments only.
- **Checks.** `pnpm -r typecheck` 0 errors (46 packages); `node scripts/check-shadowed-sources.mjs` clean. Five
  vitest sets (packages/node, six storage-node files, 104 root files, the observation files, six native Canvas/Chat
  files) show no new failure against base, test by test, and the Canvas/Chat Playwright e2e passes 9/9 on both
  trees. The only changed result is (a)'s failure message, from base's failing check to the `next` check (section 9).

## 1. Map: what pins each app's profile

Full map: <evidence>/track-t/MAP.md, written at base before any change.

- **A switch changes two genesis literals, not one.** The protocol accepts `creator-trusted-settlement-v1` only with
  a version-3 latched ACL (packages/protocol-v3/src/latched-acl.ts:256: `(snapshot.version === 3) !==
(settlementProfile === "v1")` is a `snapshot-mismatch`). The legacy profile requires version 1 or 2. So each app's
  invite must change `profileId` and the ACL `version` (1 to 3). Version 3 also allows the `referee` group and 256
  members; nothing else in the invite changes.
- **Existing rooms keep their genesis profile.** A profile is latched in the signed genesis, so the switch applies
  to new rooms only (G25: no migration is implied or performed).

| App                                                                                | Decision                                                | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canvas (examples/canvas/src/index.ts `creatorInvite`)                              | **Switched** to `creator-trusted-settlement-v1`, ACL v3 | No RED, governance or contract test, frozen artifact, registry or vector reads the shipped Canvas profile.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Grid example (examples/grid/src/v3-zone.ts:1885, `createCreatorInviteMaterial`)    | **Left on `creator-trusted-v1`**                        | tests/phase-3-exit-genesis-roots-red.test.ts "routes both real product creator paths through the shared builder" drives the real `createV3ZoneApi().create` and asserts the invite's profile bytes are `creator-trusted-v1` (`expectProductInput`, lines 271-278) and its ACL bytes are version 1 (lines 624-640). It passes at base (9/9).                                                                                                                                                                                                                                                                                                                                                                                              |
| v3-chat demo (examples/v3-chat/src/index.ts:496, `createCreatorAuthorityMaterial`) | **Left on `creator-trusted-v1`**                        | The same RED test drives `d9336V3Chat.create` and asserts profile `creator-trusted-v1` and `expectedChatAcl` version 1 (lines 206-248). The phase-6a product contract also pins it: tests/fixtures/phase-6a-v3/creator-successor-product-contract.ts:721-775 (`isD108d2Authority`, `isD110cBSuccessorAuthority` require `profileId === "creator-trusted-v1"`), applied to the demo's own authority in packages/storage-browser/tests/phase-6a-creator-successor-product.pw.ts:1097 and 2518-2560; the entry asset packages/storage-browser/tests/assets/phase-6a-creator-successor-product-entry.ts:730-801 (`rawAuthorityAtEpoch`) hard-codes the literal; tests/phase-6a-creator-successor-product-red.test.ts:142-156 unit-checks it. |

**Recommendation for Grid and v3-chat.** Both pins assert "the product's current profile", not a guarantee. If the
user confirms R-A for these two apps, the coordinator can authorise amending them in one reviewed change:

- phase-3-exit-genesis-roots-red: `expectProductInput`'s profile literal and both expected ACLs' `version` (1 to 3);
- the phase-6a contract predicates and the entry's `rawAuthorityAtEpoch` literal (they would read the profile
  from the authority under test, or accept the settlement profile);
- then the same two-literal switch as Canvas in v3-zone.ts and v3-chat, each with an exported source of truth.

Not pins (class i): the registries and vectors list `creator-trusted-v1` among the allowed profiles and are not
affected; tests/fixtures/startup-discovery/shipped.ts `startupShippedCanvas` and
tests/r9-grid-outcome-transfer-native.test.ts:3511 build their own legacy invites and only carry a "shipped" label,
which is now stale for Canvas; the node type `V3RoomSuccessorAuthority.profileId` (packages/node/src/v3-room.ts:336)
names only the legacy literal, but the runtime (770-786) already returns either profile, as examples/chat shows, so
no widening was needed.

## 2. The change

Commit ac17c698.

- **examples/canvas/src/profile.ts (new).** `CANVAS_GENESIS_PROFILE = { profileId: "creator-trusted-settlement-v1",
latchedAclVersion: 3 }`, frozen, with a comment on why and on the legacy profile. It is the one exported source of
  truth: examples/canvas/src/index.ts imports DOM at module load, and packages/node/src/applications/canvas.ts is
  Track Q's file.
- **examples/canvas/src/index.ts.** `creatorInvite` signs `CANVAS_GENESIS_PROFILE.profileId` and ACL
  `version: CANVAS_GENESIS_PROFILE.latchedAclVersion`.
- **The one app-level change beyond the profile string is the ACL version (1 to 3)**, which the protocol requires
  for the settlement profile (section 1). Nothing else was needed:
  - the room accepts Canvas without an operation admission policy (Chat passes one; Canvas never did);
  - Canvas already forwards the optional `approveSettlementSourceSelection` global, as Chat does;
  - Canvas's projection keeps only `paint`/`splash` rows, so author fences never reach its state;
  - no resource bound was added (the creator's lull stays `deferred:unsupported`; Track Q owns that).
- **Track M's harness follows the shipped choice.** tests/fixtures/track-m-apps/long-room-core.ts reads Canvas's
  profile and ACL version from profile.ts (comment in tests/track-m-canvas-long-room.test.ts updated).

## 3. Track P's test on the shipped profile

tests/canvas-long-room-issuance-retention-native.test.ts, commit b9dada54.

**What changed in the test.** Only where the profile comes from, as the brief allows: the invite's `profileId` and
the ACL `version` it requires now come from `CANVAS_GENESIS_PROFILE` (examples/canvas/src/profile.ts), and the
comments that said "the shipped Canvas signs creator-trusted-v1" now describe the shipped profile. No assertion,
bound or epoch count changed; the (a) and (b) test bodies are textually unchanged.

**Legacy measurement, kept as an opt-in.** `CANVAS_LONG_ROOM_PROFILE=creator-trusted-v1` signs the legacy profile and
ACL v1, skips (a) through a `beforeEach` guard (so (a)'s text did not have to move), and runs one more test that prints
a `CANVAS_LONG_ROOM_LEGACY` line per epoch with the census and per-move work. It asserts nothing about growth. Any
other value of the variable is refused.

### 3.1 Results at HEAD (shipped profile)

<evidence>/track-t/logs/accept-head-16.log (16 successors and a reopen):

- **(b) passes.** Per-move native outbox page scans never exceed the first steady epoch's: creator 6, recipient 2.
- **(a) fails on its first check, and only there:** `creator issuance at epoch 9: the author keeps issuing: expected
29 to be 28`. The check is `next === first.next + (epoch - first.epoch) * MOVES`. Under the settlement profile
  each Writer also issues **one author fence per successor** (during adoption, section 3.3), so `next` advances by
  MOVES + 1 = 3 per epoch. The check counts moves only, which was exact for the legacy profile. It is not a
  guarantee; its comment says it exists so that "the bound is not vacuous".
- **Every other (a) check passes.** Re-evaluated offline from the census (<evidence>/track-t/bin/check-a.py): with
  the committed count, 18 of 136 checks fail, all of them `next` (9 epochs x 2 peers); with `next` advancing by
  MOVES + 1, 136 of 136 pass (pending 0, issued and outbox rows equal to epoch 8's, oldest kept row newer than
  epoch - 8, point reads and rows visited per move never above epoch 8's).
- **The amended check passes in vitest too.** An untracked copy with only that count changed
  (<evidence>/track-t/proposed-a-next-amendment.patch; it derives the fence count from `settlementProfileFor`) passes
  (a) and (b) through 16 successors and the reopen (<evidence>/track-t/logs/probe-amended-a-head-16.log).
- **I did not change the assertion**, as the brief requires. **Decision needed:** approve the patch (or an equivalent
  change to the expected increment) so that (a) is green on the shipped profile. Until then (a) is RED on this
  branch, for that reason only.

### 3.2 The legacy profile, measured (it still grows)

<evidence>/track-t/logs/accept-legacy-16.log (`CANVAS_LONG_ROOM_PROFILE=creator-trusted-v1`; census in
accept-legacy-16.census.log). (b) passes; (a) is skipped; the measurement test passes.

| transition    | rows, both peers | creator bytes | recipient bytes | creator move work (point reads:page scans:rows visited, 2nd move) | recipient move work |
| ------------- | ---------------- | ------------- | --------------- | ----------------------------------------------------------------- | ------------------- |
| 2             | 5                | 4,976         | 5,042           | 23:6:26                                                           | 4:2:10              |
| 4             | 9                | 8,832         | 8,898           | 40:10:82                                                          | 4:2:18              |
| 8             | 17               | 16,544        | 16,611          | 72:10:162                                                         | 4:2:34              |
| 12            | 25               | 24,268        | 24,335          | 104:10:242                                                        | 4:2:50              |
| 16            | 33               | 31,996        | 32,063          | 136:10:322                                                        | 4:2:66              |
| 17 (reopened) | 35               | 33,928        | 33,995          | 144:10:342                                                        | 4:2:70              |

Transition n: both Writers play 2 moves each in epoch n - 1 (the work columns), then seal, adoption and install of
epoch n; rows and bytes are the census after the install.

- Both peers keep every row: +2 rows (about 1.9 kB) per epoch, nothing pending. Retirement still classifies
  (through epoch e - 2, 6 protected rows) but nothing deletes, as Track P found.
- Per-move work grows with the rows held: the creator's point reads +8 and rows visited +20 per epoch, the
  recipient's rows visited +4. These match Track P's HEAD table exactly.

### 3.3 Where settlement retirement runs, and its cost

Measured with an untracked copy of the test that reads the creator's census after seal and after adoption
(<evidence>/track-t/logs/probe-stages-head-12.log), and read from the code:

- **Seal.** The creator's lull returns `deferred:unsupported` because the shipped Canvas declares no
  `readOrdinaryApplicationResourceBound` (packages/node/src/creator-close.ts:4808-4810), so the close's inline
  maintenance runs the retirement reconciliation at seal (`reconcileSnapshotRecoveryRoles`,
  packages/node/src/internal/creator-closed-rollback-data.ts:21062). It advances the decision
  (`retirementThroughEpoch` to e - 2) and changes no issuance row. This also happens on the legacy profile.
- **Adoption.** `adoptCreatorSuccessor` issues the creator's author fence for the new epoch and then deletes the
  settled prefix: `activateCreatorSuccessorLive` calls `cleanupCreatorSettlementSuccessor`
  (packages/node/src/v3-live.ts:21065, 20258), which calls `pruneAuthenticatedSettledPrefix` (20575 or 20613). In
  steady state the creator's watermark advances by 3 rows per adoption (2 moves + 1 fence), and its rows go
  15 → 13.
- **Writer recipient.** Its own drain (Track N) runs in its lull, which is `maintained` on every epoch from 3.
- **Cost per epoch.** In Chromium (section 6.1), adoption costs about +280 ms per transition at HEAD (463 against
  185 ms), flat; seal is about the same level on both trees (inline reconciliation runs on both) but stops growing.
  So settlement moves a flat ~0.28 s into adoption and removes base's growth of +64 ms per epoch in seal, +4 ms per
  epoch in each creator move and +22 ms per epoch in the recipient's lull.

## 4. Storage per epoch

Canvas, 2 moves per Writer per epoch, a Writer recipient, 16 successors and a persisted reopen, on SQLite (Node):
<evidence>/track-t/logs/accept-head-16.log (bin/rowsbytes.py). Rows are issued/outbox; bytes are logical issuance
bytes.

| transition    | creator rows | creator bytes | recipient rows | recipient bytes | creator move work (2nd move) | recipient move work |
| ------------- | ------------ | ------------- | -------------- | --------------- | ---------------------------- | ------------------- |
| 2             | 8/8          | 7,964         | 8/8            | 8,096           | 36:6:38                      | 4:2:14              |
| 4             | 7/7          | 7,066         | 14/14          | 13,958          | 42:6:50                      | 4:2:26              |
| 6             | 13/13        | 12,796        | 13/13          | 13,060          | 51:6:68                      | 4:2:30              |
| 8             | 13/13        | 12,802        | 13/13          | 13,066          | 60:6:86                      | 4:2:30              |
| 12            | 13/13        | 12,813        | 13/13          | 13,077          | 60:6:86                      | 4:2:30              |
| 16            | 13/13        | 12,817        | 13/13          | 13,081          | 60:6:86                      | 4:2:30              |
| 17 (reopened) | 13/13        | 12,814        | 13/13          | 13,078          | 60:6:86                      | 4:2:30              |

Transition n as in section 3.2.

- Both peers are flat at 13 rows from epoch 6, through the reopen; nothing pending. The rows are the last 4 epochs'
  own rows (4 x (2 moves + 1 fence) + 1). The oldest kept row is from epoch e - 4; 9 rows are protected.
- Bytes creep by 2-3 bytes per epoch from epoch 6 to 14 (wider sequence integers), then stay flat.
- Per-move work is constant from epoch 7. The creator's page scans are 6 per move, against 10 on legacy.
- In Chromium, on IndexedDB (section 6.1), the same: issued rows 13 per peer from epoch 6 (8,557 and 8,821 B at
  epoch 20, +1.2 B per epoch), and every store's row count is flat from epoch 7 (171 creator, 150 recipient); all
  stores together grow 25 B per epoch from epoch 8. On legacy all stores grow by 4 rows and 1.65 kB per epoch.
- **Grid and v3-chat** stay on the legacy profile (section 1), so no node-level check of their shipped compositions
  on settlement was added. The Grid application on settlement is already covered by Track N's
  tests/recipient-long-room-issuance-retention-native.test.ts and the Grid bench, which sign their own settlement
  invites. Chat (examples/chat) already shipped settlement; its Chromium stores are identical at base and HEAD
  (section 6.2).

## 5. Twenty moves per epoch, 30 epochs

Track P's census-bound probe, copied untracked from <evidence>/track-p/trash/ and set to the shipped profile
(tests/track-t-probe-moves20-settlement.test.ts, never committed; `CANVAS_LONG_ROOM_MOVES=20
CANVAS_LONG_ROOM_EPOCHS=30`; <evidence>/track-t/logs/probe-moves20-e30-head.log):

- **No move was refused.** All 30 epochs, the persisted reopen and the reopened epoch ran (on legacy, Track P's
  creator move was refused in epoch 17: "creator issuance maintenance proof reserve is exhausted").
- Both peers hold 85 issued and 85 outbox rows from epoch 6 through the reopen (82.6 kB creator, 82.9 kB recipient),
  nothing pending. 85 = 4 x (20 + 1) + 1.
- Per-move work is constant from epoch 8: creator 276 point reads, 10 page scans and 862 rows visited per move;
  recipient 4, 2 and 210.
- vitest status: the first test hit its 30-minute per-test timeout (the whole run took 3,231 s at load 80-140); the
  second test, which awaits the same run, then failed only on (a)'s `next` count (191 against 190: 21 rows per
  epoch). Offline, (a) with MOVES + 1 passes 332 of 332 checks and (b)'s check has no violation.
- **Track N's bound still caps the move rate.** The issuance owner's 1,024-row bound
  (`ISSUANCE_RETIREMENT_LIMITS.maxRows`) is about 511 issued records. A Writer keeps 4 x (moves + 1) + 1 rows plus the
  current epoch's moves, so the cap is about 100 moves per Writer per epoch (Track N section 6). At 20 moves a peer
  holds 85 + 20 = 105. The bound is unchanged.

## 6. Latency

Base is a3f3f6b0 (Canvas on `creator-trusted-v1`, ACL v1); HEAD is this branch (Canvas on settlement). No library
code differs between them (the protocol and node edits are comments), so every difference below is the profile.

### 6.1 Chromium, Canvas, interleaved pairs

- **Harness.** Track M's long-room harness (tests/fixtures/track-m-apps/browser/), Canvas on the room-database host
  in Chromium on genuine IndexedDB, a Writer recipient, the shipped lull, 2 moves per Writer per epoch, 300 ms
  settle, **20 epochs**.
- **Bundles.** Prebuilt from each tree (<evidence>/track-t/chromium/assets-base, assets-head; TREE files record the
  source), run with <evidence>/track-t/chromium/prebuilt.config.mjs, which is Track M's config without its build
  step, so no tracked harness file was edited for the runs.
- **Runs.** ABBA (base, HEAD, HEAD, base), 18:43-18:52, 1-minute load 42-69 (<evidence>/track-t/bin/chromium-pairs.sh;
  tables <evidence>/track-t/latency/canvas-chromium-w1.txt and canvas-chromium-w1-runs.md). Transition n as in
  section 3.2. Each cell is the median over transitions 6-20, then the least-squares slope over the same
  transitions:

| metric               | base, run 1       | HEAD, run 2       | HEAD, run 3       | base, run 4       |
| -------------------- | ----------------- | ----------------- | ----------------- | ----------------- |
| creator issue/move   | 493 ms, +5.5/ep   | 538 ms, +0.5/ep   | 483 ms, -1.1/ep   | 534 ms, +2.9/ep   |
| recipient issue/move | 23 ms, +0.8/ep    | 21 ms, -0.1/ep    | 20 ms, -0.1/ep    | 23 ms, +1.0/ep    |
| seal                 | 2935 ms, +59.8/ep | 2840 ms, +12.5/ep | 2547 ms, -22.2/ep | 2683 ms, +68.6/ep |
| adopt                | 179 ms, +4.7/ep   | 486 ms, -0.3/ep   | 435 ms, -4.7/ep   | 177 ms, +3.8/ep   |
| install              | 280 ms, +9.4/ep   | 284 ms, +0.5/ep   | 298 ms, -5.3/ep   | 261 ms, +1.9/ep   |
| recipient lull       | 1226 ms, +10.9/ep | 1261 ms, -4.3/ep  | 1055 ms, -6.2/ep  | 1080 ms, +32.6/ep |

Per transition, mean of each tree's two runs (ms):

| transition | creator issue base | creator issue HEAD | seal base | seal HEAD | adopt base | adopt HEAD | install base | install HEAD |
| ---------- | ------------------ | ------------------ | --------- | --------- | ---------- | ---------- | ------------ | ------------ |
| 2          | 154                | 173                | 98        | 99        | 84         | 251        | 142          | 184          |
| 4          | 504                | 431                | 233       | 256       | 103        | 381        | 199          | 278          |
| 6          | 574                | 461                | 2606      | 2486      | 167        | 526        | 241          | 294          |
| 8          | 493                | 479                | 2464      | 2767      | 147        | 437        | 243          | 302          |
| 10         | 484                | 551                | 2494      | 2828      | 171        | 486        | 364          | 390          |
| 12         | 534                | 510                | 2865      | 2806      | 169        | 717        | 241          | 343          |
| 14         | 455                | 507                | 2846      | 2706      | 207        | 464        | 267          | 287          |
| 16         | 541                | 558                | 2953      | 2747      | 185        | 415        | 294          | 259          |
| 18         | 492                | 492                | 3062      | 2840      | 213        | 476        | 273          | 275          |
| 20         | 539                | 533                | 3133      | 2522      | 196        | 458        | 338          | 382          |

- **HEAD is flat; base grows.** Over transitions 6-20, every HEAD slope is between -22 and +12.5 ms per epoch, and the
  medians of the per-epoch medians give seal -4.9, creator issue -0.3, adopt -2.5, install -2.4 and recipient lull
  -5.3 ms per epoch. Base grows in every run: seal +60 and +69, creator issue +5.5 and +2.9, recipient lull +11 and
  +33 ms per epoch. At 2 moves per epoch the base growth is still modest; Track P measured +732 ms per epoch of seal
  at 8 moves.
- **The cost of settlement is a flat ~280 ms at adoption** (463 against 185 ms, median over transitions 6-20): the
  creator's author fence and its settled-prefix deletion (section 3.3). Install is ~30 ms higher at HEAD
  (302 against 273); the recipient installs a successor that carries one more fence per Writer.
- **Seal and per-move issue are at the same level** on both trees (seal 2.73 against 2.85 s, creator issue 510
  against 502 ms per move, medians over transitions 6-20). The seal's level comes from the inline retirement
  reconciliation the shipped lull leaves to the seal on both trees; Track Q's resource bound is what would move it.
- **Crossover.** A full transition (seal + adopt + install, mean of each tree's runs) costs 3.2-3.9 s at HEAD from
  transition 6 on, median 3.5 s, slope -9.8 ms per epoch. On base it is 3.0 s at transition 6 and grows +74 ms per
  epoch (3.4-3.9 s from transition 16). The two meet around transitions 13-16 at this move rate; after that the
  legacy room is the slower one and keeps slowing.

### 6.2 Chromium, Chat (control)

Chat already shipped settlement and its code did not change, so this pair is a control: one base run and one HEAD run,
16 epochs, same harness and settings (<evidence>/track-t/latency/chat-chromium-w1.txt).

- Every store's rows and bytes, after install and after the lull, for both roles, and every lull kind are identical
  at every epoch (<evidence>/track-t/bin/samestores.py: 0 differences).
- Latency differences are noise from a single non-interleaved pair (creator issue 491 against 551 ms, seal 2.81
  against 2.53 s); I make no Chat latency claim.

### 6.3 Node (SQLite)

**Per-move native work** is the deterministic Node measure (Track P's observer of `StatementSync`): at HEAD it is
constant from transition 7 (creator 60 point reads, 6 page scans, 86 rows visited per move; recipient 4, 2, 30),
against +8 point reads and +20 rows visited per epoch for the creator on legacy (sections 3.2 and 4).

**Wall times.** Track M's harness on the default Node SQLite host (`TRACK_M_APPS_HOSTS=node`), Canvas with a Writer
recipient, the shipped lull, 2 moves, 300 ms settle. Base and HEAD differ only in the harness's Canvas profile, so the
runs swap tests/fixtures/track-m-apps/long-room-core.ts between a3f3f6b0 and HEAD (<evidence>/track-t/bin/swap-core.sh,
node-pairs.sh; restored to HEAD after each set). Two ABBA sets: w1 with 16 epochs at load 14-30, w2 with 24 epochs at
load 9-34 (tables <evidence>/track-t/latency/canvas-node-w1-runs.md, canvas-node-w2-runs.md). Median over transitions
6 and later, then slope:

| metric               | w2 base, run 1    | w2 HEAD, run 2   | w2 HEAD, run 3   | w2 base, run 4   | w1 base (runs 1, 4)        | w1 HEAD (runs 2, 3)         |
| -------------------- | ----------------- | ---------------- | ---------------- | ---------------- | -------------------------- | --------------------------- |
| creator issue/move   | 403 ms, +0.3/ep   | 363 ms, -0.4/ep  | 362 ms, +1.7/ep  | 406 ms, +58.4/ep | 384, 376 ms; -5.3, +6.5/ep | 384, 419 ms; +3.0, +2.6/ep  |
| recipient issue/move | 12 ms, +0.2/ep    | 11 ms, -0.0/ep   | 11 ms, +0.0/ep   | 13 ms, +1.4/ep   | 12, 12 ms; +0.7, +0.6/ep   | 12, 12 ms; +0.0, +0.1/ep    |
| seal                 | 1810 ms, +12.4/ep | 1442 ms, -1.2/ep | 1436 ms, +6.4/ep | 1683 ms, +194/ep | 1607, 1625 ms; +34, +26/ep | 1665, 1557 ms; +18, -2.9/ep |
| adopt                | 77 ms, -0.4/ep    | 222 ms, -1.0/ep  | 226 ms, +1.1/ep  | 80 ms, +14.7/ep  | 72, 73 ms; +2.0, +1.1/ep   | 256, 238 ms; +2.0, +0.6/ep  |
| install              | 111 ms, +0.2/ep   | 116 ms, -0.0/ep  | 113 ms, -0.3/ep  | 108 ms, +14.4/ep | 102, 109 ms; +4.1, +4.8/ep | 127, 123 ms; +0.9, +0.9/ep  |
| recipient lull       | 751 ms, -8.7/ep   | 634 ms, -1.1/ep  | 628 ms, +1.6/ep  | 745 ms, +87/ep   | 738, 698 ms; +92, +14/ep   | 726, 681 ms; +10, -2.6/ep   |

- HEAD is flat on Node too: in the quieter w2 set every HEAD slope is within -1.2 and +6.4 ms per epoch.
- Adoption costs +145 to +170 ms per transition at HEAD, flat (the creator's fence and deletion, as in Chromium).
- At 2 moves per epoch the legacy growth is small over 24 epochs on Node (w2 run 1, at the lowest load: seal +12,
  creator issue +0.3 ms per epoch); w2 run 4 caught a load spike at its end (load 9 to 34), so its slopes are not
  evidence. The deterministic work counts above are the Node evidence of growth.
- In w2, HEAD's seal is 240-370 ms below base's (1.44 against 1.68-1.81 s); in w1 the two are level. I do not claim a
  seal saving on Node.
- **SQLite file sizes.** The harness also reports each database's file plus WAL size. On both trees these grow about
  1.3 MB per epoch until each database reaches about 4 MB (SQLite's default WAL autocheckpoint, 1,000 pages), then
  slow to 0.2-0.3 MB per epoch over transitions 16-24; at transition 24 every database is 3.99-4.14 MB on both trees.
  This is WAL sizing, the same on both profiles; logical rows are flat at HEAD (+0.05 per epoch) and grow 4 per
  epoch on base.

### 6.4 Grid

The Grid example stays on `creator-trusted-v1` (section 1), so there is no shipped-profile change to measure. The
healthy-Grid bench (tests/fixtures/startup-discovery/healthy-grid.ts:365) already signs its own
`creator-trusted-settlement-v1` invite and does not use `createV3ZoneApi().create`, so it cannot run the shipped Grid
profile without editing the bench; I did not run it.

## 7. Endurance: 100 epochs

Measurement only, HEAD bundle, the same Chromium harness and settings as section 6.1, one run each
(<evidence>/track-t/latency/endure-canvas-head-100.txt and endure-chat-head-100.txt, bin/endure.py).

**Canvas, 100 epochs: passed** (18:56-19:08, 11.9 minutes, load 73-111, alongside the base root suite).

| window (transitions) | 8-15 | 16-31 | 32-49 | 50-74 | 75-100 | slope 8-100 (ms/ep) | late-half slope | max  |
| -------------------- | ---- | ----- | ----- | ----- | ------ | ------------------- | --------------- | ---- |
| seal                 | 2266 | 2652  | 2641  | 2598  | 2608   | +0.72               | +2.00           | 3397 |
| adopt                | 481  | 468   | 454   | 463   | 445    | -0.54               | -0.97           | 804  |
| install              | 270  | 294   | 295   | 281   | 283    | -0.36               | -0.06           | 775  |
| creator issue p50    | 453  | 486   | 540   | 529   | 515    | +0.23               | -0.43           | 727  |
| recipient issue p50  | 19   | 20    | 21    | 19    | 19     | +0.01               | +0.01           | 86   |
| recipient lull       | 987  | 1194  | 1115  | 1092  | 1073   | -0.05               | +0.20           | 1413 |

| epoch | creator issued rows / bytes | recipient issued rows / bytes | creator, all stores | recipient, all stores |
| ----- | --------------------------- | ----------------------------- | ------------------- | --------------------- |
| 8     | 13 / 8,542                  | 13 / 8,806                    | 171 / 161,918       | 150 / 144,407         |
| 16    | 13 / 8,557                  | 13 / 8,821                    | 171 / 161,953       | 150 / 144,467         |
| 32    | 13 / 8,575                  | 13 / 8,839                    | 171 / 162,213       | 150 / 144,782         |
| 50    | 13 / 8,575                  | 13 / 8,839                    | 171 / 162,189       | 150 / 144,668         |
| 75    | 13 / 8,588                  | 13 / 8,852                    | 171 / 162,695       | 150 / 145,328         |
| 100   | 13 / 8,588                  | 13 / 8,852                    | 171 / 162,438       | 150 / 145,073         |

- Every store's row count is constant from epoch 8 to epoch 100 on both peers. Issued bytes grow 46 B in 92 epochs
  (integer widths); all stores' bytes move within ±0.5 kB.
- No latency grows with room age: every slope over transitions 8-100 is within ±0.72 ms per epoch; seal's late-half
  slope is +2.0 ms per epoch.
- The creator's lull stays `deferred:unsupported` throughout (no resource bound; Track Q), so seal carries the
  reconciliation, as in section 6.1.

**Chat, 100 epochs: stopped at epoch 58 by Chat's own capacity, not by issuance.** The 58th epoch's move was refused
with `admission-rejected: v3 local operation was rejected before issuance`. The shipping Chat composition caps its
retained message state at 32 KiB (`SHIPPING_CHAT_RETAINED_BYTES`, examples/chat/src/v3-chat-capacity.ts:6), and the
harness sends 4 messages per epoch, so the room fills its capacity near epoch 57 and admission then refuses new
messages by design. Chat's code is identical at base, so this is not a Track T effect. Up to epoch 57:

- issuance is flat at 13 rows per peer (8,543 and 8,807 B), every store's row count is constant from epoch 8;
- snapshot chunk bytes grow with the message history (creator 15.7 kB at epoch 8 to 98.5 kB at epoch 57), as Track M
  recorded;
- latency slopes over transitions 8-57: seal +6.3, recipient lull +2.1, all others under +1 ms per epoch (the
  growing state, not issuance).

There is no 100-epoch Node run; the 30-epoch, 20-move Node probe (section 5) covers the Node host at a higher rate.

## 8. The legacy profile, documented

Commit ea34d5a6, comments only; legacy behaviour is unchanged.

- At `settlementProfileFor` (packages/protocol-v3/src/index.ts, the profile's single predicate): only
  `creator-trusted-settlement-v1` settles; under `creator-trusted-v1` each Writer's issuance store keeps every row it
  issued and grows with room age, as do seal time and per-move work, until a creator's move is refused at high move
  rates; new rooms should sign the settlement profile with a version-3 ACL; a room keeps its genesis profile.
- At `V3RoomCreatorInviteMaterialInput.exactCanonicalProfileBytes` (packages/node/src/v3-room.ts), where an app
  chooses its profile: the same advice.
- At examples/canvas/src/profile.ts.
- No package README or spec documents profiles for library users today; I added none.

## 9. Suites against base

Both trees ran in the same worktree, base (a3f3f6b0) first, then HEAD (ea34d5a6), each with
`vitest run ... --exclude ".claude/**" --no-coverage --testTimeout=120000` from the repository root and a JSON report
(<evidence>/track-t/tests/base-_.json, head-_.json; script bin/suite.sh). I compared them test by test
(bin/vcompare.py) and compared failure messages after normalising PIDs and temp paths (bin/msgdiff.py).

| Set     | Files                                                | Base passed / failed / skipped | HEAD passed / failed / skipped | New failures at HEAD |
| ------- | ---------------------------------------------------- | ------------------------------ | ------------------------------ | -------------------- |
| node    | packages/node (246)                                  | 1023 / 48 / 0                  | 1021 / 45 / 5                  | 0                    |
| snr     | 6 storage-node retention and room-head files         | 158 / 49 / 2                   | 158 / 49 / 2                   | 0                    |
| root    | Track P's 96 root files + Track M/O room tests (104) | 759 / 344 / 84 of 1187         | 760 / 343 / 85 of 1188         | 0                    |
| obs     | 3 startup-discovery observation files                | 23 / 0 / 0                     | 23 / 0 / 0                     | 0                    |
| native6 | 6 native Canvas and Chat files                       | 35 / 15 / 0                    | 35 / 15 / 0                    | 0                    |
| e2e     | Canvas and Chat Playwright (Chromium)                | 9 / 0                          | 9 / 0                          | 0                    |

The differences, each checked:

- **node, 5 skipped at HEAD.** These are the five tests of sync-state-heap-recharacterization-1o-f-ii-red, which the
  loaded suite run skipped. Run alone at HEAD they give 3 failed and 2 passed, with base's exact messages
  (logs/rerun-head-heap-1o-f-ii.log).
- **root, one test only at HEAD.** The opt-in legacy census test, skipped unless
  `CANVAS_LONG_ROOM_PROFILE=creator-trusted-v1`.
- **root, one test fixed at HEAD.** phase-4c-snapshot-stream-red's 64 MiB contract failed at base on timing under
  load. It passed in Track P's run, and Track T does not touch it.
- **root, Track P's (a) message.** Base fails at "creator issuance at epoch 8: oldest kept row: expected 0 to be
  greater than 0", because legacy never retires. HEAD fails at "creator issuance at epoch 9: the author keeps issuing:
  expected 29 to be 28", the fence count from section 3.1. (b) passes on both trees.
- **root, phase-3-exit-envelope-purity-red "keeps both node runtime entrypoints unchanged".** This test fails on
  both trees. In the HEAD suite run its message was a temporal-dead-zone `ReferenceError` from the two concurrent
  dynamic imports, instead of base's export-list mismatch. Run alone at HEAD it fails with base's exact message,
  "expected [ 'DRPNode', …(2) ] to deeply equal [ 'DRPIntervalSync', 'DRPNode', …(4) ]"
  (logs/rerun-head-envelope-purity.log).
- **All other message differences** are PIDs and temp directory names (phase-6b differential exit,
  journal-anchor-read-node-red).
- **Files that fail to load** are the same on both trees: three root files (missing frozen role artifacts, an
  unbuilt `@ts-drp/storage-node/room-head` export, missing `@grpc/grpc-js`) and two node files.
- **e2e.** The first HEAD run hit two `beforeEach` hook timeouts under load. Both passed alone, and a full rerun
  passed 9/9 (logs/e2e-canvas-chat-head2.log). Base passed 9/9 (logs/e2e-canvas-chat-base.log).

`pnpm -r typecheck` at HEAD: 0 errors across 46 packages, exit 0 (logs/typecheck-head.log).
`node scripts/check-shadowed-sources.mjs`: exit 0.

## 10. Guarantees

No product or library code changed: the switch is two genesis literals in the Canvas example, chosen from profiles
the protocol already defines, and every settlement mechanism it now reaches is the one Chat, the Grid bench and
Tracks M and N already run. So no guarantee's argument changes; the switch moves Canvas from a path that breaks G1
to one that keeps it.

- **G1 (no growth with room age).** Canvas on settlement: both peers' issuance is flat at 13 rows from epoch 6
  through epoch 17 and a reopen (section 4), 85 rows at 20 moves per epoch (section 5), and per-move work is
  constant from epoch 7. On the legacy profile it grows by MOVES rows per epoch, unchanged (section 3).
- **G7, G9, G14, G15, G19 (retirement).** The rows that go are deleted by the existing owners: the creator's
  `cleanupCreatorSettlementSuccessor` → `pruneAuthenticatedSettledPrefix` during adoption, from the coordinated
  decision the seal's inline reconciliation writes, and the Writer recipient's Track N drain in its lull. No new
  deleter, decision owner or watermark rule was added.
- **G18 (protected set).** The census keeps the two rollbacks' rows: the oldest kept row is epoch e - 4, with 9
  protected rows per peer (retirement through e - 2), on both peers, at every epoch.
- **G21, G22 (bounded work, proof budget).** No limit or charge changed. Settlement is what keeps the creator's
  per-issue maintenance quote bounded: at 20 moves per epoch the legacy room exhausts the proof reserve in epoch
  17 (Track P 4.4); on settlement the same room runs 30 epochs (section 5).
- **G25 (migrations).** Existing Canvas rooms keep the profile their genesis signed; there is no conversion and no
  second authority. New rooms latch the new profile at genesis.
- **G26 (latency never relaxes safety).** Nothing was relaxed; the change is a profile choice, not a shortcut.
- **G2, G3, G23.** Canvas's moves, joins and reopens behave as before: the Canvas e2e (creator and receive-only
  joiner converge on a painted pixel), Track P's (b) test and the persisted reopen pass on the new profile.
- **G28.** The evidence is native: SQLite on Node (Track P's test), real IndexedDB in Chromium (Track M's harness).
  Firefox and WebKit were not run.

## 11. What remains, and risks

1. **Track P's (a) is RED on this branch, on one check.** Its `next` count assumes MOVES rows per epoch; the
   settlement profile adds one author fence per successor. Everything else in (a) passes (section 3.1). Proposed
   amendment, not applied: <evidence>/track-t/proposed-a-next-amendment.patch (expected increment
   `MOVES + FENCES_PER_SUCCESSOR`, with the fence count from `settlementProfileFor`). It needs the coordinator's
   approval because the brief forbids changing the assertion.
2. **Grid and v3-chat stay on the legacy profile.** Their rooms keep every issued row and will slow and eventually
   refuse moves, as Track P and Track N describe (Grid at 3 rows per epoch reaches the issuance bound near epoch
   170). Switching them needs the RED and contract amendments listed in section 1; after that the switch is the
   same two literals as Canvas.
3. **Existing Canvas rooms keep `creator-trusted-v1`.** The switch applies to new rooms only. A persisted legacy
   Canvas room still grows; no migration exists or was attempted (G25).
4. **The creator's lull is `deferred:unsupported` for Canvas**, so the retirement reconciliation stays inline at seal
   (~2.7 s in Chromium at this load, flat). Track Q's resource bound would move it into the lull. I added no bound.
5. **Adoption is ~150-280 ms slower per transition** on the settlement profile (fence plus deletion). It is flat, and
   the legacy room overtakes it within about 15 epochs at 2 moves (section 6.1), sooner at higher move rates.
6. **The move-rate cap remains.** About 100 moves per Writer per epoch under the 1,024-row issuance bound (Track N);
   unchanged.
7. **Stale "shipped" mirror.** tests/fixtures/startup-discovery/shipped.ts `startupShippedCanvas` (and its
   browser-red.pw.ts:176 assertion) builds its own legacy Canvas invite labelled "shipped". It still passes; it now
   describes the previous shipped profile. It is a RED fixture, so I did not edit it.
8. **Chat's 32 KiB state cap** ends a Chat room near epoch 57 at 4 messages per epoch (section 7). That is Chat's
   designed capacity, unchanged here, but a long-room benchmark of Chat must account for it.
9. **Not run:** Firefox and WebKit; a 100-epoch Node run; the Grid bench (section 6.4).

## Files and functions touched

| File                                                                                | What                                                                                                                                                                              |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| examples/canvas/src/profile.ts (new)                                                | `CANVAS_GENESIS_PROFILE`                                                                                                                                                          |
| examples/canvas/src/index.ts                                                        | `creatorInvite` (profile id and ACL version from `CANVAS_GENESIS_PROFILE`), one import                                                                                            |
| tests/canvas-long-room-issuance-retention-native.test.ts                            | `canvasLongRoomFixture` (profile id and ACL version from `PROFILE`), header and (a) comments, `LEGACY_MEASUREMENT`/`PROFILE`, a `beforeEach` guard, the opt-in legacy census test |
| tests/fixtures/track-m-apps/long-room-core.ts                                       | `openRole` (Canvas ACL version and profile id from `CANVAS_GENESIS_PROFILE`), one import                                                                                          |
| tests/track-m-canvas-long-room.test.ts                                              | header comment                                                                                                                                                                    |
| packages/protocol-v3/src/index.ts                                                   | `settlementProfileFor` JSDoc only                                                                                                                                                 |
| packages/node/src/v3-room.ts                                                        | `V3RoomCreatorInviteMaterialInput.exactCanonicalProfileBytes` JSDoc only                                                                                                          |
| docs/realtime-latency/tracks/30-track-t-settlement-for-shipped-apps/RESULT.md (new) | this result                                                                                                                                                                       |

Parallel tracks: I did not touch packages/node/src/applications/canvas.ts or examples/chat (Track Q),
packages/node/src/internal/creator-closed-rollback-data.ts (Track S), or any room-retention code (Track M2). No reopen
failed, so nothing of Track S's kind was observed. Possible textual overlap: Track Q may edit
examples/canvas/src/index.ts to add a resource bound (different lines from `creatorInvite`), and the v3-room.ts JSDoc
sits in a shared file.

Untracked and never committed: tests/track-t-probe-moves20-settlement.test.ts, track-t-probe-stages.test.ts,
track-t-probe-amended-a.test.ts (moved to <evidence>/track-t/trash/ after use); the Chromium config and all scripts
live under <evidence>/track-t/.

## Commits

On worktree-agent-ababeed392e2221c7, from a3f3f6b0:

- ac17c698 Canvas: sign creator-trusted-settlement-v1 into new rooms
- b9dada54 Track P's Canvas long-room test follows the shipped profile
- ea34d5a6 docs: the legacy creator-trusted-v1 profile keeps every issued row
- this result (docs: record the Track T result)
