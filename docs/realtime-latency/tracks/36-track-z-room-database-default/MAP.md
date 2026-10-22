# Track Z map (step 2)

Base: main at ebf4254f, with the four harness commits cherry-picked (bfb42d68, 8d7d9d14, 21b88495, c395e2b3).
Branch: worktree-agent-a869e104e72e01ff1. Code was read on 2026-10-21. Line numbers are at that head, except §4,
which gives packages/node/src/v3-room.ts lines at the final code (2a00d915 on main 30cb474e, with both bench-found
fixes). The stack was then re-applied onto main 0171994d (Track W2: examples/chat, tests and docs only), where the
flip is 1c7ee87b; nothing under packages/ changed, so these line numbers hold there too.

Scope set by the owner:
- New rooms use the room database with retention. Existing rooms keep the host they were created on, with no
  migration.
- On the new default, the library schedules the lull every epoch. Six-database rooms get no new scheduling.
- Out of scope, as later tracks: the one-off first retirement round (2.1-2.8 s), and adoption.

The owner decided both questions on 2026-10-21:
- 14c: deferred (option c). The flip ships without 14c; CRD is not touched for 14c (§1.1).
- Pins: option (1), the explicit host. The binding exports `createBrowserV3SixDatabaseStorageHost()`, and each class
  (ii) test that relied on the default passes it, in its own commit before the flip, with no other change. Option
  (3) is not done (§2.5).

## 1. Prerequisites

### 1.1 14c: per-owner floor fences. NOT wired; a counterexample blocks wiring it as written

**At the base**
- Storage only, opt-in. With `retirementFences: true` on `createBrowserRoomHeadAuthority`, the floor opens at
  version 2 and gains a `retirementFences` store (packages/storage-browser/src/room-head.ts:42, 68-76, 157-175).
- `fenceRetirement` is one strict read-write transaction over `floor` and `retirementFences` (room-head.ts:433-447).
  `readRetirementFences` is at :448-456.
- The rules are in packages/storage/src/room-head.ts:596-640: `roomHeadRetirementFenceChange`, and the codes
  `ROOM_HEAD_FENCE_WINDOW`, `ROOM_HEAD_FENCE_CONFLICT` and `ROOM_HEAD_FENCE_CORRUPT`.
- The REDs are fake-indexeddb only, 9 cases (packages/storage-browser/tests/room-head-retirement-fences-red.test.ts).
  The three-engine 14c RED #2 does not exist.
- Nothing in packages/node, examples or tests calls `fenceRetirement`, `readRetirementFences` or
  `retirementFences: true`. `RETENTION_FENCE_MISMATCH` exists only in the spec.

**What the node does instead: Track M's per-decision fence**
- Step A is `fenceDecision(labels)`: one floor transaction that prepares and commits
  `{throughEpoch, decisionDigest, sourceProofDigest}`. It is in storage-browser room-head.ts:395-425 and storage-node
  room-head.ts:390-419, and is called at packages/node/src/internal/creator-closed-rollback-data.ts (CRD):20951-20976.
  It runs before step B, `applyRetention`, and then `checkpoint()` (CRD:20997).
- A floor without `fenceDecision` declines with `floor-fence-unavailable` (CRD:20979-20984).
- Track M trust RED 4: a mark claiming more retirement than the floor fails closed at open (Track M RESULT.md §G6).

**The counterexample to wiring the 14c open check as specified (14c "Check at every open")**
1. On the retention host, the first retirement of every room runs the existing per-class path, not retention.
   - Retention declines while any owner control is unborn: CRD:21195-21206, decline `control-birth`, plus the
     `ahe-birth` and `*-same-epoch` declines that step 1 saw on every page.
   - The existing path creates and advances the five owner controls in the room session
     (installClosedRetirementSourceInRoom, CRD:19193-19230; floor participant with `room.session.checkpoint()` at
     CRD:19715-19719). It writes no per-owner fence.
   - Every later decline also runs the existing path: `unit-over-cap` (above about 85 signers), `floor-fence-unavailable`,
     `session-unsupported`, and any `RETENTION_*` refusal (CRD:20895-20905, 22765-22768).
2. 14c's open check accepts only three states per owner. "Anything else" fails closed with
   `RETENTION_FENCE_MISMATCH` and is never repaired.
   - control == target: consistent;
   - control == base: pending;
   - no entry: consistent only for 14d migration copies.
3. With no migration, "no entry" never applies. Any control the existing path advanced, before the first fence or
   after one, therefore fails the next open closed. The room is bricked by a legitimate path, against G3.
   - The next `fenceRetirement` would also refuse `ROOM_HEAD_FENCE_CONFLICT`, because base is not old.target.
     Retention would then never run again.

**14c is inert on every floor we run.**
- The shipped pages take their floor from the app host (`window.__TS_DRP_*_ROOM_HEAD_AUTHORITY_FOR_OPEN__`,
  examples/canvas/src/index.ts:191).
