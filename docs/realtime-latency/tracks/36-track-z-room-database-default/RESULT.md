# Track Z: the room database with retention becomes the default for new rooms

- Worktree: `<worktree agent-a869e104e72e01ff1>/`, branch `worktree-agent-a869e104e72e01ff1`, on main at
  **0171994d** (Track W2 merged). Most proofs ran on main at 30cb474e (Track W's Chat window, Track X's seal deadlock
  fix, and Track X's startup order and readiness ingress hold, merge 8595826c), before the rebase onto 0171994d,
  which changes no file the stack touches (§13). Nothing was pushed.
- Working notes: `<evidence>/track-z/PROGRESS.md`. Map: `<evidence>/track-z/MAP.md`. Logs: `<evidence>/track-z/logs/`.
  Scripts: `<evidence>/track-z/bin/`. Bench runs: `<evidence>/track-z/grid/`. 14f runs: `<evidence>/track-z/f14/`.
  Reopen evidence: `<evidence>/track-z/reopen/`. Comparison trees (detached worktrees, each installed and built the
  same way): `<evidence>/track-z/base2/` (30cb474e); `<evidence>/track-z/noflip2/` (7852749a, the amendments commit
  of the first stack, the one before the flip); `<evidence>/track-z/head2/` (e6ebaec6, the flip before the two
  bench-found fixes of §5.8); `<evidence>/track-z/head3/` (7c491531, with the close fix); and
  `<evidence>/track-z/head4/` (2a00d915, with both fixes: the final code at 30cb474e). After the rebase:
  `<evidence>/track-z/base3/` (0171994d), `<evidence>/track-z/head5/` (1c7ee87b, the rebased flip),
  `<evidence>/track-z/noflip3/` (510c3000, the rebased amendments) and `<evidence>/track-z/storage3/` (head5 plus the
  storage scratch diff, §9).
- Tree hashes (e6ebaec6, 7c491531, 2a00d915 and the like) are the commits as they stood when each run was made.
  The stack was re-applied by cherry-pick to put each bench-found fix before the amendments and the flip, onto
  0171994d, and once more to insert this RESULT.md before the last two commits. Commit hashes elsewhere in this file
  are the final ones (§2 maps them to the 30cb474e stack). The amendments' and the flip's final hashes are in the
  hand-back.
- Guarantee ids (G1–G28) refer to the
  [golden-path guarantee checklist](../../../../specs/bounded-storage-lifecycle/golden-path-guarantees.md).
- "Base" is 30cb474e, or 0171994d where a section says so. "Head" is the flip commit. "No flip" is the commit
  before it (the amendments).
- An earlier round of these proofs ran on main at ebf4254f, before Track X's readiness work merged (trees `base/`,
  `noflip/`, `head/`, logs `s5-*`, `z-B-*`, `z-F-*`). Every figure below is from the rebased stack at 30cb474e unless
  it says otherwise.

## 1. Outcome

**Done.** A new browser room created through the binding with no `storageHost` now lives in one version-7 room
database with retention. The library runs the recovery-pool lull once per epoch on it: the creator's after its
adoption, and every recipient's after its install, receive-only recipients included. Existing rooms open on the host
they were created on, with no migration. Node hosts and explicit hosts are unchanged.

- **Latency, shipped pages on real networking** (new default against the shipped default, the same session, comparable
  load, §6):
  - seal 2974 → 296 ms (Canvas), 3233 → 266 ms (Chat), 2798 → 278 ms (Grid);
  - install 1695 → 284, 1774 → 266, 1722 → 308 ms;
  - adoption unchanged (out of scope).
- **Play during the scheduled lull** (§7): a move waits only for the lull's remainder and then costs an ordinary move
  (steady remainder p50 52-241 ms, at most 1.7 s). The stop condition of addition 3 was not met.
- **The bench** (§8), default mode at the final code: 6 of 6 runs pass; seal 1282 → 240 ms, install 1009 → 421 ms.
  The opt-in mode is unchanged (within 6%, 2 of 2 on each side).
- **Two pre-existing faults that the bench found on the new default** were fixed before the flip, each with a RED
  (§5.8): a recipient lull running at close asked the revoked transport for retained history; and a peer's own
  adoption or install made a retained publication reject. The requester loses nothing in either case.
- **Costs:**
  - reopen on the room database: 0.83 s against 0.27 s on six databases (the room host's open path, the same in the
    opt-in mode; §8);
  - the first retirement round, once per room: 2.3-5.4 s in the creator's lull at epoch 5 (§14);
  - moves made during a lull wait for its remainder (§7).
- **14c** is deferred by the owner (§5.4).
- **Pins:** the owner-approved explicit-host amendments (13 files) are the last commit but one (§5.5). The flip is
  the last commit.
- **Storage** is flat over 100 epochs, for Canvas, Chat v4 and Chat v5. The heap matches Track Y's head without the
  lull (§9).
- **14f** passes on Chromium, Firefox and WebKit, case 11 included (§11).
- **Suites** (§12): no new failure against base, compared per test, in any set: node, storage-browser,
  storage-node, canonical/protocol-v3/storage, the startup-discovery observers, the 149-file root set (Tracks K-X and
  Z), Canvas and Chat e2e, and d9346. `pnpm -r typecheck`: 0 errors; the shadowed-sources guard is clean.
- **Rebased onto 0171994d (Track W2)** (§13): shipped Chat's new v5 rooms get the new default too, and no W2 test
  needs the explicit six-database host, so no new amendment is needed.
  - W2's Playwright test passes at the rebased head, 2 of 2.
  - W2's vitest files are unchanged per test against 0171994d.
  - Shipped v5 Chat at the new default: seal 2694 → 260 ms, install 1507 → 236 ms.

## 2. Commits

In order on the branch, on main at 0171994d. The last two commits are the owner-approved amendments and then the flip
(spec 14:107-118 asks for the flip as a separate final commit). This RESULT.md is committed just before those two, so
their hashes are given in the hand-back, not here. The same commits on 30cb474e, where most proofs ran (§13):
8e2156fc = 97bb2cd8, a3a36360 = 556e48fa, 5e9666fa = 5f767342, d38a973e = c2399cc9, 13ce5c3f = a9a1cca6,
1e9558ae = a3bc3f9f, e8a5c3d6 = e99fcd48, 9e54c01a = 0213e585, 38b4611c = 727ad520, f6c1b41f = 0760640b,
97c75635 = a9d1b30b, 8ec357a2 = a3a4d3ce, 4cdc057c = a012f33e, eb693ca4 = fd1b1e09, d94bdb4c = ebea1023,
45e0ea52 = cd6240fb; the amendments were aa0bff21 and the flip 2a00d915.

| Commit         | Kind                             | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 8e2156fc       | measurement only                 | Per-window phase probe for the shipped-page long rooms (`TRACK_Z_PHASES`) and an explicit harness lull (`TRACK_Z_LULL`). Step 1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| a3a36360       | measurement only                 | The Grid long room's rollover is bounded and names the hung step. Step 1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 5e9666fa       | measurement only                 | A hung rollover prints its step and last completed spans. Step 1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| d38a973e       | measurement only                 | Retention and retirement proof events counted per reason. Step 1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 13ce5c3f       | RED                              | `tests/track-z-room-database-default.test.ts` (+ `tests/fixtures/track-z/default-room.ts`): a new Canvas (receive-only) or Chat (Writer) room with default options lives in one version-7 room database, retains by room retention, and each role runs exactly one lull per epoch with no explicit or idle trigger; guards: a six-database room reopens on its own host unchanged with no scheduled lull, and a Node SQLite room is unchanged. `packages/node/tests/recovery-pool-scheduled-lull.test.ts`: the bookkeeping and the idle scheduler's `settled` hook. At base the two default-room cases fail; the guards pass. |
| 1e9558ae       | library (node)                   | `recoveryPoolScheduledLull` (opt-in, off by default): after a creator adoption, a checkpoint promotion or a recipient install (Writer or receive-only), the session requests its own `maintainRecoveryPool()` once for the new epoch, in the lifecycle FIFO. New `packages/node/src/internal/recovery-pool-scheduled.ts`; the idle scheduler skips a settled epoch.                                                                                                                                                                                                                                                           |
| e8a5c3d6       | library (browser binding)        | Host routing by creation layout in `examples/v3-room/src/index.ts`: with no `storageHost`, a room opens on the host it was created on. New rooms still six databases in this commit. The bench's census observers follow the room's layout (measurement only).                                                                                                                                                                                                                                                                                                                                                                |
| 9e54c01a       | measurement only                 | Lull windows and per-move issue and first-seen times in the long-room harnesses (addition 3).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 38b4611c       | measurement only                 | `TRACK_Z_WRITER_FIRST=1` in Track V's Grid harness: each epoch starts with the Writer's move, so play during both roles' lulls is measured on the Grid (addition 3).                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| f6c1b41f       | library (browser binding)        | Exports `createBrowserV3SixDatabaseStorageHost()` (owner's option 1).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 97c75635       | docs                             | The scheduled lull's doc (moves wait, none dropped) and the G23 citation (`v3-room.ts:563-580`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 8ec357a2       | test                             | `tests/track-z-scheduled-lull-readiness-hold.test.ts`: the scheduled lull never runs while an adoption's readiness preparation holds ingress (Track X's hold, §5.3).                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 4cdc057c       | RED                              | `tests/track-z-scheduled-lull-close.test.ts`: a recipient (Canvas receive-only, Chat Writer) closed while its epoch-6 scheduled lull runs makes no retained-history request after the close. Fails before eb693ca4, with and without the flip (§5.8).                                                                                                                                                                                                                                                                                                                                                                         |
| eb693ca4       | library (node)                   | The recipient lull's retained-history request after a `maintained` result also requires `!closed` (§5.8).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| d94bdb4c       | RED                              | `tests/track-z-retained-publication-successor.test.ts`: a retained publication cancelled by the session's own adoption (creator, a send held across it: `publication-state-unknown`) or install (Writer, a publication started in its activation: `not-active`) resolves; guards: `publish-failed` on a current plane and `not-active` with no successor still reject. The two cancellation cases fail before 45e0ea52; the guards pass (§5.8).                                                                                                                                                                               |
| 45e0ea52       | library (node)                   | `republishRetainedHistory` captures its plane; new `packages/node/src/internal/retained-publication.ts` (`retainedPublicationCancelled`) holds the close rule (f9828cd0, unchanged) and the successor rule; `packages/node/tests/retained-publication-cancel.test.ts` checks every kind against every state (§5.8).                                                                                                                                                                                                                                                                                                           |
| (this)         | docs                             | This RESULT.md, and G23's v3-room.ts citation moved by one line (:564-581) for the import that 45e0ea52 added.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| (last but one) | test amendments (owner-approved) | The class (ii) tests that relied on the default pass the explicit six-database host; nothing else changes (§5.5).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| (last)         | **the flip**                     | `NEW_ROOM_LAYOUT = "room"`: a new browser room with no `storageHost` is created in the room database with retention and the scheduled lull. Spec status lines updated (§5.6). examples/v3-room and specs only.                                                                                                                                                                                                                                                                                                                                                                                                                |

Scratch branches (never merge): `track-z-measure`, `track-z-optin` (step 1, old base), `track-z-flip-probe` (the flip
before the amendments, to find what it breaks), `track-z-nolull2` (the flip plus a page global that turns the
scheduled lull off, for addition 3's "flip without the lull" arm; `track-z-nolull` is the same at the old base), and
`track-z-stack-1` to `track-z-stack-5` (backups of the stack before each re-application; `track-z-stack-5` is the
stack at 30cb474e with both fixes, 2a00d915).

## 3. Step 1: what the flip buys on the shipped pages (summary of the hand-back)

Real networking, Chromium, 16 epochs, 2 runs per arm, medians over epochs 5-16, at 24d4ca61 with measurement-only
scratch builds (`<evidence>/track-z/data/compare-all.txt`).

- **The room host with retention alone does not reach the bench's figures.** It cuts the seal from 2.7-3.1 s to
  0.74-0.87 s and the install from 1.4-1.9 s to 0.37-0.49 s.
- **The lull moves seal and install; retention makes the lull affordable.** With a lull after each install, all three
  pages reach the bench: seal 0.25-0.30 s, install 0.21-0.26 s. On the six-database host the same lull costs
  2.5-2.6 s (creator) and 1.1 s (recipient) per epoch; with retention 0.40-0.46 s and 0.15-0.22 s.
- **The library's idle lull almost never fires in continuous play** (1, 2 and 0 of 32 creator epochs on Canvas, Chat
  and Grid), because its trigger needs a 1 s quiet tick; receive-only recipients never get it. Hence the owner's
  choice to schedule the lull every epoch on the new default (addition 1).
- **Adoption does not change with the host or the lull** (settlement publish plus the readiness capture, 0.5-0.7 s):
  a later track, after Track X's startup fix.
- **The first retirement round is slow once per room** (2.1-2.8 s): retention declines the room's earliest epochs
  (`ahe-birth`, `journal-same-epoch`, `signing-same-epoch`) and the existing per-class path runs. A later track.

| Page   | Arm                                   | Seal | Adoption | Install | Creator lull | Recipient lull |
| ------ | ------------------------------------- | ---- | -------- | ------- | ------------ | -------------- |
| Canvas | A shipped (six databases, no lull)    | 2654 | 733      | 1442    | -            | -              |
| Canvas | B room+retention, no lull             | 758  | 730      | 367     | -            | -              |
| Canvas | C B + explicit lull                   | 254  | 746      | 206     | 396          | 151            |
| Chat   | A shipped                             | 3125 | 776      | 1606    | -            | -              |
| Chat   | B room+retention, no lull             | 870  | 988      | 443     | -            | -              |
| Chat   | C B + explicit lull                   | 298  | 876      | 226     | 435          | 167            |
| Grid   | A shipped (legacy creator-trusted-v1) | 3104 | 440      | 1912    | -            | -              |
| Grid   | B room+retention, no lull             | 736  | 424      | 491     | -            | -              |
| Grid   | C B + explicit lull                   | 281  | 465      | 264     | 457          | 222            |

(ms; load 20-270 during step 1.)

## 4. The map (step 2), in brief

The full map is `<evidence>/track-z/MAP.md`. Prerequisites:

| Prerequisite              | Status at base                                                                        | Outcome                                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 14a room database         | Done (Track R3), opt-in                                                               | The default for new rooms                                                                                                             |
| 14b retention trust       | Done on the opt-in path (Tracks M, O, M2)                                             | On for every new room                                                                                                                 |
| 14c per-owner floor fence | Storage only, opt-in (`retirementFences: true`); nothing in node or examples calls it | **Deferred by the owner** (§5.4): a counterexample blocks wiring it as written                                                        |
| 14d migration             | Not implemented; the room host refuses a version-6 room                               | **Not needed**: existing rooms are routed to their own host, so nothing is migrated and nothing meets the refusal                     |
| 14e bounds                | The 512-write cap is policy pending review                                            | Unchanged; above about 85 signers a unit is over the cap and that boundary takes the existing per-class path (§14)                    |
| 14f native evidence       | Cases 1-8 and 10-11 had passed on the opt-in path (Tracks R3, M, O, M2)               | Rerun at the flip: §11                                                                                                                |
| Node SQLite hosts         | `createNodeV3RoomStorageHost` has no `openRoomRetirement`                             | Unchanged by construction: Node callers pass `storageHost`, and the default and the lull live in the browser binding; a RED guards it |
| Source-text node tests    | Read v3-room.ts and CRD text                                                          | CRD and v3-live.ts are not touched; the v3-room.ts readers' strings are kept verbatim (MAP §1.6)                                      |

**Pins.** Classes: (i) unaffected, (ii) never edit (amendment listed for the owner), (iii) code or ordinary fixture.
The pins that build default-host rooms and read the six-database layout (MAP §2.1) were all class (ii) or fed class
(ii) tests. The owner chose option (1), an explicit six-database host (§5.5). The lull scheduling has no class (ii)
pin, because it is gated on the binding's selection: every explicit-host retention test (Tracks M, M2, O, S, the
bench's opt-in) runs unchanged (MAP §2.2). Spec status lines were amended in the flip commit (§5.6).

## 5. The flip

### 5.1 Where the default lives: the browser binding

`examples/v3-room/src/index.ts`, the library's browser host factory. It already defined the default host and the
opt-in room host, and its `createV3RoomSession` is the only place a browser room gets a host when the application
passes none. Every shipped app (Canvas, Chat, Grid, v3-chat) and the bench go through it, so all of them get the new
default with no app change, and so would third-party apps. `packages/node`'s `createV3RoomSession` takes
`storageHost` as a required, platform-neutral input with no IndexedDB, so a browser default there would pull
storage-browser into the Node path. No track owns examples/v3-room.

### 5.2 Host selection (only when the application passes no `storageHost`)

`existingRoomLayout` (index.ts:214-230) reads the room's database names with `indexedDB.databases()`, or, where that
is missing, with the existing non-creating probe. Neither creates a database.

1. Main database `N` at version 7: the room host with retention (an existing room-database room).
2. Otherwise any six-database name: `N` at another version, `N--ahe`, `N--drp-live-journal-v1`,
   `N--drp-snapshot-quarantine-v1`, `${issuance}--drp-issuance-v1`, or the same names of a rebase source. Then the
   six-database host, unchanged (a recipient may have no `N` yet, so every name is checked).
3. Otherwise a new room: `NEW_ROOM_LAYOUT`, which the flip sets to `"room"`: the room host with retention and
   `recoveryPoolScheduledLull: true` (an app may pass `false`).

The selection is local mechanics, not authority (G7, G8). A wrong choice can only fail to open: the room host refuses
a version-6 `N` with `V3_ROOM_DATABASE_MIGRATION_UNAVAILABLE`, and the six-database owners refuse version 7. An
existing room is opened by exactly the host and code it was created with, so it is never refused or modified
(G25: no format change, no second authority over one layout). Shown in a real browser in §10.

### 5.3 The scheduled lull (addition 1)

**Where it lives.** In the library, `packages/node/src/v3-room.ts`, behind the session option
`recoveryPoolScheduledLull` (off by default), with the bookkeeping in
`packages/node/src/internal/recovery-pool-scheduled.ts`. The binding turns it on only when it selects the room host
with retention by default. Six-database rooms, explicit hosts and Node hosts get no scheduling, so a six-database room
runs no lull it did not run before (a RED guards this).

**When.** Right after a successful creator adoption (`adoptCreatorSuccessor`, and `promoteCreatorCheckpoint`) and a
successful recipient install (`installCreatorSuccessor`, Writer or receive-only), still inside that transition's
lifecycle task, the session calls its own `maintainRecoveryPool()`. The call joins the lifecycle FIFO directly behind
the transition that produced the epoch, so the lull runs before any later transition (the next seal included), with
no idle trigger. The lull body is today's explicit lull, unchanged.

**No double lull.**

| Source                                         | Behaviour with the option on                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scheduled                                      | At most one request per epoch (`schedule()` records the epoch it queued for).                                                                                                                                                                                                                                                     |
| An app's explicit `maintainRecoveryPool()`     | In an epoch whose lull settled (`maintained`, `not-needed` or `deferred:unsupported`) it returns that result at once: no barrier, no turnover, no second readiness capture. Called before the scheduled lull runs, it is the epoch's lull and the scheduled one then returns the settled result. `deferred:busy` settles nothing. |
| `recoveryPoolAutoMaintenance` (idle scheduler) | Its tick skips an epoch the scheduled lull settled, through a new optional `settled` hook. If the scheduled lull was `deferred:busy`, the idle scheduler may run it later, its existing job. It stays opt-in and creator/Writer only.                                                                                             |
| Seal                                           | Unchanged: its inline maintenance stays the hard-cap backstop when no lull maintained the pool.                                                                                                                                                                                                                                   |

**Moves during the lull** wait behind it and are admitted right after it; none is dropped (G23: ingress queues FIFO
during any deferrable lull). §7 measures it.

**Failure.** The scheduled call's rejection is caught and observed (`recovery-pool-lull` proof event with
`result: "failed"` and the cause), never thrown into the app; the room's own rules apply as for an explicit lull. A
lull still queued when the app closes the room fails fast with "v3 room session is closed" and does not delay the
close (§10).