- In Track X's and Track V's harnesses and the e2e tests, that floor is the Node SQLite floor over RPC
  (tests/fixtures/phase-3a1b/grid-room-head-authority.ts). It has `fenceDecision` (storage-node room-head.ts:419) but
  no `fenceRetirement`, and 14c puts the SQLite floor out of scope (14c "Runnable RED and acceptance").
- The bench's floor is a browser floor without the option (tests/fixtures/startup-discovery/healthy-grid.ts:52).
- The library cannot enable `retirementFences` on a floor the host supplies. It can only use fences the floor offers.

**Options (sent to the coordinator)**
- (a) Full wiring, used only when the floor offers fences:
  - fence every owner-control change on the room host, existing path included. That needs a session read of the five
    control digests in the held transaction;
  - write step A before each room checkpoint or commit;
  - open check, with "no entry" consistent until that owner's first fence. This is a class (ii) note against 14c's
    text.
  - Large: CRD, the storage-browser session, a new floor option in fixtures. The source-text node tests on CRD then
    change (§2.3).
- (b) Fence only retention decisions. This cannot tell an existing-path advance from tampering, so it is weaker than
  the spec. Not recommended.
- (c) Defer 14c and record it as remaining. What protects the room today is `fenceDecision` plus trust RED 4.

**Decision (owner, 2026-10-21): (c), defer.** The flip ships without 14c and CRD is not touched for it. Recorded
for RESULT.md:
- The counterexample: the existing per-class path writes no per-owner fence, so 14c's open check, as written, fails
  closed (`RETENTION_FENCE_MISMATCH`) on every room after its first retirement round.
- 14c is inert on every floor we run: the Node SQLite floor over RPC has no `fenceRetirement`, and the bench's
  browser floor does not enable `retirementFences`.
- What protects rooms today: Track M's step A, `fenceDecision(labels)` (one floor transaction committing
  `{throughEpoch, decisionDigest, sourceProofDigest}` before `applyRetention`, CRD:20951-20976), with the
  `floor-fence-unavailable` decline when a floor lacks it, and Track M trust RED 4 (a mark claiming more retirement
  than the floor fails closed at open).
- What full wiring needs (option a): a fence for every owner-control change on the room host, existing path
  included; a new storage-browser session read of the five control digests inside the held transaction; step A
  before each room checkpoint or commit; the open check with "no entry" consistent until that owner's first fence
  (a 14c text amendment, class (ii)); a floor option in the fixtures; and the three-engine 14c RED #2.
- 14c stays a remaining item, to revisit if an IndexedDB floor ships.

### 1.2 14d: migration. Not wanted; host routing replaces it

- The refusal, a07e3206, is in examples/v3-room/src/index.ts:
  - `existingDatabaseVersion` (:80-99) probes without creating;
  - `prepare` (:119-124) throws `V3_ROOM_DATABASE_MIGRATION_UNAVAILABLE` for a version other than 7.
  - Test: tests/room-database-retirement-native.test.ts:570-594.
- Names and versions of the six-database layout:

  | Database | Version | Source |
  |---|---|---|
  | `N` (signing, seal vote, evidence) | 6 | schema-idb.ts:89-93 |
  | `N--ahe` | 6 | |
  | `N--drp-snapshot-quarantine-v1` | 4 | |
  | `N--drp-live-journal-v1` | 3 | |
  | `${issuanceDatabaseName}--drp-issuance-v1` | 3 | |

- The room layout is one `N` at version 7 (schema-idb.ts:489-571, 831-875). The floor stays separate in both layouts.
- A recipient in the six-database layout may have no `N` at all. It opens signing stores only from epoch 2
  (v3-room.ts:2750-2782, recipientRecoveryContext). Routing must therefore probe every legacy name, not just `N`
  (pins inventory; tests/grid-memory-runtime-owners.test.ts:56-75 counts 9 databases with no recipient base name).
- Never call `prepareBrowserRoomDatabase` on a version-6 `N`: it moves to a "migrating" layout that every owner
  refuses (schema-idb.ts:843-848).
- 14f case 9 (SIGKILL at each migration step) is not applicable.

### 1.3 14f: three-engine evidence

- Cases 1-4 (session): 18/18 on three engines (R3 RESULT.md:194-204), from packages/storage-browser/
  playwright.room-retirement-session-native.config.ts.
- Cases 2, 3, 5-8 and 11 (retention): tests/fixtures/track-m/native/playwright.config.ts with `--project
  chromium|firefox|webkit` (room-retention-native.pw.ts).
  - Cases 5-8 pass on three engines (M2 RESULT.md:229-251); case 8 was fixed by Track O.
  - Case 11 (`TRACK_M_14F_LONG=1`) passes on Chromium.
  - All of it ran against `fenceDecision`, not 14c fences.
- Needed: re-run at my head (step 5), cases 5-8 and 11 on three engines. Case 9 is not applicable.

### 1.4 The 512-write cap

- `ROOM_RETENTION_LIMITS.maxWrites: 512` is "NEW policy pending review" (packages/storage/src/room-retention.ts:17-24;
  14e:29-58, 120-123).