**Track X's readiness ingress hold (merged at 30cb474e): the lull never runs while it is held.** Track X's
`prepareCreatorOrdinaryReadiness` (creator-close.ts:5008) holds every arrival on the creator's plane
(`holdIngressForReadiness`, :5016; v3-live.ts `holdV3IngressForReadiness` :8239-8251, read by `enqueueV3Ingress`
:8180-8199) until the preparation ends, and releases it in `finally`. The session calls it in two places only, both
inside a lifecycle transition that awaits it: the startup task of `rebasePromise` (v3-room.ts:5772) and
`performCreatorSuccessorAdoption` (:6740). The scheduled lull is requested at the adoption's last line and runs as
the next lifecycle transition, so it starts only after the adoption returned, after the hold was released; the
creator lull also awaits `rebasePromise` (:7538) before taking its barrier. The lull's own readiness capture
(`captureCreatorOrdinarySourceWithoutForecast`, the deferrable step of every lull) does not take the hold; arrivals
wait for it in the plane's FIFO as in any lull (G23, pre-existing). The overlap therefore cannot be reached.
`tests/track-z-scheduled-lull-readiness-hold.test.ts` (8ec357a2) pins it on Track X's settlement room (node SQLite
host, Track X's fixture unchanged): the lull is turned on for the creator, and every adoption's readiness capture is
held 300 ms inside the hold. Over 4 epochs there is exactly one scheduled lull per epoch, each starts as its adoption
returns, and none overlaps any adoption (passes, 7.9 s; `<evidence>/track-z/logs/z-readiness-lull-2.log`).

**Overlap with Track X's code.** Track X edited `rebasePromise`, `prepareCreatorOrdinaryReadiness`,
`creatorCloseRegistration` and `enqueueV3Ingress`; none is touched here, and creator-close.ts is not touched. The
stack was rebased onto Track X's merge with no conflict. A textual conflict with Track X's next work can arise only
where it also edits these hunks of v3-room.ts (lines at the final code, 2a00d915): `adoptCreatorSuccessor`
:6753-6763 (the new `scheduledLulls?.schedule();` at :6762, 22 lines below the readiness call at :6740), the recipient
lull's retained-history request (:6838-6842, §5.8), the tail of `installCreatorSuccessor` (:7046),
`promoteCreatorCheckpoint` (:7096), `maintainRecoveryPool` (:7529-7557), the idle scheduler's start (:7673), the
input type (:564-581), the option validation (:2452), the `scheduledLulls` construction (:4325-4333) and
`republishRetainedHistory` (:4161-4186, §5.8). That last hunk sits directly above Track X's `setRetainedPublisher`
wrapper (:4188-4198), which is not edited; the coordinator approved the edit and told Track X before it was made.
`rebasePromise` (:5759) is not near any of them. Any conflict is textual only: the
scheduling has no semantic dependency on readiness or on the startup order beyond the FIFO order above.

### 5.4 14c: deferred by the owner

- **Counterexample to wiring 14c's open check as written.** On the retention host, the first retirement round of every
  room runs the existing per-class path, not retention (retention declines while any owner control is unborn, and on
  `ahe-birth` and `*-same-epoch`), and so does every later decline (`unit-over-cap`, `floor-fence-unavailable`,
  `session-unsupported`, any `RETENTION_*` refusal). That path advances the owner controls and writes **no per-owner
  fence**. 14c's open check accepts only control = target, control = base, or no entry for a 14d migration copy;
  anything else fails closed with `RETENTION_FENCE_MISMATCH` and is never repaired. With no migration, every room
  would therefore fail closed after its first retirement round, against G3; and the next `fenceRetirement` would
  refuse `ROOM_HEAD_FENCE_CONFLICT`, so retention would never run again.
- **14c is inert on every floor we run.** The shipped pages take their floor from the app host; in Track X's and
  Track V's harnesses and in the e2e tests that is the Node SQLite floor over RPC, which has `fenceDecision` but no
  `fenceRetirement` (14c puts the SQLite floor out of scope). The bench's browser floor does not enable
  `retirementFences`, and the library cannot enable it on a floor the host supplies.
- **What protects rooms today:** Track M's step A, `fenceDecision(labels)`: one floor transaction committing
  `{throughEpoch, decisionDigest, sourceProofDigest}` before `applyRetention`
  (packages/node/src/internal/creator-closed-rollback-data.ts:20951-20976), with the `floor-fence-unavailable` decline
  when a floor lacks it (:20979-20984); and Track M's trust RED 4 (a mark claiming more retirement than the floor fails
  closed at open).
- **What full wiring needs (option a):** a fence for every owner-control change on the room host, the existing path
  included; a new storage-browser session read of the five control digests inside the held transaction; step A before
  each room checkpoint or commit; the open check with "no entry" consistent until that owner's first fence (a class
  (ii) amendment to 14c's text); a floor option in the fixtures; and the three-engine 14c RED #2.
- 14c stays a remaining item, to revisit if an IndexedDB floor ships.

### 5.5 The pins: owner-approved amendments (the last commit but one)

The owner approved option (1): the binding exports `createBrowserV3SixDatabaseStorageHost()` (f6c1b41f) and each
class (ii) test that relied on the default passes it explicitly, with no other change (no assertion, value or
expectation). No test needed more than the explicit host. Every amended line:

| File                                                                              | Lines                                                                                        |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| tests/phase-3a1b-d9346-room-semantics-red.test.ts                                 | :61 (`storageHost` in the expected input type), :314 (the host), :453 (passed in `input()`)  |
| tests/phase-3g-v3-room-rebase-red.test.ts                                         | :315 (the host), :461 (passed in `roomInput`)                                                |
| tests/phase-3h-v3-room-rehearsal-red.test.ts                                      | :425 (import), :443 (passed)                                                                 |
| tests/phase-6b-d110c-0c1f5b0c-room-red.test.ts                                    | :417 (the host), :498 (passed)                                                               |
| tests/phase-6b-d110c-0c1f5b0u-room-runtime-red.test.ts                            | :19 (import), :345 (passed)                                                                  |
| tests/phase-6b-d110c-0c1f5b0u-successor-replay-red.test.ts                        | :13 (import), :196 (passed)                                                                  |
| tests/phase-3a1b-d9346-v3-room-extraction-red.test.ts                             | :144 (the new export in the sorted export pin)                                               |
| tests/fixtures/grid-room-workload.ts                                              | :25 (import), :865 (passed)                                                                  |
| tests/fixtures/track-x/seal-source-room.ts                                        | :14 (import), :27-28 (comment), :108-109 (the "six-database" case passes the explicit host)  |
| tests/fixtures/startup-discovery/room.ts                                          | :9 (import), :187 (passed in `roomInput`; the healthy-grid bench keeps the default)          |
| tests/fixtures/startup-discovery/shipped.ts                                       | :12 (import), :126 (the direct Canvas room; the shipped Chat and Grid apps keep the default) |
| packages/storage-browser/tests/fixtures/product-browser-server.ts                 | :78 (import), :91 (the dependencies carry the factory)                                       |
| packages/storage-browser/tests/assets/phase-6a-creator-successor-product-entry.ts | :103 (the dependency's type), :1386 (passed)                                                 |

Lint counts are unchanged against base for all 13 files. The d9346 extraction pin still fails, as at base, because
two other exports already existed before this track.

### 5.6 Spec status lines updated in the flip commit

- specs/bounded-storage-lifecycle/slices/14-single-database-watermark-retirement.md: new section "Status (Track Z,
  2026-10-21): the browser default for new rooms".
- slices/14a-retention-database-format.md:8-11; 14b-retention-trust.md:5-7; 14c-host-floor-retirement-fence.md:7-11
  (deferred, with the counterexample); 14d-retention-migration.md:7-10 (no migration needed);
  14e-retention-bounds-and-charges.md:5-7; 14f-retention-native-evidence.md:7-11 (this track's rerun).
- requirements-to-evidence.md:376: "The default host is unchanged." is replaced by the new default.
- Earlier, in 97c75635: golden-path-guarantees.md G23's citation (`v3-room.ts:563-580`, was the stale :548-553),
  moved to :564-581 in this RESULT.md's commit (45e0ea52 added one import line above it). G23's two v3-live.ts
  citations predate this track and are left as they are.

### 5.7 Why it is safe

- **G1-G28 on the new default** are what Tracks M, O and M2 proved on the opt-in path (room database with retention),
  with 14c deferred (§5.4) and the 512-write cap's fallback (§14). The flip adds no storage format, no authority and
  no transaction; it changes which host a new room is created on, and adds one lull per epoch through the existing
  explicit lull.
- **Existing rooms** keep their host and code (G25), so nothing that was safe before changes for them (§10).
- **Node SQLite hosts** are untouched: they always pass `storageHost`, and the scheduling is off unless the binding
  selects it (RED guard).
- **G23**: moves that arrive during the scheduled lull wait FIFO and are admitted right after it (§7).
- **G2/G21**: the lull is the bounded explicit lull; a refusal retains and existing backpressure applies.

### 5.8 Two faults the bench found on the new default, fixed before the flip

The healthy native Grid bench (§8) failed its persisted close on the new default, for two different reasons, one
after the other. Both are pre-existing paths that the scheduled lull makes frequent. Each has a RED and its own fix
commit, before the amendments and the flip. Neither touches a guarantee: both decide what a session does with a
retained-history repair that it no longer needs (1) or can no longer serve (2).

**1. A recipient lull running at close asked the revoked transport (RED 4cdc057c, fix eb693ca4).**

- `closeSession` sets `closed` and revokes the transport synchronously, then waits for the lifecycle FIFO, so a lull
  already running finishes after the revocation.
- The recipient lull's tail asks every peer for retained history after a `maintained` result
  (`maintainRecipientRecoveryPool`, v3-room.ts:6838-6842).
- On the bench's strict worker transport that request after close failed the persisted close ("no history work after
  original producer close") in 2 of 2 default runs at e6ebaec6.
- The request now also requires `!closed`, the guard that the resumed recipient boundary and
  `requestMissingRetainedHistory` already apply. A closed session needs no repair: the next open asks for retained
  history itself.
- The same could happen before this track to an app's explicit recipient lull in flight at close.
- `tests/track-z-scheduled-lull-close.test.ts` closes a recipient (Canvas receive-only, Chat Writer) while its epoch-6
  scheduled lull runs. Before the fix it saw 1 request after the close, with and without the flip; after it, none.

**2. A retained publication that the session's own successor cancels (RED d94bdb4c, fix 45e0ea52).** With fix 1, the
default mode at 7c491531 still failed 3 of 6 runs, with a new message at the persisted close: "v3 room retained
publication failed: publication-state-unknown" (2 runs) or "…: not-active" (1 run).

- A recipient's scheduled lull ends `maintained` right after its install and asks every peer for retained history.
  Meanwhile the other recipient installs, or the creator adopts the next epoch.
- A peer serves the request through `republishRetainedHistory` (v3-room.ts:4161-4186) from its current plane.
- The peer's own adoption or install activates the successor plane (`activateV3LivePlane`, v3-live.ts:20111; the hot
  handoff marks the old registration inactive, :20341-20366). A send already in flight then ends
  `publication-state-unknown` (v3-live.ts:16530-16537). A publication that starts in the activation window ends
  `not-active`.
- Before the fix the publisher rejected both outside an orderly close. f9828cd0 had made them (and `publish-failed`) a
  cancellation during a close only. The bench's worker transport counts every publisher rejection as an operation
  failure.

The fix keeps the exception narrow. `republishRetainedHistory` captures the plane it publishes from, and the outcome
goes through `retainedPublicationCancelled` (new packages/node/src/internal/retained-publication.ts), which holds the
close rule (unchanged) and the new successor rule. A failed publication now returns without error only when all of
these hold:

- the result is `not-active` or `publication-state-unknown`;
- the session has no terminal failure;
- the session has moved past the captured plane (`activeHandle !== plane`), or an adoption or install
  (`creatorSuccessorAdoptionTask`) is in flight.

Everything else still rejects, each case with a test:

| Outcome                                                                                 | Result                | Test                                                                                                                         |
| --------------------------------------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `publish-failed` on a current plane, no close                                           | rejects               | RED guard 3 (a send that fails), unit test                                                                                   |
| `not-active` with no successor and no close (target not connected)                      | rejects               | RED guard 4, unit test                                                                                                       |
| `store-failed`, `record-rejected`, `admission-rejected`                                 | reject in every state | unit test                                                                                                                    |
| any kind after a terminal failure                                                       | rejects               | unit test                                                                                                                    |
| `not-active` / `publication-state-unknown` across the session's own adoption or install | returns               | RED cases 1 (creator, a send held across its adoption) and 2 (Writer, a publication started inside its install's activation) |
| the close rule (f9828cd0)                                                               | unchanged             | unit test; tests/track-z-scheduled-lull-close.test.ts                                                                        |

The unit test, packages/node/tests/retained-publication-cancel.test.ts, checks every kind against every state
(terminal × closing × superseded). Before the fix, RED cases 1 and 2 failed and the guards passed
(`<evidence>/track-z/logs/z-rps-red-4`). After it all four pass, with the unit test, the close RED,
creator-ordinary-neutral-resource and creator-recipient-recovery-pool (`logs/z-rps-fix-1`).

No source-text pin reads these lines. The v3-room readers select:

- the function holding `bindCurrentCreatorClose = (plane)`;
- `mergedSettlementPlan`;
- `rebasePromise` and `prepareCurrentCreatorOrdinaryReadiness`;
- the recipient lull body;
- two call sites.

tests/fixtures/phase-6b-d110c-b/source-shape.mjs reads the binding, not v3-room.ts.

**Why the requester loses nothing.** The requester asked for rows from a plane that the serving peer was retiring.
Each such row is in one of two places:

- inside the successor's cut, which reaches the requester with the successor (the creator's adoption publication and
  the requester's own install of it);
- outside it, and then its author rebases it into the successor epoch on install or adoption, as for any row outside
  a cut.

The retired plane's retained history is not needed once the requester installs the successor. The fix changes only
what the serving peer reports. Its stores, its journal and the successor are untouched, and no row is deleted or
withheld from the successor.

**Does the requester retry a dropped answer?** The rejection was on the serving peer's side; the requester never sees
it in either version.

- On the shipped transport (packages/node/src/room-network.ts):
  - a publisher rejection was always ignored (`.catch(() => undefined)` at :431, :435 and :795, and `Promise.allSettled` at :798-799);
  - `#scheduleRequests` sends one retained request 7 times, at 0, 0.5, 1.5, 3, 6, 10 and 15 s
    (`RETAINED_REQUEST_DELAYS`, capped at 32 schedules per room);
  - `#requestMissing` repeats a missing-history request at most once per second while the room keeps reporting
    missing history.
  - So the requester asks again by itself, and the shipped pages never saw this fault.
- The bench's worker transport asks once and counts the rejection, so only the bench saw it.

With the fix the serving peer reports nothing for a cancelled answer, as for a close. The requester's own retries are
unchanged.

## 6. Latency on real networking (step 5)

Each shipped page on real networking (two relays, libp2p gossip and direct streams; Track X's Canvas and Chat
harness, Track V's Grid harness as on main), Chromium, 16 epochs, `TRACK_Z_PHASES=1`, no harness lull, rollovers
paused as shipped (the known Writer-install refusal needs a Writer move during the seal; §14). Plans
`<evidence>/track-z/data/plan-t5.txt` and `plan-t6.txt`; logs `<evidence>/track-z/logs/t5-<app>-<arm>-<run>.log` and
`t6-…`; comparison `bin/t56cmp.sh` (`bin/compare.py`, `<evidence>/track-z/data/t56cmp.txt`), lulls
`bin/lullepochs.py`. Arms, all at base 30cb474e:

- **H**: the flip, the new default (room database with retention and the scheduled lull), before the close fix
  (e6ebaec6), run from the scratch branch `track-z-nolull2` with its page global unset. 2 runs per app.
- **F**: the head at 7c491531 (the close fix, the amendments and the flip), from the branch itself. 1 run per app,
  at the end, at lower load. The close fix changes nothing before a close, so F and H measure the same code path.
  The retained-publication fix (45e0ea52) came after these runs. It changes only what a peer reports when its own
  successor cancels a retained publication, which these pages' transport ignores (§5.8), so F is also the final
  code's latency path.
- **N**: the flip with the scheduled lull turned off by the page global (step 1's arm B configuration). 2 runs.
- **S**: the shipped default, from the no-flip tree (the amendments commit: six databases, no lull). 2 runs per app,
  one early at high load (S-1) and one at the end next to F (S-2), to calibrate against step 1.
- Step 1's arms A (shipped), B (room host with retention, no lull) and C (B plus an explicit lull after each install)
  ran at 24d4ca61 in an earlier session (§3).

Every run completed 16/16 epochs (24 runs in step 1, 21 here); no rollover hung, no Track X seal deadlock was seen,
and the known Writer-install refusal never appeared. Steady medians over epochs 5-16, pooled over runs, in ms; the
scheduled lulls are steady medians over epochs 6-16 (the first retirement round is at e4-e5, below).

| Page   | Arm                       | Seal | Adoption | Install | Creator lull | Recipient lull | Creator move issue | Rows e16 (C/R) |
| ------ | ------------------------- | ---- | -------- | ------- | ------------ | -------------- | ------------------ | -------------- |
| Canvas | step 1 A shipped          | 2654 | 733      | 1442    | -            | -              | 298                | 160/111        |
| Canvas | step 1 C (explicit lull)  | 254  | 746      | 206     | 396          | 151            | 253                | 129/95         |
| Canvas | S-1 shipped (load 86)     | 7076 | 1776     | 3250    | -            | -              | 744                | 160/111        |
| Canvas | S-2 shipped (load 29)     | 2974 | 849      | 1695    | -            | -              | 336                | 160/111        |
| Canvas | N flip, lull off          | 1108 | 1027     | 465     | -            | -              | 422                | 162/114        |
| Canvas | **H new default**         | 295  | 1030     | 295     | 1036 / 940   | 479 / 293      | 427                | 129/113        |
| Canvas | **F, 7c491531 (load 48)** | 296  | 946      | 284     | 620          | 246            | 382                | 129/113        |
| Chat   | step 1 A shipped          | 3125 | 776      | 1606    | -            | -              | 329                | 160/111        |
| Chat   | step 1 C (explicit lull)  | 298  | 876      | 226     | 435          | 167            | 328                | 129/95         |
| Chat   | S-1 shipped (load 98)     | 5594 | 1473     | 2548    | -            | -              | 640                | 192/143        |
| Chat   | S-2 shipped (load 18)     | 3233 | 818      | 1774    | -            | -              | 344                | 192/143        |
| Chat   | N flip, lull off          | 1714 | 1684     | 619     | -            | -              | 627                | 194/146        |
| Chat   | **H new default**         | 356  | 1182     | 329     | 680 / 2080   | 327 / 1065     | 575                | 161/145        |
| Chat   | **F, 7c491531 (load 41)** | 266  | 933      | 266     | 701          | 236            | 392                | 161/145        |
| Grid   | step 1 A shipped (legacy) | 3104 | 440      | 1912    | -            | -              | 76                 | 213/192        |
| Grid   | step 1 C (explicit lull)  | 281  | 465      | 264     | 457          | 222            | 72                 | 178/173        |
| Grid   | S-1 shipped (load 101)    | 7514 | 810      | 4221    | -            | -              | 305                | 213/192        |
| Grid   | S-2 shipped (load 18)     | 2798 | 392      | 1722    | -            | -              | 69                 | 213/192        |
| Grid   | N flip, lull off          | 1038 | 534      | 607     | -            | -              | 95                 | 215/195        |
| Grid   | **H new default**         | 352  | 580      | 408     | 1410 / 1227  | 684 / 682      | 219                | 178/195        |
| Grid   | **F, 7c491531 (load 35)** | 278  | 439      | 308     | 635          | 339            | 137                | 178/195        |

(H's lulls are per run, run 1 / run 2. Load 1-minute average at the start of each run: N and H 59-228, S-1 86-101,
S-2 and F 18-48.) Step 1's arm B and the per-run values are in `t56cmp.txt`.

- **Seal and install, new default against shipped default.** At comparable load (F against S-2, both at the end of
  the session): seal 2974 → 296 (Canvas), 3233 → 266 (Chat), 2798 → 278 (Grid), a 10-12x cut; install 1695 → 284,
  1774 → 266, 1722 → 308, a 5.6-6.7x cut. Step 1 predicted 10-11x and 7x (A against C). S-1 ran at about twice those
  times under high load (Canvas seal 7076); the IndexedDB work is the same (the same transaction counts per window
  in every session: Canvas seal 1451 transactions on six databases and 422 on the room database, adoption 620,
  recipient install 656 and 226), only each transaction took longer.
- **The lull's share.** Against the flip without the lull (N, same session as H), the scheduled lull cuts the seal
  by 2.9-4.8x and the install by 1.5-1.9x, as C did against B in step 1.
- **Adoption does not change** (H, F, N and S-2 within the run-to-run spread; Chat N-2 at load 224 is the outlier at
  2375). It is out of scope (§14).
- **The scheduled lull costs more than step 1's explicit one** (creator 0.62-1.4 s, recipient 0.24-0.68 s, against
  0.40-0.46 s and 0.15-0.22 s). Two reasons, both measured per window: load (F, at the lowest load, is 0.62-0.70 s
  and 0.24-0.34 s; Chat H-2 at load 153 is 2.1 s), and overlap. Arm C's harness ran its lull alone after both
  installs; the scheduled lull starts right after the adoption, so it runs while the recipient installs and while
  the creator plays its next moves (on Canvas the creator's install window holds 160 IndexedDB transactions of its
  lull, against 3 in arm C). §7 shows what that costs a move.
- **One lull per epoch per role** in every H and F run (15 recorded per role per run; the 16th finishes after the
  last record): the creator's first two are `deferred:unsupported` (no closed boundary yet), the third
  `not-needed`, then `maintained`; the recipient's first two `not-needed`, then `maintained`. No explicit or idle
  lull ran (the idle scheduler is off in these apps).
- **Creator move issue** is the same with and without the lull on Canvas and Chat (427 against 422, 575 against
  627), and higher on the Grid (219 and 137 against 95 and 69), where a move is short and so the wait for the lull's
  remainder shows (§7).
- **First retirement round, once per room** (out of scope, §14): with the lull it lands in the creator's lull at e5
  (H: Canvas 5364 and 3936, Chat 3463 and 5411, Grid 4986 and 3642; F: 3475, 2656, 3705 ms) and the recipient's at
  e4-e5 (839-2130 ms; F 700-1392); without it, in the creator's e5 seal (N: Canvas 3045 and 3606, Chat 3372 and
  10317, Grid 2806 and 3515 ms) and the recipient's e4 install (1010-2598 ms).