- The planner halves `take` down to one unit (CRD:20926-20946). One unit still over the cap declines `unit-over-cap`,
  and that boundary takes the existing per-class path.
- One epoch's signing unit is about 6 writes per signer, so it passes 512 at about 85 signers (Track O
  RESULT.md:513-517). The Grid's unit is 6 writes.
- What a large room (over about 85 signers) sees:
  - every boundary falls back to the per-class path;
  - its lull and inline seal cost what the six-database host costs today, about 2.5 s on the creator (step-1 arm E),
    plus the existing path's floor two-phase work;
  - storage stays bounded (the existing path is G1-safe), but latency is the old latency.
  - The scheduled lull still moves that cost off the seal. It does not shrink it.
- Review: the cap bounds one transaction's work (G21) and the fallback is safe (G15). Raising it is a policy change for
  the owner. I propose no change and record the large-room behaviour.

### 1.5 Recipient-lull issue latency and the heap

- Issue latency (102 to 122 ms p50 in Track M's pairs): not re-measured since. Step 5's play-during-lull measurement
  covers it on real networking: the Grid Writer's own issue during its scheduled lull, p50/p90/max.
- Heap: answered by Track U (README row 40). The residual 0.36 MB per epoch is:
  - harness records, 0.16;
  - the canonical hash memo, about 0.1;
  - bounded library caches filling, 0.08.
  - Every grower has a ceiling, so G1 holds.
- Step 5 repeats the heap in a fresh process on the new default, with Track U's per-epoch heap in the track-m-apps
  browser long room (470392f2) in the 100-epoch storage run.

### 1.6 Node tests that evaluate source text (class (ii) owner review)

- Only if CRD or v3-live.ts change (option 14c-(a)). The flip as planned changes neither.
- Tests that read v3-room.ts:
  - packages/node/tests/creator-recipient-recovery-pool.test.ts:63-70 needs the `maintainRecipientRecoveryPool` body
    strings and `if (input.receiveOnly || creatorCloseHandle === undefined) return maintainRecipientRecoveryPool();`.
    I keep both verbatim.
  - creator-ordinary-readiness-producer.test.ts:1565-1610 reads `rebasePromise` and
    `prepareCurrentCreatorOrdinaryReadiness`. Not touched.
  - cold-discovery-room-callsite and presentation-overlay:590: unique calls and identifiers. Not affected.
  - tests/fixtures/startup-discovery/build.ts:1128-1160 (critical profiling only) needs exactly one
    `enqueueLifetimeTransition(` inside `adoptCreatorSuccessor` and `sealEpoch`. The scheduled lull is a helper call
    there, not a new `enqueueLifetimeTransition(`.

### 1.7 Room-path risks (R3 RESULT.md §9-10)

- **Session hold:** one strict read-write transaction over every room store, 106-116 ms p50 and up to about 380 ms per
  install. The scheduled creator lull runs right after adoption, while the recipients install from the creator's
  snapshot material. Step 5 measures install against the explicit-lull arm C, where the lull ran after install.
- **Web Locks:** the snapshot owner refuses exclusion without them (snapshot-transfer.ts:1129-1130). Browsers have them;
  Node tests need `createProcessLockManager`, as tests/room-database-retirement-native.test.ts:480-486 does.
- **One module instance:** owners and the session registry must come from one instance, or `RETENTION_FOREIGN_OWNER`.
  examples/v3-room imports every room-mode owner from `@ts-drp/storage-browser/maintenance` (index.ts:12-23), and
  apps get the host from the same module, so the default keeps that.
- **Filtered issuance facade:** no new facade is introduced.

### 1.8 Node SQLite hosts: unchanged, by construction

- `createNodeV3RoomStorageHost` (packages/storage-node/src/v3-room-host.ts:47-101) has no `openRoomRetirement`, so the
  captured host has no `roomRetention` (v3-room-host.ts:139-140).
- Node callers always pass `storageHost` to `@ts-drp/node/v3-room`. The default lives in the browser binding, which
  Node rooms never use for host choice.
- The scheduled lull is off unless asked for (§4). Nothing changes for Node SQLite rooms; a RED guards it.

## 2. Pins

Classes: (i) unaffected; (ii) RED, governance or contract test, frozen artifact, registry, vector or spec (never edit;
amendment listed); (iii) code or ordinary fixture to change.

The common amendment, "explicit six-database host", needs the binding to export the six-database host, for example
`createBrowserV3SixDatabaseStorageHost()`. That export itself conflicts with the d9346 extraction RED (§2.1, last row).

### 2.1 The default host or the six-database layout

| Path | Pin | Class and amendment |
|---|---|---|
| tests/phase-3a1b-d9346-room-semantics-red.test.ts:279-310 | default room; mocks the six-database factories in `storage-browser/dist/src/{index,issuance,live-journal}.js`; no IndexedDB | (ii): pass an explicit six-database host, or mock the room factories and install fake-indexeddb |
| tests/phase-3g-v3-room-rebase-red.test.ts:80-110, 574 | same mocks; name `target-plane--ahe` | (ii), same |
| tests/phase-3h-v3-room-rehearsal-red.test.ts:77-140, 803-807, 1340 | same; `${scratch}--ahe` and `--issuance` opened and closed twice | (ii), same |
| tests/phase-6b-d110c-0c1f5b0c-room-red.test.ts:158-200 | mocks the AHE and issuance factories | (ii), same |
| tests/phase-6b-d110c-0c1f5b0u-room-runtime-red.test.ts:55-75, 406 | wraps `createBrowserDurableIssuanceStore`; deletes `${name}-source--ahe` | (ii), same |
| tests/phase-6b-d110c-0c1f5b0u-successor-replay-red.test.ts:105 | opens `${db}--drp-snapshot-quarantine-v1` after a default room | (ii) |
| tests/phase-6b-d110c-0c1f5b-integration-red, phase-6b-grid-successor-state-red, grid-snapshot-content-delivery-room-red:56 | via tests/fixtures/grid-room-workload.ts; the last opens `--drp-snapshot-quarantine-v1` | (ii): the fixture passes an explicit six-database host |
| tests/fixtures/grid-room-workload.ts:477-530, 887, 910-932 | default rooms; `transferDatabase` copies `--ahe` with `PHASE_5E_SCHEMA_AUTHORITY` | (iii) fixture, feeding (ii) and grid-memory tests; amend with the explicit host |
| tests/grid-memory-runtime-owners.test.ts:56-75 | exactly 9 six-database databases | (iii): explicit host |
| tests/track-x-seal-source-deadlock-red.test.ts:134 via tests/fixtures/track-x/seal-source-room.ts:27, 107 | its "six-database" case passes no `storageHost` | (ii): the fixture passes an explicit six-database host (Track X's) |
| packages/storage-browser/tests/assets/phase-6a-creator-successor-product-entry.ts:1383 (+ six-database reads :621-2963) | default room, then reads six-database files | (ii) via recovery-retention-red.pw, phase-6a-creator-successor-product.pw and grid-memory-production.pw:163-170: explicit host |
| tests/phase-6a-creator-successor-product-red.test.ts:130-131 | the entry's text must contain the `--ahe` dumps | (ii): satisfied if the entry keeps the six-database layout explicitly |
| tests/fixtures/bounded-active-read/producer-entry.ts:103-110 | default room plus a six-database snapshot observer | (ii) via bounded-active-read-red.pw |
| tests/fixtures/startup-discovery/{room,lifecycle,shipped,recovery,r8-source-binding}.ts | default rooms, six-database reads | (ii) via browser-red.pw (:664 requires the only database to be `identity--startup-floor`) and r8-source-binding.pw. tests/phase-4a-v3-live-blueprint-fold.test.ts:78 is (iii) |
| tests/phase-3a1b-d9346-v3-room-extraction-red.test.ts:143-146 | runtime exports exactly the invite builder and `createV3RoomSession` | (ii), already failing at base (two more exports exist). I add no export |
| tests/track-v-grid-long-room.pw.ts:200, tests/track-x-shipped-app-long-room.pw.ts:242 | look up `--drp-issuance-v1` | (iii) measurement; the field becomes null |
| tests/fixtures/startup-discovery/healthy-grid.ts:69, 77-78, 513; r8-source-binding.pw.ts:727-729 | the no-flag run is the baseline; default mode opens six-database observers after the session | (iii) measurement. With the room default, those observers create empty six-database databases beside the room and read them, so the census fails. The fixture must pick observers by the room's layout |

**Unaffected (i):**
- tests/room-database-retirement-native.test.ts:569-594 is still valid, and is the template for the routing RED.
- Node-host suites: r9-*, recipient-*, canvas-long-room-*, chat-rolling-window*, canvas-chat-creator-lull-native.
- The canvas-chat-lull and track-m-apps "browser" hosts, which build their own six-database host.
- Chat-zone REDs, r9-grid-configured-creator and examples/grid transient-presentation-owner.test.ts, which mock
  `createV3RoomSession`.
- The example e2e tests, which take no IndexedDB census.
- packages/node/tests/v3-room-storage-host.test.ts:59. The default does not go into `captureV3RoomStorageHost`.

### 2.2 The lull scheduling

With the gate in §4 the scheduling is off unless the binding selects it, so every explicit-host retention test is (i).

**Tests that would be (ii) if the gate were `roomRetention` alone:**
- tests/track-m2-ledger-red.test.ts:106-118, 145-291. The explicit lull after `transition()` must return
  `maintained` with an applied ledger pass.
- The tests built on tests/fixtures/track-m/room-retention-fixture.ts:349-369, whose `transition` is documented "no
  lull":
  - track-m-room-retention-{trust,bounds,differential,settlement};
  - track-m2-ledger-{differential,split,apps};
  - track-o-room-retention-*;
  - track-s-first-lull-reopen-native;
  - room-retention-native.pw.
- The bench's explicit opt-in.

**Tolerant (i):** track-m-room-retention-long-room, track-m-{canvas,chat}-long-room and the track-m-apps browser
long room.

**Not affected (i):** packages/node/tests/creator-recovery-pool-gameplay.test.ts (scheduler unit tests). The new
`settled` hook is optional.

### 2.3 Source text

See §1.6. There is no class (ii) source-text pin on the files I change (v3-room.ts, recovery-pool-auto.ts,
examples/v3-room/src/index.ts).

**Readers of examples/v3-room/src/index.ts (i):**
- d110c-0c1f5b0a-settlement-codec-red:740, phase-6b-d110c-0b0-floor-red:53, 0c1f4-bootstrap-policy:102,
  0c1f5b0t-settlement-progress-red:429, 0c1f5b0v-callback-contract:39-130, phase-6a-creator-successor-product-red:245,
  269, fixtures/phase-6a-v3/*, phase-6b-d110c-b/source-shape.mjs:12, phase-5e-v3/creator-live-close-contract.ts:22.
- They look for text from before the room was extracted, so they already fail or pass vacuously.
- Watch: the text `adoptCreatorSuccessor(` must not enter index.ts, or the phase-6a `productExists` guards flip.
  0c1f5b0v:85-118 scans every production file for `onAcceptedVertex`. The binding change adds neither.

### 2.4 Specs and frozen artifacts (ii)

- specs/bounded-storage-lifecycle/slices/14-single-database-watermark-retirement.md:107-118: the default may flip only
  "in a separate final commit, after 14f passes on three engines with no new per-test failures; otherwise it stays
  opt-in". Its :120-148 and :223 also say "opt-in, stage 1a" and "refuses an existing six-database room until 14d".
  Amendment: a status section recording the flip, the routing of existing rooms, the gate and the evidence.
- specs/bounded-storage-lifecycle/requirements-to-evidence.md:376 says "The default host is unchanged". Amend it.
- The status lines in 14a:4-7, 14b:4, 14c:4-6, 14e:4 and 14f:95 say opt-in. Amend them.
- golden-path-guarantees.md:58: G23 cites v3-room.ts:548-553, which was already stale and shifts further. Refresh the
  citation.
- (i): tests/fixtures/phase-2l-d/parity-contract.json:23 and the d110c registry contract. No vector or registry hashes
  the v3-room sources.

### 2.5 The flip against spec 14:107-118 (with the coordinator)

The flip will fail the class (ii) tests in §2.1 until the owner amends them. The rule says the default then stays
opt-in. My plan unless the owner decides otherwise:
- build everything;
- land the flip of the default as its own final commit, in examples/v3-room only;
- run the suites with and without that commit, so the failures and their amendments are exact.

Option (3) from my message would add a binding rule: no `indexedDB` global keeps the base default. It would keep the
six mock-based node REDs green. It is applied only on request.

**Decision (owner, 2026-10-21): option (1), the explicit host; not option (3).**
- The binding exports `createBrowserV3SixDatabaseStorageHost()` (commit "export the six-database storage host").
- Each class (ii) test in §2.1 that relied on the default passes that host explicitly, and nothing else changes: no
  assertion, value or expectation. The d9346 extraction pin (:143) gains the new export. Track X's seal-source
  fixture's "six-database" case passes the explicit host.
- If a test needs more than the explicit host to keep testing what it tests today, I stop and report.
- The amendments are their own commit before the flip, naming the owner's approval and listing every file and line.
- The flip stays the final commit (examples/v3-room only), and also updates the spec status lines (§2.4).
- The suites run with and without the flip commit; with the amendments in place there must be no new per-test
  failure (spec 14:107-118).

## 3. Where the default lives: the browser binding, examples/v3-room/src/index.ts

- **It is the library's host factory for browsers.** It already defines the default host (`browserStorageHost`,
  :59-69) and the opt-in host (`createBrowserV3RoomDatabaseStorageHost`, :112-153). Its `createV3RoomSession`
  (:163-167) is the only place a browser room gets a host when the app passes none.
- **Every shipped app goes through it, so every app gets the default with no app change:** examples/canvas
  (index.ts:200), examples/chat (:314), examples/grid (v3-zone.ts:706), examples/v3-chat (:725) and the bench.
  Changing each example would need Track V's and Track W's files and would miss third-party apps.
- **packages/node is the wrong place.** Its `createV3RoomSession` takes `storageHost` as a required, platform-neutral
  input; it has no IndexedDB and no browser owners. Putting a browser default there would import storage-browser into
  the Node path, and Node hosts (§1.8) must not change.
- **No track owns examples/v3-room** (Track W: examples/chat; Track V: examples/grid and v3-chat; Track Y: canonical,
  protocol-v3, storage values, creator-transition-advance).

**Host selection, in the binding, only when the app passes no `storageHost`:**
1. Read the existing names with `indexedDB.databases()`. Where that is missing, fall back to the non-creating
   open-probe `existingDatabaseVersion`. Neither creates a database, which matters for browser-red.pw:664.
2. If `N` exists at version 7, select the room host with retention. Stray six-database names beside a version-7 `N` do
   not change this, because the room exists.
3. Otherwise, if any six-database name exists, select the six-database host, unchanged. The names are `N` at version
   6 or below, `N--ahe`, `N--drp-live-journal-v1`, `N--drp-snapshot-quarantine-v1`, and
   `${issuanceDatabaseName ?? N}--drp-issuance-v1`. The same names are checked for `rebaseSourceStorage.databaseName`:
   a rebase from a six-database source keeps that host for the whole session, so the room host never meets a
   version-6 source and refuses it.
4. Otherwise it is a new room: select the room host with retention.

**Why it is safe:**
- An existing room is opened by exactly the host and code it was created with, so it is never refused or modified
  (G25: no format change, no two authorities over one layout).
- A new room starts in the format with retention, which Tracks M, O and M2 proved under G1-G28 on the opt-in path,
  with the stated exceptions in §1.1 and §1.4.
- The selection is local mechanics, not authority (G7 and G8): every owner still verifies its own facts. A wrong
  choice can only fail to open: the room host refuses version 6, and the six-database owners refuse version 7 with
  `VersionError`.

## 4. Where the lull scheduling lives

**The mechanism lives in the library, packages/node/src/v3-room.ts.**
- A new session option `recoveryPoolScheduledLull?: boolean` turns it on.
- After a successful creator adoption, or a successful recipient install (Writer or receive-only), the session queues
  one `maintainRecoveryPool()` for the new epoch. It goes into the lifecycle FIFO, right behind the transition that
  produced the epoch, so it runs before any later transition (seal included), with no idle trigger.
- The binding sets the option only when it selects the room host with retention by default (§3). An app may pass
  `false`.
- Rooms on the six-database host, explicit hosts and Node hosts get no scheduling. The bench's explicit opt-in and
  Tracks M, M2, O and S's tests therefore run unchanged (§2.2).
- The mechanism is in the library and every app gets it through the default. No example page changes.

**The edits** (lines in packages/node/src/v3-room.ts at the final head 2a00d915, on base 30cb474e):

| File | Edit | Track X overlap |
|---|---|---|
| packages/node/src/v3-room.ts input type (:564-581) | new option, documented next to `recoveryPoolAutoMaintenance` | none |
| v3-room.ts option validation (:2452) | the option must be a boolean | none |
| v3-room.ts `republishRetainedHistory` (:4161-4186, the second bench fix cd6240fb) | captures the plane it publishes from; the failure classification goes through `retainedPublicationCancelled` (the close rule unchanged, plus the session's own successor) | adjacent: Track X's `setRetainedPublisher` wrapper with `startupGossipRepublicationBarrier` follows at :4188-4198, not edited |
| v3-room.ts `scheduledLulls` construction (:4325-4333) | beside `autoPoolMaintenance` | none |
| v3-room.ts `adoptCreatorSuccessor` (:6753-6763) | `return performCreatorSuccessorAdoption();` becomes `await performCreatorSuccessorAdoption(); scheduledLulls?.schedule();`. The redirect branch delegates, so the inner session schedules | none; `performCreatorSuccessorAdoption` is not edited |
| v3-room.ts `maintainRecipientRecoveryPool` (:6838-6842, the first bench fix fd1b1e09) | the retained-history request after a `maintained` recipient lull also requires `!closed` | none |
| v3-room.ts `installCreatorSuccessor` (:7046) | `scheduledLulls?.schedule();` after `requestMissingRetainedHistory();` (a real install only; an exact repeat schedules nothing) | none; `rebasePromise` and readiness are not touched |
| v3-room.ts `promoteCreatorCheckpoint` (:7096) | `scheduledLulls?.schedule()` after its adoption | none |
| v3-room.ts `session.maintainRecoveryPool` (:7529-7557) | the method goes through `scheduledLulls.run(...)` when on (the existing body is the `lull` closure). Without the option it behaves as before | none; the body still awaits `rebasePromise` and `migrationCompletionBarrier` as before |
| v3-room.ts auto-scheduler start (:7673) | passes `settled: (epoch) => scheduledLulls.settled(epoch)` | none |
| packages/node/src/internal/recovery-pool-auto.ts | optional `settled?(epoch)` in the input; `tick()` skips a settled epoch | none (no other track) |
| new packages/node/src/internal/recovery-pool-scheduled.ts | the per-session bookkeeping: schedule, run, settled, and the proof event | none |
| new packages/node/src/internal/retained-publication.ts | `retainedPublicationCancelled(kind, {terminal, closing, superseded})` | none |

- Track X changed `rebasePromise`, `prepareCreatorOrdinaryReadiness`, `creatorCloseRegistration` and
  `enqueueV3Ingress` (merged into main at 30cb474e, merge 8595826c). None is in this list, and creator-close.ts is not
  touched.
- A textual conflict is possible only if Track X also edits `adoptCreatorSuccessor`, `installCreatorSuccessor`,
  `maintainRecoveryPool` or `republishRetainedHistory`. The transition bodies were reported to the coordinator before
  editing, and the coordinator confirmed (2026-10-21) that Track X's branch edits `rebasePromise`, readiness and
  `enqueueV3Ingress`, not these bodies. `republishRetainedHistory` was reported before the second fix (2026-10-22);
  the coordinator approved it and told Track X, whose current work (a gate on the successor material server, and an
  R5 fix in the journal retirement classes) does not touch it. The stack was rebased onto 30cb474e by cherry-pick
  with no conflict.
- Where a textual conflict could still arise with Track X's next work (lines at the final head 2a00d915):
  - `republishRetainedHistory` :4161-4186, directly above Track X's `setRetainedPublisher` wrapper (:4188-4198). An
    edit to the wrapper is outside my hunk; within git's 3-line context only at :4185-4188.
  - `adoptCreatorSuccessor` :6753-6763. My line `scheduledLulls?.schedule();` (:6762) follows
    `await performCreatorSuccessorAdoption();`. `performCreatorSuccessorAdoption` ends at :6751 with
    `await prepareCurrentCreatorOrdinaryReadiness();` at :6740, 22 lines above. A Track X edit to that readiness
    call, or to its try/catch, is outside my hunk and within git's 3-line context only if it touches :6751-6763.
  - `maintainRecipientRecoveryPool`'s retained-history request :6838-6842 (the close fix). Conflicts only if Track X
    edits the recipient lull's tail.
  - `installCreatorSuccessor` :7046, after `requestMissingRetainedHistory();`. Conflicts only if Track X edits that
    tail (Track X's next work is in the settlement drain and the portable replacement, not here).
  - `promoteCreatorCheckpoint` :7096, `maintainRecoveryPool` :7529-7557 and the scheduler start :7673. Track X's
    `enqueueV3Ingress` is in v3-live.ts and `rebasePromise` is at :5759; neither hunk is near.
  - The input type (:564-581) and validation (:2452): conflicts only if Track X adds an option next to
    `recoveryPoolAutoMaintenance`.
  - The `scheduledLulls` construction at :4325-4333, beside `autoPoolMaintenance`.
  - Any conflict is textual only: the scheduling has no semantic dependency on readiness or the startup order. It
    runs after the transition that produced the epoch, in the FIFO.

**The scheduled lull and Track X's readiness ingress hold (decision row 51, merged at 30cb474e).**
- The hold: `prepareCreatorOrdinaryReadiness(plane)` (creator-close.ts:5008) takes
  `owner.holdIngressForReadiness()` (:5016), which sets the plane registration's `readinessIngressHold`
  (v3-live.ts `holdV3IngressForReadiness`, :8239-8251). `enqueueV3Ingress` (:8180-8199) chains every arrival behind
  it, and the preparation releases it in `finally`.
- Its only caller in the session is `prepareCurrentCreatorOrdinaryReadiness` (v3-room.ts:5750), called in two places:
  the startup task of `rebasePromise` (:5772) and `performCreatorSuccessorAdoption` (:6740). Both run inside a
  lifecycle transition (`enqueueLifetimeTransition`), and both await the preparation, so the hold is released before
  the transition returns.
- The scheduled lull is `session.maintainRecoveryPool()`, requested by `schedule()` at the adoption's (or install's)
  last line and queued as the next lifecycle transition. The FIFO runs it only after the adoption's task has
  returned, so after the hold was released. The creator lull also awaits `rebasePromise` (:7538) before it takes its
  barrier, so it cannot run beside the startup preparation either.
- The lull's own readiness capture (`runOrdinaryReadinessMaintenance`'s deferrable `after` step,
  `captureCreatorOrdinarySourceWithoutForecast`) is unchanged and does not take the hold: it runs in the plane's
  FIFO slot, where arrivals wait as in any lull (G23, the pre-existing mechanism).
- So the overlap cannot be reached by construction. tests/track-z-scheduled-lull-readiness-hold.test.ts pins it on
  Track X's settlement room (node SQLite host, unchanged fixture): with the scheduled lull turned on for the creator
  and every adoption's readiness capture held 300 ms inside the hold, 4 epochs give exactly one scheduled lull per
  epoch, each starting as its adoption returns (after the hold ended) and none overlapping any adoption.

**No double lull:**

| Source | Behaviour |
|---|---|
| Scheduled | One per epoch. `schedule()` records the epoch it queued for, and a repeat for the same epoch is ignored. |
| Explicit `maintainRecoveryPool()` | With the option on, a call in an epoch that a lull already settled (maintained, not-needed or deferred:unsupported) returns that result at once: no barrier, no turnover, no readiness capture, no proof event. A call before the scheduled lull runs is an ordinary lull; the scheduled one then finds the epoch settled and returns without running. A deferred:busy result does not settle, so a later explicit call runs normally. Without the option, explicit calls are unchanged. |
| `recoveryPoolAutoMaintenance` (the idle scheduler) | Its tick skips an epoch the scheduled lull settled, through the new `settled` hook, so it neither calls nor reports. If the scheduled lull was deferred:busy, the idle scheduler may run it later, which is its existing job. The idle scheduler stays opt-in and creator/Writer only. Receive-only recipients get the scheduled lull alone. |
| Seal | Unchanged. Its inline maintenance is still the hard-cap backstop when no lull maintained the pool. |

**Observation:** each lull the scheduling runs emits the proof event
`{kind: "recovery-pool-lull", trigger: "scheduled" | "explicit", epoch, result, ms}` through the existing
`__warmProofEvent` observer, only when the option is on. The REDs count these events.

**Failure handling:**
- The scheduled call's rejection is caught and observed, never thrown into the app.
- The room's own rules apply as for an explicit lull: a recipient failure sets `creatorRecipientRecoveryRequired`,
  and the next install recovers; the creator owner's failure handling is unchanged.
- Close joins the FIFO, and the queued lull fails fast on `assertSessionOpen()`.
- A lull already running when the app closes the room (found by the bench at the new default, step 5): close sets
  `closed` and revokes the transport at once, then waits for the FIFO, so the running lull finishes after the
  revocation. The recipient lull's tail asked the revoked transport for retained history after a `maintained`
  result; on the healthy native Grid bench that failed the persisted close 2 of 2. The request now also requires
  `!closed` (fd1b1e09), the guard the resumed recipient boundary and `requestMissingRetainedHistory` already apply; a
  closed session needs no repair, since the next open requests retained history itself. The same would happen to an
  app's explicit recipient lull in flight at close (pre-existing, rare without scheduling).
  tests/track-z-scheduled-lull-close.test.ts (a012f33e) is its RED: a recipient (Canvas receive-only, Chat Writer)
  closed during its epoch-6 scheduled lull makes no retained-history request after the close.
- A peer's retained-history request served across this session's own successor (the second bench finding, step
  5): a recipient's scheduled lull ends `maintained` right after its install and asks every peer for retained
  history, while other recipients install or the creator adopts the next epoch. A peer serves the request through
  `republishRetainedHistory` from its current plane; its adoption or install activates the successor plane
  (`activateV3LivePlane`, which marks the old registration inactive), so a send in flight ends
  `publication-state-unknown` and a publication that starts in the activation window ends `not-active`. Outside a
  close the publisher rejected both, and the bench's strict worker transport counts a publisher rejection as an
  operation failure: 3 of 6 default runs failed their persisted close. It is pre-existing (any explicit or
  missing-history request that lands on a transition does the same); the scheduled lull makes it frequent.
  `republishRetainedHistory` (v3-room.ts:4161-4186, cd6240fb) now captures the plane it publishes from and treats
  those two kinds as a cancellation only when the session has moved past that plane or an adoption or install
  (`creatorSuccessorAdoptionTask`) is in flight, and there is no terminal failure. The close rule (f9828cd0) is
  unchanged; both rules live in `retainedPublicationCancelled` (internal/retained-publication.ts). publish-failed on
  a current plane, store, record and admission faults, and everything after a terminal failure still reject.
  The requester loses nothing: the rows the retired plane served are in the successor's cut, or their author
  rebases them into the successor. The shipped transport ignores a publisher rejection and retries one retained
  request 7 times over 15 s. tests/track-z-retained-publication-successor.test.ts (ebea1023) is its RED, with
  guards for publish-failed on a current plane and not-active with no successor;
  packages/node/tests/retained-publication-cancel.test.ts checks every kind against every state.

**Risks to measure in step 5:**
- The creator's lull runs right after adoption, overlapping the recipients' installs, which read the creator's
  snapshot material while the lull holds a room transaction.
- Moves during the lull wait. That is addition 3's measurement.

## 5. RED plan (step 3, new files only)

tests/track-z-room-database-default.test.ts (fake-indexeddb, process Web Locks, shipped Canvas and Chat compositions):
1. A new room with default options is created on one version-7 database, with no six-database name, and retains by
   room retention (`room-retention-pass` events).
2. A six-database room is created with an explicit six-database host, run 1 epoch (the recipient has no base
   database) and 2 epochs, then reopened with default options. It reopens on six databases: same names and versions,
   no version-7 database, same state. It plays on, and runs no scheduled lull.
3. On a default new room, the creator and the recipient each run exactly one lull per epoch, with no explicit call and
   no idle trigger (`recoveryPoolAutoMaintenance` off). Canvas has a receive-only recipient and Chat a Writer. From
   epoch 3 the creator's lull is not deferred. An explicit call after it returns the same result with no second lull.
4. Node SQLite: a room on `createNodeV3RoomStorageHost` emits no lull and no retention events.

packages/node/tests/recovery-pool-scheduled-lull.test.ts:
- the idle scheduler with `settled` never calls `maintain` for a settled epoch;
- the bookkeeping: one per epoch, short-circuit, and busy does not settle.

14c: deferred by the owner (§1.1), so no 14c RED is written. The brief's 14c RED ("the fence is written as step A
and checked on open, including a crash between the two") is recorded as remaining, with what it needs.