- **Rows.** The room database is flat from e7 on Canvas and Chat in every arm. The census counts every database on
  the origin: Chat's total grows 2 rows per epoch in every arm, which is Track W's device archive database
  (`ts-drp-chat-archive-v1--*`), 2 messages per epoch, application data by design. The Grid grows 4 rows per epoch
  in every arm, the shipped default included: it still runs the legacy creator-trusted-v1 profile (issuance outbox
  and issued records), which Track V's switch moves. H's recipient total (Canvas 113, Grid 195 against C's 95 and 173) is taken right after the install, before that epoch's scheduled lull has finished, so it sits above arm C's
  (taken after the harness lull); it is flat. §9 shows the rows after the lulls over 100 epochs.

## 7. What play sees during the scheduled lull (addition 3)

The same step-5 runs (H against N, two runs each), plus two Grid runs per arm with the Writer moving first in each
epoch (`TRACK_Z_WRITER_FIRST=1`, 38b4611c), so that the Writer's move lands in both lulls. The harness records each
lull's window and, per move, its issue start, its issue time on the issuing page and when the other page first shows
it, all in absolute page time (`bin/lullplay.py`; `<evidence>/track-z/data/t5-lullplay.txt`,
`t5-gridw-lullplay.txt`, and `t5-lullplay-steady.txt` from epoch 6). A move is "during the lull" when the lull
overlaps it; the no-lull arm gives the moves at the same (epoch, ordinal) positions.

What addition 3 asks for maps onto the apps as follows. On the Grid the Writer plays, so both figures are measured
directly (Writer first). On Canvas and Chat only the creator moves in these harnesses (both shipped pages open
every joiner receive-only, as Track X's harness notes), so the creator's own issue during its lull and the recipient's admission
of the creator's move during the recipient's lull stand in for them.

All epochs (1-16), p50 / p90 / max in ms:

| Page                | What                                                     | n   | During the lull   | Lull left at the move (p50 / max) | Past the lull's end | No lull, same moves |
| ------------------- | -------------------------------------------------------- | --- | ----------------- | --------------------------------- | ------------------- | ------------------- |
| Grid (Writer first) | **creator's admission of a peer (Writer) move**          | 21  | 244 / 575 / 3184  | 138 / 10912                       | 6 / 103 / 158       | 38 / 113 / 337      |
| Grid (Writer first) | **recipient's (Writer's) own issue**                     | 21  | 257 / 1245 / 2999 | 215 / 2963                        | 40 / 44 / 48        | 28 / 37 / 98        |
| Grid                | creator's own issue                                      | 24  | 494 / 942 / 4068  | 196 / 3957                        | 114 / 395 / 537     | 121 / 214 / 323     |
| Grid                | Writer's admission of the creator's move                 | 25  | 432 / 1074 / 4076 | 251 / 1086                        | 6 / 24 / 132        | 133 / 193 / 333     |
| Canvas              | creator's own issue                                      | 24  | 480 / 1037 / 4368 | 84 / 3904                         | 385 / 575 / 759     | 425 / 608 / 822     |
| Canvas              | receive-only recipient's admission of the creator's move | 21  | 530 / 1364 / 4392 | 54 / 1352                         | 17 / 28 / 37        | 440 / 638 / 871     |
| Chat                | creator's own issue                                      | 24  | 765 / 1628 / 4799 | 216 / 4280                        | 402 / 1026 / 1455   | 899 / 1454 / 2694   |
| Chat                | recipient's admission of the creator's move              | 21  | 722 / 1665 / 4806 | 85 / 1200                         | 12 / 23 / 37        | 556 / 1464 / 2839   |

"Past the lull's end" is the move's own figure minus the lull's end (for an admission, past the later of the lull's
end and the issuer's issue end). Steady play, epochs 6-16 (the first retirement round excluded):

| Page                | What                                     | During the lull   | No lull, same moves |
| ------------------- | ---------------------------------------- | ----------------- | ------------------- |
| Grid (Writer first) | creator's admission of the Writer's move | 242 / 495 / 575   | 37 / 113 / 337      |
| Grid (Writer first) | Writer's own issue                       | 237 / 453 / 507   | 28 / 36 / 40        |
| Grid                | creator's own issue                      | 427 / 822 / 942   | 121 / 214 / 323     |
| Grid                | Writer's admission of the creator's move | 432 / 830 / 1074  | 144 / 218 / 333     |
| Canvas              | creator's own issue                      | 474 / 922 / 1037  | 418 / 608 / 822     |
| Canvas              | recipient's admission                    | 494 / 944 / 1061  | 440 / 638 / 871     |
| Chat                | creator's own issue                      | 695 / 1265 / 1628 | 548 / 1454 / 2694   |
| Chat                | recipient's admission                    | 698 / 1236 / 1665 | 556 / 1480 / 2839   |

- **A move during the lull waits for the lull's remainder and no longer.** Past the lull's end, an admission takes
  6-17 ms at p50 and at most 158 ms, and an issue costs what an ordinary move costs (Canvas 385 against 425 without
  the lull; the Writer's 40 against 28). So no move waits longer than the lull's own figures suggest, and the stop
  condition of addition 3 was not met. No move was lost or reordered (every run converged; G23).
- **The cost is the remainder.** In steady play the remainder at a move is 52-241 ms at p50 and at most 1.7 s, so a
  move during the lull takes 0.24-0.70 s at p50 (0.5-1.7 s at most) against 0.03-0.56 s without the lull. On Canvas
  and Chat, whose moves already take 0.4-0.9 s, that is +50-150 ms at p50; on the Grid, whose moves are short, it is
  +200-300 ms at p50.
- **The maxima (3.0-4.8 s) are moves made during the first retirement round** (the creator's e5 lull of 3.5-5.4 s,
  13.5 s in one Grid Writer-first run at load ~100), the once-per-room cost out of scope (§14). In that run a Writer
  move that started with 10.9 s of the creator's lull left was admitted after 3.2 s, while the lull still ran: the
  lull does not hold the creator's ingress for its whole length, so a long lull bounds the wait from above.
- Without the lull the same moves meet the seal's inline retirement instead (§6: the e5 seal 2.8-10.3 s in arm N).

## 8. The bench

The healthy native Grid bench (`tests/fixtures/startup-discovery/r8-source-binding.pw.ts` with the untracked inputs
`.logs/bounded-storage-lifecycle/r8-warm-capacity-01/`; a creator and three Writer recipients; 8 rollovers, then a
persisted close, reopen and continuation), Chromium, one bundle per tree (`bin/benchbuild.sh`), `bin/bench.sh` and
`bin/benchpairs.sh` (ABBA pairs). Two modes:

- **default**: the binding's default host. At base that is six databases; at head it is the room database with
  retention and the scheduled lull.
- **opt-in**: an explicit room host with retention, plus the bench's own explicit lull after each install, as Track
  M2 and Track Y ran it. The flip must leave this mode unchanged.

Runs: `<evidence>/track-z/grid/run-<tag>-<mode>-<A|B>-<i>/` (A = base 30cb474e, B = head). Summaries:
`bin/benchpool.py` (pooled over every passed run), `bin/paired.py` (per ABBA pair) and `bin/benchlulls.py` (the
scheduled lull's proof events). Data: `<evidence>/track-z/data/bench-t5-pooled.txt`, `bench-t5-paired.txt`,
`bench-t5x-paired.txt`, `bench-t5-lulls.txt`.

**Pass rate, per round:**

| Round | Head tree                                | default, base | default, head                                                                                                      | opt-in, base | opt-in, head |
| ----- | ---------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------ | ------------ | ------------ |
| t2    | head2, e6ebaec6 (no fix)                 | 2/2           | **0/2**: "no history work after original producer close" (§5.8, fault 1)                                           | 2/2          | 2/2          |
| t3+t4 | head3, 7c491531 (the close fix)          | 4/4           | **3/6**: "v3 room retained publication failed: publication-state-unknown" (2), "…: not-active" (1) (§5.8, fault 2) | 2/2          | 2/2          |
| t5    | head4, 2a00d915 (both fixes, final code) | 3/3           | **6/6**                                                                                                            | 2/2          | 2/2          |

The coordinator's condition was at least 5 of 5 in default mode at head after the fix: 6 of 6 passed (load 69-148
during the round). Before the fixes, every failure was at the persisted close; every transition of every run had
completed.

**Latency at the final code (t5: 2 ABBA pairs in both modes, then 4 more default runs at head with 1 at base
between them; ms, pooled median over every passed run, with the range of run medians):**

| Window                     | default, base (3 runs) | default, head (6 runs) | opt-in, base (2) | opt-in, head (2) |
| -------------------------- | ---------------------- | ---------------------- | ---------------- | ---------------- |
| Seal                       | 1282 (1209-1422)       | **240** (226-252)      | 238              | 241              |
| Creator adoption           | 495 (453-544)          | 453 (422-481)          | 427              | 441              |
| Recipient install          | 1009 (900-1238)        | **421** (400-432)      | 268              | 267              |
| Creator lull               | -                      | 581-697 (scheduled)    | 381              | 392              |
| Recipient lull             | -                      | 346-510 (scheduled)    | 193              | 205              |
| Ordinary move issue        | 42.1                   | 36.6                   | 33.5             | 33.5             |
| Slowest peer sees the move | 88.1                   | 74.8                   | 71.4             | 72.5             |
| Persisted reopen           | 274 (260-390)          | **827** (725-882)      | 778              | 806              |

- **The flip on the bench** (default mode, head against base): seal 5.4x faster, install 2.4x, adoption unchanged
  (within the spread), moves slightly faster. Per ABBA pair the head was faster on seal, install, adoption and moves
  in 2 of 2 pairs (B/A 0.18, 0.38, 0.90 and 0.91).
- **The opt-in mode is unchanged**: every window within 6% (B/A 1.00-1.06, inside the run-to-run spread at this
  load); 2 of 2 passed on each side.
- **Install is above the opt-in mode's** (421 against 267 ms) because the scheduled lull runs right after the
  creator's adoption, while the three recipients install, where the bench's explicit lull ran after every install had
  finished (the same overlap as §6). The seal reaches the opt-in figure.
- **The scheduled lull, as on the pages:** 32 `recovery-pool-lull` events per run (8 epochs × 4 roles, exactly one per
  role per epoch, all `trigger: "scheduled"`): the creator's first two `deferred:unsupported`, then `not-needed`, then
  `maintained`; each recipient's first two `not-needed`, then `maintained`. None in opt-in mode or at base. Median
  per run from epoch 3: creator 581-697 ms, recipients 346-510 ms.
- **Retention declines** at head in default mode: `ahe-birth` 4, `journal-same-epoch` 1, `signing-same-epoch` 2 per
  run (the first retirement round, §14); then `room-retention-pass:applied` every epoch on every role.
- **Reopen is slower on the room database.** The persisted reopen takes 0.83 s at head against 0.27 s on six
  databases; the opt-in mode, on the same room host without the scheduled lull, takes 0.78-0.81 s at base and head
  alike. So it is the room host's open path, not the lull and not this track's code. It is a cost of the flip that
  every reopen of a room created on the new default pays (§14).

## 9. Storage and heap over 100 epochs

Track M's browser long room (`tests/fixtures/track-m-apps/browser/`, `bin/storage100.sh`), Chromium, 100 epochs,
Canvas (receive-only recipient) and Chat (Writer recipient), in a fresh browser process, with the forced-GC JS heap
per page per epoch (`TRACK_M_APPS_HEAP=1`) and the per-store census after each epoch's lulls. The harness passes an
explicit room host with retention, so the run uses a tree at the flip (e6ebaec6 on 30cb474e) plus a scratch diff
that also gives that explicit host the scheduled lull, as the default does
(`<evidence>/track-z/data/storage-scratch.diff`, never committed). Run s100-2: 2 passed in 12.2 min, load 144 → 89.
Evidence: `<evidence>/track-z/storage-runs/s100-2/` (`bin/tma_heap.py`). The earlier round at ebf4254f (s100-1)
gave the same heap to within 0.03 MB and the same rows.

- **One lull per epoch.** 200 `recovery-pool-lull` events per app (100 epochs × 2 roles). The harness's own lull
  after each epoch is answered by the scheduled lull: on the creator at once (0 ms, the settled result); on the
  recipient it waits for the scheduled lull still running (p50 120 ms on Canvas, 185 ms on Chat). No epoch had a
  second lull.
- **Rows flat from epoch 8 to epoch 100 on every page:** Canvas creator 129, recipient 94; Chat creator 135,
  recipient 129. Retention applied on 193 of 200 role-epochs; the 5 declines per app are the first retirement round
  (`ahe-birth` at e3 and e4; `journal-same-epoch` and 2 `signing-same-epoch` at e4), the same as in §6, one epoch
  earlier in this harness's numbering.
- **Bytes:** every store except Chat's snapshot chunks moves by less than 6 B per epoch. Chat's 2 snapshot-chunk rows
  grow about 1.1 KB per epoch to e60 (11,008 B at e8, 67,402 B at e60), then stay at 67,534 B from e70 to e100. That
  is the chat messages, which reach Track W's rolling window: application state, as Tracks U and Y found, not
  protocol data.
- **Latency over the 100 epochs** (p50 from e8): seal 254 / 277 ms, adoption 685 / 808 ms, install 212 / 330 ms
  (Canvas / Chat).
- **Heap after forced GC** (MB at e8 / e64 / e100; slope from e8, and over the late half, in MB per epoch):

| Page             | e8    | e64   | e100  | Slope e8+ | Slope late | Track Y head, no scheduled lull (e8 / e64) |
| ---------------- | ----- | ----- | ----- | --------- | ---------- | ------------------------------------------ |
| Canvas creator   | 21.60 | 28.01 | 28.73 | 0.061     | 0.021      | 21.5 / 27.9                                |
| Canvas recipient | 14.89 | 19.86 | 22.07 | 0.072     | 0.066      | 14.8 / 19.6                                |
| Chat creator     | 23.02 | 28.29 | 28.74 | 0.038     | 0.013      | 22.7 / 27.9 (e56)                          |
| Chat recipient   | 16.54 | 23.15 | 23.50 | 0.071     | 0.028      | 16.3 / 22.0 (e56)                          |

The heap matches Track Y's head runs of the same harness and host without the scheduled lull to within 0.41 MB at
the same epoch (e64 on Canvas; e56 on Chat, where this run has 28.18 and 22.41 MB). The Canvas recipient still grows late because its hash memo
fills until about e128 (Track Y §7.2: a bounded LRU, 34.9 MB when full); the other three pages have levelled off. The
scheduled lull adds no heap holder: it keeps one settled result per session. Neither bench-found fix (§5.8) is in
this tree. The close fix changes only what a recipient lull does after a close, which this harness reaches only at
the end; the publication fix changes only how a peer reports a cancelled retained publication. Neither changes a
run that completes, and this one completed.

**Chat's v5 format, after the rebase (s100-v5-1).** Track W2 made shipped Chat create v5 rooms (membership-aware
shares), so the run was repeated for that format: the rebased flip 1c7ee87b plus the same scratch diff (tree
`<evidence>/track-z/storage3/`), `TRACK_M_APPS_CHAT_FORMAT=shares`, Chat only (a Writer recipient), 100 epochs, heap
after forced GC. It passed in 6.7 min (load 29-58). Evidence: `<evidence>/track-z/storage-runs/s100-v5-1/`.

- 200 `recovery-pool-lull` events, exactly 2 per epoch (one per role).
- Retention applied on 193 of 200 role-epochs; the 5 declines are the first round, as in v4 (`ahe-birth` at e3 and
  e4, `journal-same-epoch` and 2 `signing-same-epoch` at e4).
- Rows flat from e8 to e100: creator 135, recipient 129 (the same as v4).
- Bytes: from e60 to e100 every store moves by less than 4 B per epoch. The snapshot chunks grow with the window
  until it fills (11,080 B at e8, 62,930 B at e54, 67,474 B at e60) and hold 67,606 B from e80 to e100.
- The device archive (Track W's, application data by design) holds 400 messages at e100, 4 per epoch.
- Latency p50 from e8: seal 257 ms, adoption 848 ms, install 316 ms, recipient lull 178 ms (the creator's lull call
  is answered by the scheduled lull at once).
- Heap after forced GC, MB at e8 / e64 / e100: creator 23.02 / 28.33 / 28.78 (slope 0.039, late 0.015 MB per epoch),
  recipient 16.56 / 23.26 / 23.55 (0.072, late 0.025). That is within 0.06 MB of the v4 run above at e100.

## 10. An existing six-database room, created at base and reopened at head

A lone Canvas creator page through the binding's default (no `storageHost`), bundled once from the base tree
(30cb474e) and once from the head tree (the flip, e6ebaec6), run in ONE persistent Chromium 151.0.7922.34 profile
(`<evidence>/track-z/reopen/`, `all.sh r3`, bundles `bundle-base2` and `bundle-head2`; the entry and runner are
scratch scripts, never committed). Every step exited 0 with no page error.

| Step                                | Bundle | Databases after (name: version)                                                                                      | Result                                                                                                                     |
| ----------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| create `tzroom-a`, 2 rollovers      | base   | `tzroom-a` 6, `--ahe` 6, `--drp-issuance-v1` 3, `--drp-live-journal-v1` 3, `--drp-snapshot-quarantine-v1` 4, floor 1 | epoch 2, state recorded                                                                                                    |
| create `tzroom-b`, 2 rollovers      | head   | `tzroom-a`'s six unchanged, plus `tzroom-b` **7** and its floor 1                                                    | one version-7 room database; scheduled lulls: epoch 1 `deferred:unsupported`, epoch 2 queued at close, failed fast (below) |
| reopen `tzroom-a`, 2 more rollovers | head   | the same six names and versions; no version-7 database                                                               | opened at epoch 2 with the identical state; played to epoch 4; no lull or retention event (no scheduling on six databases) |

The epoch-2 lull of the new room was still queued when the page closed the room right after its second adoption; it
failed fast with "v3 room session is closed" (`reopen/r3/new.json` records the cause), observed only, and the close
was not delayed. That is the intended close behaviour (§5.3). The RED test covers the same reopen on fake-indexeddb
with the explicit host, 1 and 2 epochs (a recipient with no base database included). The earlier round at ebf4254f
(`reopen/r2`) gave the same result. Neither bench-found fix (§5.8) is in the head bundle. The close fix changes only
a recipient lull that is running at close, and the publication fix only how a peer reports a cancelled retained
publication; this page is a lone creator with no peer.

## 11. 14f on three engines

Track M's harness (`tests/fixtures/track-m/native/`, `bin/f14.sh` and `bin/f14session.sh`), with Playwright's
Chromium 151.0.7922.34, Firefox 153.0 and WebKit 26.5 (the same install as Track M2's runs), one worker. Each run
records the tree's HEAD and a digest of the bundled sources. The only untracked path in each tree is the copied bench
input directory under `.logs/`. Runs: `<evidence>/track-z/f14/<round>-<run>/`.

Rows:

- **Whole file**: smoke, case 2 (refusal and native abort), case 3, the death reference and cases 5-8, on Chromium /
  Firefox / WebKit.
- **Case 11**: the long room (`TRACK_M_14F_LONG=1`, 16 epochs), on Chromium only, as specified.
- **Cases 1-4**: the room retirement session
  (`packages/storage-browser/playwright.room-retirement-session-native.config.ts`), 6 tests per engine.

| Round | Tree                                            | Bundled sources (digest) | Whole file: Chromium / Firefox / WebKit                                       | Case 11         | Cases 1-4          |
| ----- | ----------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------- | --------------- | ------------------ |
| z2    | head2, e6ebaec6 (the flip, before §5.8's fixes) | 343 (`e2494012…8932`)    | 9 pass 1 skip (2.9 min) / 9 pass 1 skip (25.4 min) / 9 pass 1 skip (13.5 min) | 1 pass (46.6 s) | 18 passed (45.9 s) |
| z3    | head3, 7c491531 (with the close fix)            | 343 (`419af9b9…63eb`)    | 9 pass 1 skip (3.3 min) / 9 pass 1 skip (19.2 min) / 9 pass 1 skip (9.4 min)  | 1 pass (34.0 s) | 18 passed (17.4 s) |
| z4    | head4, 2a00d915 (both fixes: the final code)    | 344 (`07451ef9…b75a`)    | 9 pass 1 skip (1.9 min) / 9 pass 1 skip (8.1 min) / 9 pass 1 skip (7.7 min)   | 1 pass (27.3 s) | 18 passed (10.2 s) |

- The skip is case 11 in the whole-file runs.
- Case 10 (the healthy native Grid on the room database) is the bench's explicit opt-in mode (§8).
- Case 9 (migration) does not apply, because nothing is migrated.
- The harness opens the room on an explicit room host, so it tests the retention path that the default now selects.
  The flip changes nothing it bundles beyond the binding's routing. §5.8's fixes are in the node library it bundles
  (z3 has the close fix; z4 has both).
- z4 bundles one more input than z3: packages/node/src/internal/retained-publication.ts (§5.8).
- After the rebase onto 0171994d (§13), the Chromium whole file at the rebased flip 1c7ee87b (z5) bundles the same 344
  inputs with the same digest `07451ef9…b75a` and passes 9 with 1 skip (2.7 min), so z4 holds for the final code.
- The earlier round at ebf4254f (z1, the flip at 4a238076, digest `3f384b9d…a900`) gave the same results.

## 12. Suites, typecheck and the shadowed-sources guard

Per-test comparison of the final code against base, each set run from its own installed tree with JSON reports
(`bin/zsuite.sh`, `bin/vtdiff.py` and `bin/pwdiff.py`; a test passes on a side if it passed in any pooled report, so a
rerun alone counts). Vitest runs from the repository root with `--exclude ".claude/**" --exclude "**/.logs/**"
--no-coverage`.

- **B2**: base 30cb474e (`<evidence>/track-z/base2/`), run at load 77-137.
- **F4**: the final code 2a00d915 (`<evidence>/track-z/head4/`), run at load 12-57.
- The rebase onto 0171994d changes no file these sets run except the W2-related root files, which §13 compares at
  base3 and head5.

Logs: `<evidence>/track-z/logs/z-<B2|F4>-<set>.{log,json}`; diffs: `<evidence>/track-z/data/vtdiff-F4-B2-<set>.txt`.

| Set                                                                                                                                                  | Base (B2)                     | Final (F4)                    | New failures | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ----------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| node (packages/node)                                                                                                                                 | 1042 pass, 50 fail            | 1053 pass, 50 fail            | **0**        | +11: the scheduled-lull bookkeeping (6) and the retained-publication unit test (5). The same 50 fail at both (proof-accounting 20, ephemeral-webrtc RED 11, suffix-preflight 5 and 8 more files).                                                                                                                                                                                                                                                                                                                                                                              |
| storage-browser                                                                                                                                      | 356 pass, 5 fail              | 361 pass                      | **0**        | The 5 are governance timeouts at base's load (30-130 s).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| storage-node                                                                                                                                         | 375 pass, 304 fail, 5 skip    | the same                      | **0**        | identical per test                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| canonical, protocol-v3, storage                                                                                                                      | 303 pass                      | 303 pass                      | **0**        | identical                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| startup-discovery observers (+ healthy-grid profiler validation)                                                                                     | 54 pass                       | 54 pass                       | **0**        | identical                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Track Z root set (`data/root-set-z.txt`, 149 files: Tracks K, L, N, P, M, O, M2, S, T, Q, W, X and Z's root and native tests, d9346 RED, governance) | 1470 pass, 365 fail, 123 skip | 1497 pass, 364 fail, 108 skip | **0**        | +11 Track Z tests (all pass). 16 pass only at head, all base timeouts at load 95-137: a 10 s hook timeout skipped Track P2-a's authoring-emitter file (13), and phase-4c's 64 MiB test, P2-a's corrective and P2-c's conformance test timed out. One test, d110c-0c1f5b0a "puts ACL membership…", failed in the pooled head run with "Cannot access `__vite_ssr_import_8__` before initialization" (module initialization order in protocol-v3, which this track does not touch); it also failed so in the no-flip arm, and it passes alone at head (`z-F4-root-rerun-codec`). |
| Canvas and Chat e2e (`playwright.canvas-chat.config.ts`)                                                                                             | 9 pass                        | 9 pass                        | **0**        | identical; at the rebased trees too (§13)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| d9346 zone (`playwright.phase-3a1b-d9346-zone.config.ts`)                                                                                            | 2 pass                        | 2 pass                        | **0**        | identical                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Six browser pin suites (storage-browser 6a, barrier, browser room retirement, GMP, room retirement; startup-discovery browser RED)                   | fail before running           | the same (at the flip, F2)    | **0**        | stale instrumentation seam, Keychain constructor, prebuilt artifact directory, `STARTUP_FIXTURE_PRECONDITION`; identical at both                                                                                                                                                                                                                                                                                                                                                                                                                                               |

**No new failure against base in any set.**

**The flip alone adds no failure.** The no-flip arm P2 (the amendments commit of the first stack: every Track Z change
except the flip) against F2 (the flip) differs only by load-dependent timeouts, which also fail at B2, and the two
default-room REDs, which pass only with the flip. e2e and d9346 are identical across B2, P2 and F2
(`data/vtdiff-F2-P2-*.txt`).

**Typecheck.** `pnpm -r typecheck` in the worktree: 0 errors over 46 projects, at 2a00d915 and again at the rebased
flip 1c7ee87b (`logs/tc-W4.log`, `logs/tc-W5.log`). The scratch trees under `<evidence>` show 3 TS2307 errors in
packages/interval-discovery's tests (`@libp2p/*` resolves in a worktree only through a `node_modules` directory in an
ancestor of the main checkout, which the scratch trees lack); base2 shows the same 3, so it is the location, not the
code.

**`node scripts/check-shadowed-sources.mjs`** exits 0 at both (`logs/shadow-W4.log`, `logs/shadow-W5.log`).

## 13. The rebase onto 0171994d (Track W2)

Main moved to 0171994d before the final proofs. It adds Track W2: Chat's v5 format with membership-aware shares, an
admin grant control on the shipped page, tests and docs. The stack was re-applied by cherry-pick (backup branch
`track-z-stack-5` = 2a00d915), with no conflict.

- **What changed under the stack:** `git diff 2a00d915 1c7ee87b` (the flip before and after) is exactly W2's 24
  files: examples/chat, tests/fixtures/chat-membership-shares, Track M's apps harness (an opt-in Chat format), W2's
  tests and Playwright config, and docs. No file under packages/, examples/v3-room, the startup-discovery, track-m
  (native) or track-x fixtures, or specs differs, and no file is changed by both.
- **Why the flip touches v5 Chat:** shipped Chat (examples/chat/src/index.ts:383) calls `createV3RoomSession` with no
  `storageHost`, so a new v5 Chat room is created in the room database with retention and the scheduled lull, as a
  v4 room was. A v3, v4 or v5 room created before the flip stays on six databases.
- **Does any W2 test need the explicit six-database host? No.** W2's vitest files pass an explicit Node SQLite host
  (tests/fixtures/chat-membership-shares/room.ts, `createNodeV3RoomStorageHost`) or test the rule alone, so the
  browser default never reaches them. Its Playwright test runs the shipped page on the default host, and it passes at
  head (below). No new amendment is needed.

**The W2 proof set, at base3 (0171994d) and head5 (the rebased flip 1c7ee87b)**, each from its own installed tree
(`<evidence>/track-z/base3/`, `head5/`; arm S of the page runs from `noflip3/`, the rebased amendments commit 510c3000):

| Proof                                                                                                                                         | Base (0171994d)                        | Head (1c7ee87b)                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------- |
| tests/track-w2-shipped-chat-membership.pw.ts (`playwright.track-w2-chat-membership.config.ts`, port 4181), shipped page, real networking      | 1 of 1 passed (2.4 min)                | 2 of 2 passed (1.8 and 1.7 min)                                                          |
| its 23 epochs (grant, share in force, joiner speaks, revoke, 17 fill epochs), median / max ms                                                 | seal 2396 / 3247, adoption 1666 / 1970 | seal 252 / 378 and 208 / 271, adoption 1728 / 2153 and 1639 / 1986                       |
| W2's unit and room files: departed-admission (3), chat-shares-rule (14), chat-shares-room (3), and chat-shares-native (4, the 300-epoch room) | 24 of 24 pass                          | 24 of 24 pass                                                                            |
| Every vitest file that imports a W2-changed source (`vitest related`, `bin/w2rel.sh`)                                                         | 57 pass, 45 fail, 22 skip              | the same per test, plus 10 Track Z tests that import Chat (all pass): **0 new failures** |
| Canvas and Chat e2e (`playwright.canvas-chat.config.ts`), d9346 zone                                                                          | 9 of 9, 2 of 2                         | 9 of 9, 2 of 2 (identical per test)                                                      |

- The 45 failures in the related files fail the same way at base and head, all before any room runs: R11's disposable
  fixture and r9's shipping catalog need inputs this environment lacks (`R11_DISPOSABLE_FIXTURE_REQUIRED`,
  `SHIPPING_CHAT_CATALOG_DIR must name genuine nightly output`), and r9-chat-metadata calls a function that no
  longer exists (`createShippingChatAdmissionPolicy is not a function`).
- In W2's Playwright test the revoked member's epoch-6 install fails with `D110C_B_ACTIVATION_STALLED:
preparation-rejected: creator historical issuance authority preparation failed`, at base and head alike. That is
  W2's revoke path (the member then leaves), not this track's.
- Logs: `<evidence>/track-z/logs/pw-w2pw-{B3-1,F5-1,F5-2}.log`, `z-{B3,F5}-w2rel.{log,json}`,
  `pw-z-{B3,F5}-{e2e,d9346}.json`; summaries `data/w2pw-records.txt`, `data/vtdiff-F5-B3-w2rel.txt`.

**The shipped Chat page in Track X's harness at the new default, after the rebase (v5 rooms).** Run like §6 (real
networking, Chromium, 16 epochs, `TRACK_Z_PHASES=1`, rollovers paused as shipped), alternating H (head5) and S
(noflip3), 2 runs each, at load 7-14 (`data/plan-t7.txt`, `bin/t7cmp.sh`, `data/t7cmp.txt`). Steady medians,
epochs 5-16, ms:

| Arm                                     | Seal | Adoption | Install | Creator move issue | Rows e16 (C/R) |
| --------------------------------------- | ---- | -------- | ------- | ------------------ | -------------- |
| S, shipped six-database default (v5)    | 2694 | 723      | 1507    | 340                | 192/143        |
| **H, new default (v5)**                 | 260  | 824      | 236     | 396                | 161/145        |
| for reference, §6 at 30cb474e (v4): S-2 | 3233 | 818      | 1774    | 344                | 192/143        |
| for reference, §6 at 30cb474e (v4): F   | 266  | 933      | 266     | 392                | 161/145        |

- All four runs completed 16/16 epochs with exit 0.
- One scheduled lull per role per epoch, as before: 15 recorded per role per run, and the 16th ends after the last
  record. Steady (e6+) creator lull p50 478-755 ms, recipient 187-283 ms. The first round lands in the creator's
  epoch-5 lull (2.3-2.7 s) and the recipient's epoch-4 lull (0.6-0.9 s).
- The new default cuts Chat's seal 10x and its install 6x on v5 rooms, as on v4. Adoption is within the run-to-run
  spread.

**What carries over without a rerun, and why:**

- **The bench (§8):** the bench bundle built from the rebased flip is byte-identical to head4's after replacing the
  tree path (sha256 `a1e5c189…71e5`, 626 inputs, 42 files; `bin/bundlecmp.py`,
  `<evidence>/track-z/data/bench-bundle-head4-head5.txt`).
- **14f (§11):** the rebased flip bundles the same 344 inputs with the same digest as z4 (`07451ef9…b75a`), and its
  Chromium whole file passes (z5).
- **The library suites (§12):** node, storage-browser, storage-node, canonical/protocol-v3/storage, the observers and
  the Track Z root set run code that is identical at head4 and at the rebased flip, except root tests that import a
  W2-changed file. Those are exactly the files `vitest related` selects for W2's sources, rerun at base3 and head5
  above.
- **Canvas and Grid pages (§6, §7) and the reopen check (§10):** W2 changes neither page nor the binding.
- **Typecheck:** rerun in the worktree at the rebased flip 1c7ee87b: exit 0, 0 errors, 46 projects; the
  shadowed-sources guard exits 0.

## 14. What remains, and the risks

### 14.1 Out of scope by the owner's choice (separate tracks)

1. **The first retirement round (a follow-up track after this flip lands).** On every new room, retention declines
   the room's earliest boundaries and the existing per-class path runs once. Decline reasons per room, the same in
   every step-5 run on Canvas and Chat, both arms (`bin/declines.py`):

   | Role      | Reason (`room-retention-declined:`) | Count | Epoch                        | Per-class commits (`closed-retirement-room-session:committed`) |
   | --------- | ----------------------------------- | ----- | ---------------------------- | -------------------------------------------------------------- |
   | creator   | `ahe-birth`                         | 1     | e4 with the lull, e5 without | 4, all at e5                                                   |
   | creator   | `journal-same-epoch`                | 1     | e5                           |                                                                |
   | creator   | `signing-same-epoch`                | 2     | e5                           |                                                                |
   | recipient | `ahe-birth`                         | 1     | e4                           | 1, at e4                                                       |

   From then on `room-retention-pass:applied` every epoch (creator from e6, recipient from e5). The Grid (Writer
   recipient) has the same counts at the same epochs in all four of its runs. The 100-epoch runs have the same five
   declines, one epoch earlier in that harness's numbering (§9). With the scheduled lull
   this one-off cost lands in the creator's lull at e5 and the recipient's at e4-e5 (§6: creator 3.5-5.4 s in arm H
   and 2.7-3.7 s in arm F, recipient 0.8-2.1 s and 0.7-1.4 s; step 1 measured 2.1-2.8 s at lower load); without it,
   in the e5 seal (2.8-10.3 s in arm N) and the recipient's e4 install (1.0-2.6 s).
   A move made during that lull waits for its remainder, up to the lull's length (§7).

2. **Adoption (a track after Track X's startup fix merges).** Settlement publish plus the readiness capture, unchanged
   by the flip (arm H against arm N, §6).

### 14.2 Remaining items recorded by this track

3. **14c, deferred by the owner** (§5.4): the counterexample, inert on every floor we run, protected today by
   `fenceDecision` and trust RED 4; full wiring as option (a). Revisit if an IndexedDB floor ships.
4. **Existing rooms stay on six databases.** With no migration (14d not implemented, not needed for the flip), a room
   created before the flip keeps the six-database host, its 2.6-3.1 s seal and no scheduled lull, for its life.
   Bringing those rooms to the new default needs 14d's migration (and 14f case 9).
5. **The 512-write cap** (14e, policy pending review): above about 85 signers a unit is over the cap and that boundary
   takes the existing per-class path (latency as on six databases, storage still bounded). The scheduled lull moves
   that cost off the seal but does not shrink it.
6. **The known Writer-install refusal (Track X's next fix).** A Writer move made during the creator's seal makes the
   Writer's install refuse ("active replacement source custody refused: portable source protected dependency is
   unavailable"). Every harness here keeps the pause during seal and adoption. The refusal never appeared: not in
   any page run (t5, t6, t7), the bench runs, the 14f runs, the storage runs, W2's Playwright test or the suites.
7. Pre-existing failures that this track leaves as they are: the d9346 extraction export pin (two exports existed
   before this track), the startup-discovery browser-red bundle (`@ts-drp/blueprints/v3-canvas` unresolvable from
   tests/fixtures/startup-discovery/shipped.ts at base and head alike), and the base failures listed in §12.
8. **Reopen is slower on the room database** (§8): the bench's persisted reopen takes 0.83 s on the new default,
   against 0.27 s on six databases. The opt-in mode, on the same room host without the scheduled lull, takes
   0.78-0.81 s at base and head alike, so the cost is the room host's open path (Track Y measured 1.3-1.4 s there),
   not this track's code. Every reopen of a room created on the new default pays it. A follow-up track could profile
   that open path.
9. **A Writer recipient on the shipped pages.** Track X's harness opens every joiner receive-only, as both shipped
   pages do, so the page runs (§6, §13) measure a receive-only Chat recipient, before and after W2. A granted Writer
   on the shipped Chat page at the new default is covered by W2's Playwright test (§13), and Writer recipients by the
   bench (§8), the Grid page and Track M's harness (§9).

### 14.3 Risks

- **Moves wait for the scheduled lull.** Measured in §7: a move waits only for the lull's remainder, then costs an
  ordinary move. In steady play the remainder at a move is 52-241 ms at p50 and at most 1.7 s, so a move during the
  lull takes 0.24-0.70 s at p50 against 0.03-0.56 s without the lull. Once per room (the first round) it is several
  seconds.
- **The successor rule for retained publications (§5.8)** makes a peer stay silent, instead of rejecting, when its
  own adoption or install cancels a publication. A publication to a disconnected target that happens to start
  during that transition is now silent too (`not-active` for both causes). The window is the transition's length,
  the requester retries on its own on the shipped transport, and outside a transition the same result still
  rejects (RED guard 4).
- **The figures are load-sensitive.** This machine ran other tracks' suites throughout; step 5's whole session ran
  about 2x slower than step 1 (arm N against step-1 arm B, the same configuration). Every comparison here is paired
  in the same session (H against N and S; bench ABBA).
- **Routing reads database names.** `indexedDB.databases()` or the non-creating probe. A room whose databases were
  partly cleared by the user is routed by what remains; a wrong choice can only fail to open (the room host refuses a
  version-6 `N`; the six-database owners refuse version 7), never modify a room.
- **Track X's next work** (play during a rollover, in the settlement drain and the portable replacement) may
  conflict textually only in the v3-room.ts hunks listed in §5.3. The one semantic dependency, the FIFO order of the
  readiness hold before the scheduled lull, is pinned by a test (§5.3).
- **Reopen** is about 0.55 s slower for a room created on the new default (item 8).
- **The scheduled lull queued at close** fails fast with "v3 room session is closed" (observed, not thrown); an app
  that closes right after a transition loses that epoch's lull, and the next epoch's runs as usual.
