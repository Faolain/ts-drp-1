# Track R3 result

- Worktree: `<worktree agent-aeb6ebdfc4584ace2>/`, branch `worktree-agent-aeb6ebdfc4584ace2`.
- Base: `codex/phase3a1b-p6-golden-path` at **4bb6bc7d** (Track L landed). Nothing was pushed.
- Working notes: `<evidence>/track-r3/PROGRESS.md`. Logs: `<evidence>/track-r3/logs/` and
  `<evidence>/track-r3/tests/`. Grid runs: `<evidence>/track-r3/grid/`.
- Guarantee ids (G1–G28) refer to the
  [golden-path guarantee checklist](../../../../specs/bounded-storage-lifecycle/golden-path-guarantees.md).
- The Track R2 result follows below this section, unchanged except for its rebased commit id.

## 1. Outcome in brief

- **Specs.** Slices 14 and 14a–14f (the brief's S1–S6) were committed on their own first (d3cc655d). They
  are argued against the guarantee checklist.
- **What landed, opt-in: stage 1a of slice 14a.**
  - A version-7 room database: the five owners (AHE, snapshot, journal, issuance, signing) in one
    database, in disjoint namespaces, with their formats unchanged.
  - A room retirement session: one strict read-write transaction over every room store, held open
    across non-IndexedDB work, with checkpoint, commit and abort.
  - Session facets that run each owner's **original** retirement transitions inside that transaction.
  - The node's closed-retirement install runs on one session per install: T1 (coordinator prepare
    plus participants), a checkpoint, the floor in its own database, then T2.
  - The storage half of slice 14c: per-owner fences in the host floor (opt-in, not yet used by the node).
  - Selection is the opt-in host `createBrowserV3RoomDatabaseStorageHost()` (example) and
    `STARTUP_HEALTHY_GRID_ROOM_DATABASE=1` (Grid). The default host and its six databases are unchanged.
- **Track L residuals, both fixed on the shared path** (§4): the four-epoch reopen refusal
  (`RECOVERY_CERTIFICATE_UNPROVEN_ABSENCE`), and the permanent halt on an unfinished retirement intent at
  reopen.
- **Latency: the goal is not met.** Stage 1a is correct, but it saves only a few percent:

  - creator lull −3% (`LULL=1`) and −9% (concurrent);
  - recipient lull −6% and −4%;
  - seal, creator adoption and the median recipient install are unchanged.

  The lull is dominated by work that stage 1a keeps: per-pass re-acquisition and re-authentication
  (about 45% of a lull in Track E's split), the two-phase commit's steps, the `verifyCompleted`
  whole-image readbacks and the drains. The millisecond
  range needs slice 14b, a decision from carried verified facts with one retirement per epoch. 14b is not
  built.

- **Evidence.**
  - 14f cases 1–4 pass on Chromium 151, Firefox 153 and WebKit 26.5 (18/18).
  - The Grid golden path passes on the room path: every recipient lull including the last, persisted
    close, reopen and continued gameplay. That holds for 8 rollovers (7 runs) and for 16 rollovers
    (1 run). The 16-rollover run then failed a later harness check, the proof-event buffer, as base did
    (§7).
  - SIGKILL cases 5–9 and the browser long-room bounds (case 11) were not run.
- **The default flip is NOT in** (§9).
- `pnpm -r typecheck`: 0 errors. `node scripts/check-shadowed-sources.mjs`: clean.

## 2. Commits

All are on `worktree-agent-aeb6ebdfc4584ace2`, oldest first. Every RED commit precedes the commit that
turns it green.

| Commit   | Kind           | Subject                                                                              |
| -------- | -------------- | ------------------------------------------------------------------------------------ |
| 84fd4c8f | R2 prototype   | test: prototype single-database epoch retirement with crash, replay and poison tests |
| d3cc655d | specs S1–S6    | docs: specify single-database watermark retirement as slices 14a-14f                 |
| 4f0d5e60 | 14c RED        | test: RED for per-owner retirement fences in the host floor (slice 14c)              |
| 0d6258e3 | 14c GREEN      | feat: add opt-in per-owner retirement fences to the host floor (slice 14c)           |
| 9080246e | 14a RED        | test: RED for the room database format and owner room mode (slice 14a)               |
| 04f7b009 | 14a RED fix    | test: use a valid storage object id in the 14a held-view RED                         |
| b087617b | 14a GREEN      | feat: add the version-7 room database and owner room mode (slice 14a)                |
| 166c0d9c | 14a RED        | test: RED for the room retirement session (slice 14a executor)                       |
| 372e465c | 14a GREEN      | feat: add the room retirement session (slice 14a executor)                           |
| 2fee9234 | 14a RED        | test: RED for owner retirement inside one room session (slice 14a)                   |
| 0c4e0309 | 14a GREEN      | feat: run each owner's retirement inside one room session (slice 14a)                |
| c0729b23 | 14a RED        | test: RED for room session acquisition bound to a named owner (slice 14a)            |
| 59d23366 | 14a GREEN      | feat: bind room session acquisition to a named owner (slice 14a)                     |
| 2ff759bb | residual 1 RED | test: RED for a recipient reopen after four rollovers (UNPROVEN_ABSENCE)             |
| a2a77ebd | residual 1 fix | fix: a reopen's retirement request accepts the previous certificate's receipt        |
| 4ffb9574 | 14a RED        | test: RED for room-database retirement in the node (slice 14a)                       |
| 6e9a7899 | 14a GREEN      | feat: run each node retirement install in one room session (slice 14a)               |
| 3bc4edfc | residual 2 fix | fix: a recipient reopen resumes its own unfinished retirement intent                 |
| 981bb354 | Grid opt-in    | test: opt-in room database for the healthy native Grid                               |
| 6c18b0c2 | 14f evidence   | test: native evidence for the room retirement session (slice 14f cases 1-4)          |
| 0eb4d0a6 | 14d guard RED  | test: RED for the room host refusing an existing six-database room                   |
| a07e3206 | 14d guard fix  | fix: the room host refuses an existing six-database room before changing it          |
| cd9d2d88 | docs           | docs: record slice 14 status and native evidence (Track R3)                          |
| 8955d40d | style          | style: format the Track R2 prototype files with prettier                             |
| —        | docs           | docs: record the Track R3 result (the commit that adds this section)                 |

Notes:

- 04f7b009 changes a RED test that this track wrote, before its GREEN. The fixture used an object id that
  the storage layer rejects, so the test failed for the wrong reason. The assertion is unchanged. No
  pre-existing RED or governance test, frozen artifact, registry or vector was edited.
- The RED for residual 2 is a case in `tests/room-database-retirement-native.test.ts` (4ffb9574). That
  case stayed red until 3bc4edfc.
- The brief asked for the trailer "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>". The
  harness required "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>", and every
  commit uses that line.

## 3. Per-slice summary

`sb/` means `packages/storage-browser/tests/`.

| Slice                                                                                                       | Status                          | What landed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Tests                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [14a](../../../../specs/bounded-storage-lifecycle/slices/14a-retention-database-format.md) S1 format        | **Landed as stage 1a (opt-in)** | A version-7 room database: all five owners in one database, in disjoint namespaces, with formats unchanged. A room mode for every owner. A room retirement session: one strict read-write transaction at a time over every room store, kept open across non-IndexedDB work, whole-or-nothing, with checkpoints. Session facets that run each owner's original retirement transitions on that transaction, bound to the genuine owners of the same database. The node's closed-retirement install runs on it (T1, then the floor, then T2). An opt-in example host and a Grid opt-in. **Not landed:** the single "one verified decision, one transaction" retirement with marks as write fences. The install is still the existing two-phase commit with its four passes. | `sb/room-database-format-red`, `sb/room-database-owners-red`, `sb/room-retirement-session-red`, `sb/room-retirement-owners-red`, `sb/room-retirement-owner-binding-red`, `tests/room-database-retirement-native` |
| [14b](../../../../specs/bounded-storage-lifecycle/slices/14b-retention-trust.md) S2 trust                   | **Not started**                 | The ledger of verified facts, verify-on-open of the retained window and the decision from carried facts are not built. The room path keeps every per-pass re-authentication.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | —                                                                                                                                                                                                                |
| [14c](../../../../specs/bounded-storage-lifecycle/slices/14c-host-floor-retirement-fence.md) S3 floor fence | **Storage landed, not wired**   | Floor version 2, opt-in (`retirementFences: true`), with per-owner fence entries `{through, base, target}` written in one strict transaction with the floor image. Monotone, fail-closed, and they hide no rows. The node does not write these entries yet. On the room path the floor keeps its existing participant, ordered after a session checkpoint.                                                                                                                                                                                                                                                                                                                                                                                                               | `sb/room-head-retirement-fences-red`                                                                                                                                                                             |
| [14d](../../../../specs/bounded-storage-lifecycle/slices/14d-retention-migration.md) S4 migration           | **Not started**                 | `prepareBrowserRoomDatabase` can upgrade a version-6 main database to a migrating layout, which every owner refuses. The example host does not use that upgrade: it refuses an existing six-database room before changing anything (`V3_ROOM_DATABASE_MIGRATION_UNAVAILABLE`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `tests/room-database-retirement-native` (legacy refusal)                                                                                                                                                         |
| [14e](../../../../specs/bounded-storage-lifecycle/slices/14e-retention-bounds-and-charges.md) S5 bounds     | **Not started**                 | Owner bounds and proof charges apply unchanged inside the session. There is no per-transaction cap.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | —                                                                                                                                                                                                                |
| [14f](../../../../specs/bounded-storage-lifecycle/slices/14f-retention-native-evidence.md) S6 evidence      | **Partial**                     | Cases 1–4 pass on Chromium, Firefox and WebKit. Case 10 (Grid golden path, Chromium) passes. Cases 5–9 (SIGKILL) and 11 (browser long-room bounds) are open.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `sb/room-retirement-session-native.pw.ts`; Grid runs                                                                                                                                                             |

Findings made while wiring the node:

- **One module instance.** The room owners and the session registry must come from one module instance,
  or the session refuses the owners. `@ts-drp/storage-browser/maintenance` re-exports every room factory
  for that reason. A bundle that aliases `@ts-drp/storage-browser` to a file also needs a `maintenance`
  alias; the Grid's `build.ts` has one now.
- **Filtered issuance facade.** In the retirement context the creator's issuance owner is v3-live's
  filtered facade, not the genuine store. The session binds issuance through the genuine store's
  maintenance capability. A facade without that association is refused with `RETENTION_FOREIGN_OWNER`.
- **Web Locks.** The browser snapshot owner refuses retirement exclusion without Web Locks, on both hosts.
  The node-level room test installs a FIFO process lock manager. Browsers use the native one.
- **Source-shape test.** `creator-ordinary-settlement-capacity.test.ts` reads the body of
  `installClosedRetirementSource` by name, and the Grid's `build.ts` instruments it by name. The original
  function therefore keeps its name and body. A separate wrapper, `installClosedRetirementSourceInRoom`,
  opens the session, and only the reconcile call site uses it.

## 4. Track L residuals

1. **`RECOVERY_CERTIFICATE_UNPROVEN_ABSENCE` at a recipient reopen after 4 rollovers.**
   - **Root cause.** `acquireCreatorSnapshotRetirementReconstructionRequest` checked absence against the
     current certificate's receipt only. After four rollovers, the current Cut still classifies a scope
     that this copy retired under its previous certificate. The prior survivor's receipt lists that scope,
     and the current one does not. The full reconstruction passes the authenticated predecessor
     certificate to the same law and accepts. The request did not pass it, so the room refused to open.
     Five and eight rollovers pass because the classified window no longer contains such a scope.
   - **Fix (a2a77ebd, shared path).** The reopen passes the previous Cut from the authenticated current
     generation (exact epoch `currentEpoch - 1`) and the predecessor trust. The law is unchanged, and the
     request still grants nothing.
   - **Status.** The old path no longer has this failure either. RED: 2ff759bb
     (`tests/recipient-lull-reopen-four-epochs-native.test.ts`, which runs Track L's scenario at 4).
2. **An active retirement intent at a recipient reopen halted the recipient for good.**
   - **Root cause.**
     - The recipient resume gate in `runCreatorReceivedRecoveryMaintenance` accepted only a completed
       control (`active === null`).
     - Activation halts admission while `active !== null`, and `creatorRetirementResumeRequested` asks for
       the original reconstruction.
     - So nothing ever discharged the halt.
   - **Fix (3bc4edfc, shared path).** The gate also accepts an active intent that this copy prepared at
     the same present head, under the same reconstruction and room-head conditions. The original received
     reconstruction then completes that same intent or refuses:
     - its install requires the stored preparation's source proof and decision to equal the freshly
       authenticated ones;
     - it never prepares a different intent over it.
   - **Evidence on the room path.** A crash is injected at the session's final commit, after T1 and the
     floor have committed. After the reopen, `active` is null and `completed` runs through the epoch. The
     next move, the next rollover and the next lull all pass.
   - **On the old path.** The code is shared, but no SQLite crash injection was built for it.

## 5. Guarantees G1–G28

"Stage 1a" means what landed: one room database, the retirement session, the node install on it and the
residual fixes. It does not mean the full slice-14 design. Test paths are relative to the repository root.

| Id  | Guarantee (short)                         | Status on the room path (opt-in)                                                                                                                                                                                                                                                                                               | Evidence                                                                                                                    |
| --- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| G1  | No growth with room age                   | Kept as on the default path: the session runs the same transitions, so every owner's bounds and retained window are unchanged. The 16-rollover runs match base store for store (§7). The recipients' issuance rows grow on **both** paths (§7). The browser long-room bounds assertion (14f case 11) is not built.             | 16-rollover Grid, room and base (§7); `tests/recipient-long-room-journal-retention-native.test.ts` (default path) green     |
| G2  | Backpressure; accepted work finishable    | Kept: admission, backpressure and finishability are unchanged.                                                                                                                                                                                                                                                                 | Grid continued gameplay; `tests/room-database-retirement-native.test.ts`                                                    |
| G3  | Golden path stays correct                 | Kept on the Grid golden path: every rollover, every lull including the last, then persisted close, reopen and continued gameplay.                                                                                                                                                                                              | `run-accept-room-1`, the 6 room bench runs and the 16-rollover room run (Chromium)                                          |
| G4  | No terminal resurrection                  | Kept: close and terminal handling are unchanged. A session belongs to one install, inside the maintenance job that close joins.                                                                                                                                                                                                | Track L's `tests/recipient-lull-reopen-close-native.test.ts` green; Grid close and reopen                                   |
| G5  | Stored bytes untrusted; re-verify on open | Kept, unchanged: the room path keeps every per-pass re-acquisition and re-authentication. 14b, which would carry verified facts, is not built.                                                                                                                                                                                 | No new trust shortcut: the body of `installClosedRetirementSource` changes only in how it acquires owners                   |
| G6  | Rollback not prevented in-origin; custody | Kept: the floor stays its own database and custody model. The session never touches it.                                                                                                                                                                                                                                        | `sb/room-head-retirement-fences-red.test.ts` (floor stays version 1 without the opt-in)                                     |
| G7  | One decision owner                        | Kept: the node planner is still the only decision owner. The session is a mechanical executor.                                                                                                                                                                                                                                 | Code review                                                                                                                 |
| G8  | Watermark is not authority                | Kept: this path has no watermark. Every owner's control is authoritative only as before.                                                                                                                                                                                                                                       | Code review                                                                                                                 |
| G9  | Owner rechecks in its own transaction     | Kept, and stronger: each owner runs its original in-transaction checks and transitions on the session's strict transaction, so its recheck and its write share one native transaction.                                                                                                                                         | `sb/room-retirement-owners-red.test.ts` (each owner writes exactly the default path's control)                              |
| G10 | No stage-crossing currency                | Kept: nothing new outlives a stage. Reads inside the session are current only for that transaction.                                                                                                                                                                                                                            | Code review                                                                                                                 |
| G11 | Currency reuse only in a held transaction | Kept: currency is reused only inside the session's held native read-write transaction.                                                                                                                                                                                                                                         | `sb/room-retirement-session-red.test.ts`; 14f case 3 (3 engines)                                                            |
| G12 | Native read-write exclusion               | Kept, natively: a foreign read-write transaction on any room store runs before or after the session, never interleaved.                                                                                                                                                                                                        | 14f case 3: another page's strict writer completes only after the session commits (Chromium, Firefox, WebKit)               |
| G13 | Locks are advisory only                   | Kept: no lock decides anything. The snapshot owner's existing Web Locks use (scheduling) is unchanged.                                                                                                                                                                                                                         | Code review                                                                                                                 |
| G14 | One resumable intent, ordered steps       | Kept: the same single intent and the same ordered steps. The session commits T1, then the floor runs in its own database, then T2. Each committed state is one that the per-owner two-phase commit also reaches. A crash between T1 plus the floor and T2 leaves one active intent, which the reopen now resumes (residual 2). | `tests/room-database-retirement-native.test.ts` (crash-injection case); `sb/room-retirement-owners-red.test.ts`             |
| G15 | Old XOR new                               | Kept for the cases covered: an abort or a failure discards everything since the last checkpoint, so the result is the old state or the checkpointed prefix. SIGKILL is not covered (14f cases 5–8 open).                                                                                                                       | 14f case 2 (3 engines); `sb/room-retirement-session-red.test.ts`                                                            |
| G16 | Strict durability                         | Kept: the session refuses a non-strict transaction (`RETENTION_DURABILITY`) before its first write, and each engine reports `strict`.                                                                                                                                                                                          | 14f case 1 (Chromium 151, Firefox 153, WebKit 26.5); `sb/room-retirement-session-red.test.ts`                               |
| G17 | No resurrection                           | Kept: the owners' write fences are unchanged. The version-7 room database fences version-6 code and closes old connections. A higher version ends a session, and code pinned to version 7 gets `VersionError`. The per-owner floor fences (14c) exist but the node does not use them yet.                                      | `sb/room-database-format-red.test.ts`; 14f case 4 (3 engines)                                                               |
| G18 | Protected set                             | Kept: the protected set and owner rules are unchanged.                                                                                                                                                                                                                                                                         | Owner suites unchanged (§8)                                                                                                 |
| G19 | Issuance retention rules                  | Kept: the issuance rules are unchanged, and the session binds only the genuine owner (`RETENTION_FOREIGN_OWNER` otherwise).                                                                                                                                                                                                    | `sb/room-retirement-owner-binding-red.test.ts`                                                                              |
| G20 | Snapshot lifecycle                        | Kept: the snapshot lifecycle is unchanged.                                                                                                                                                                                                                                                                                     | Code review                                                                                                                 |
| G21 | Bounded work                              | Kept: every operation in a session is an existing owner transition with its existing bounds, and a session transaction is their bounded sum. The per-transaction cap of 14e is not built.                                                                                                                                      | Code review                                                                                                                 |
| G22 | Proof budget                              | Kept: the charges are unchanged (`accounting.charge` before each owner's effects, as before).                                                                                                                                                                                                                                  | `packages/node/tests/creator-closed-rollback-proof-accounting.test.ts`: the same 20 failures as base, with identical names  |
| G23 | FIFO lull ingress                         | Kept: the lull's FIFO ingress is unchanged. Moves issued during a lull still queue and land.                                                                                                                                                                                                                                   | Grid concurrent mode (§7)                                                                                                   |
| G24 | Floor never repaired                      | Kept: the session commits before every floor effect, so a floor fence never precedes its coordinator intent. The floor is never repaired.                                                                                                                                                                                      | Code (`checkpoint()` before `prepareFence` and `commitPrepared`); Grid                                                      |
| G25 | Fenced, authenticated migrations          | Kept by refusal. There is no migration (14d not built), so the room host serves only new rooms. An existing six-database room is refused before its main database changes (`V3_ROOM_DATABASE_MIGRATION_UNAVAILABLE`), so no second authority can arise.                                                                        | `tests/room-database-retirement-native.test.ts`, "refuses an existing six-database room without changing its main database" |
| G26 | Latency never relaxes safety              | Kept: no check is relaxed.                                                                                                                                                                                                                                                                                                     | This table                                                                                                                  |
| G27 | No game-specific carve-outs               | Kept: nothing is game-specific.                                                                                                                                                                                                                                                                                                | Code review                                                                                                                 |
| G28 | Native three-engine and SIGKILL evidence  | **Partial.** 14f cases 1–4 pass in all three engines, and the Grid golden path passes in Chromium. SIGKILL cases 5–9 and the browser long-room bounds (case 11) are open.                                                                                                                                                      | §6                                                                                                                          |

## 6. Slice 14f (S6) evidence per engine

Command: `cd packages/storage-browser && ../../node_modules/.bin/playwright test --config
playwright.room-retirement-session-native.config.ts` (source commit 6c18b0c2; log
`<evidence>/track-r3/logs/s6-session-native-3.{log,json}`). Result: 18/18 passed.

| Case                                                                                                                                                                                                                        | Chromium 151.0.7922.34                                 | Firefox 153.0               | WebKit 26.5 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | --------------------------- | ----------- |
| 1. The session transaction reports `durability === "strict"` and mode `readwrite`. (The refusal of a non-strict transaction is tested only in the fake-indexeddb RED.)                                                      | pass                                                   | pass                        | pass        |
| 2. One transaction over every owner store: an abort at the last request changes nothing; a commit adds exactly one row per store; after an owner refusal the commit is refused and nothing changes; a checkpoint is durable | pass                                                   | pass                        | pass        |
| 3. Another page's strict writer on an overlapping store completes only after the session commits, and its write is ordered last                                                                                             | pass                                                   | pass                        | pass        |
| 4. Another page opens version 8: the session ends, its uncommitted write is absent, a new session is refused, and code pinned to version 7 gets `VersionError`                                                              | pass                                                   | pass                        | pass        |
| A database that is not ready (legacy version 6, or missing) is refused before any write                                                                                                                                     | pass                                                   | pass                        | pass        |
| 5–8. SIGKILL inside or between the steps                                                                                                                                                                                    | OPEN                                                   | OPEN                        | OPEN        |
| 9. SIGKILL during migration                                                                                                                                                                                                 | OPEN (no migration)                                    | OPEN                        | OPEN        |
| 10. Grid golden path with the room path selected                                                                                                                                                                            | pass (`run-accept-room-1`, plus the 6 room bench runs) | n/a (Grid is Chromium-only) | n/a         |
| 11. Browser long room, at least 16 epochs, with bounds asserted                                                                                                                                                             | OPEN: no bounds assertion; one 16-rollover run, see §7 | n/a                         | n/a         |

Case 3's "a write below a new mark is refused" does not apply, because stage 1a has no marks. The owners'
existing write fences are unchanged.

## 7. Benchmark against base

**Setup.**

- Healthy native Grid, Chromium, 8 rollovers, 3 interleaved ABBA pairs per mode: `LULL=1`, and concurrent
  moves during lulls. That is 12 runs, all passed (continued gameplay, epoch 8).
- Base is the default host. Room is `STARTUP_HEALTHY_GRID_ROOM_DATABASE=1`. Both use one bundle, built
  from the tree committed as 981bb354. Within each pair the order alternates (base first in pairs 1 and
  3, room first in pair 2).
- a07e3206 (the legacy-room refusal) came later. It adds one version probe per database per host at
  startup and does not touch the retirement path.
- The machine was shared and loaded, so only the interleaved pairs are compared.
- Every room run committed 54 room sessions, with no aborts.
- Raw data: `<evidence>/track-r3/grid/run-b1-*`. Tables: `<evidence>/track-r3/grid/bench-b1-table.txt`
  and `longest-table.txt`. Scripts: `<evidence>/track-r3/bin/`.

**Per-transition latency.** Each figure is the median over the steady transitions of the per-transition
median over 3 runs, in ms. Steady is t3–t7 for seal, adoption and install, and t4–t8 for the lulls. The
"max over recipients" is used for the install and the recipient lull.

| Window            | `LULL=1` base | `LULL=1` room | room/base | concurrent base | concurrent room | room/base |
| ----------------- | ------------- | ------------- | --------- | --------------- | --------------- | --------- |
| Seal              | 292           | 291           | 1.00      | 310             | 313             | 1.01      |
| Creator adoption  | 524           | 520           | 0.99      | 592             | 591             | 1.00      |
| Recipient install | 349           | 364           | 1.04      | 414             | 422             | 1.02      |
| Creator lull      | 2450          | 2376          | **0.97**  | 2937            | 2667            | **0.91**  |
| Recipient lull    | 1350          | 1272          | **0.94**  | 1503            | 1437            | **0.96**  |

- Every per-transition creator-lull median from t4 to t8 is lower on the room path, in both modes
  (ratios 0.85–0.98).
- The median recipient install is unchanged. Its tail is wider on the room path:

  - over all t3+ samples (n=45 per variant), p90 rose from 380 to 462 ms (`LULL=1`) and from 424 to
    528 ms (concurrent);
  - samples above 500 ms went from 2 to 4, and from 2 to 5.

  Three pairs cannot tell whether this is noise. A room session holds every room store for its duration,
  so a longer wait behind it is plausible.

- **Room session durations** (one strict transaction per install, from the session's proof events):
  - `LULL=1`: n=162, p50 106 ms, p90 127 ms, max 358 ms;
  - concurrent: p50 116 ms, p90 155 ms, max 377 ms.

**Per-move latency during lulls** (concurrent mode, epochs 4 and later, in ms):

| Moves issued during | n per variant | Issue p50 base → room | Issue max   | Remote visible p50 | Remote visible max |
| ------------------- | ------------- | --------------------- | ----------- | ------------------ | ------------------ |
| Creator lull        | 60            | 73.2 → 70.8           | 3583 → 3153 | 2096 → 1913        | 3521 → 3091        |
| Recipient lull      | 30            | 108.8 → 112.0         | 155 → 175   | 1065 → 983         | 1331 → 1285        |

- Remote visible is the time until the last remote peer shows the move. Moves issued during a lull queue
  FIFO behind it (G23), so the visible latency tracks the lull's length.
- **Durable latency was not measured.** The harness does not record per-move receipt stages in this mode.

**Longest main-thread task per window** (trace `RunTask` on the renderer main thread, in ms). Steady
windows are counted only where the task trace covers them. The trace buffer ends before the last one or
two windows.

| Window            | `LULL=1` base median / max | `LULL=1` room median / max | concurrent base median / max | concurrent room median / max |
| ----------------- | -------------------------- | -------------------------- | ---------------------------- | ---------------------------- |
| Seal              | 15.8 / 16.2                | 16.1 / 16.3                | 18.8 / 19.2                  | 18.7 / 19.3                  |
| Creator adoption  | 33.2 / 47.3                | 32.0 / 50.5                | 36.1 / 53.6                  | 36.6 / 51.7                  |
| Recipient install | 7.5 / 9.1                  | 7.8 / 9.5                  | 7.6 / 8.8                    | 7.7 / 9.4                    |
| Creator lull      | 27.2 / 31.4                | 27.1 / 32.6                | 31.4 / 33.8                  | 31.4 / 32.8                  |
| Recipient lull    | 10.7 / 14.3                | 10.5 / 11.8                | 9.5 / 12.0                   | 10.0 / 13.5                  |

No window gains a long task.

**Why the gain is small.** Track E split a lull roughly into:

- about 45% re-acquisition and re-authentication, across four passes;
- about 30% cross-database two-phase commit;
- about 15% drains.

Stage 1a fuses each install's per-owner transactions into one. It keeps the two-phase commit's records,
steps and passes, so it removes transaction overhead only, and recovered 3–9%. It also still reads back
whole images in `verifyCompleted` and runs the journal and signing drains after the session. Moving more
of that work into the session would save transactions, but not its decode and hash CPU.

The lever is 14b: decide once per epoch from verified facts carried in memory, then run one retirement
transaction. The R2 prototype measured that shape at a p50 of about 7 ms per epoch in Chromium (below).

**16 rollovers (partial evidence for 14f case 11).**

- One run per path: `LULL=1`, `<evidence>/track-r3/grid/run-long16-{room,base}-1`.
- Both reached epoch 16, every lull, persisted close, reopen and continued gameplay (`receipt.ok`).
- Both then failed the same harness check, `proofEventsTruncated === false`: the proof-event buffer
  overflows somewhere between 8 and 16 rollovers on either path. This is a harness limit and is not
  specific to the room path.
- Store by store, adopted-8 against adopted-16 is identical on both paths:

  - The creator is flat (193 rows, about 303 KB of binary fields).
  - Every recipient's issuance grows by 3 issued records and 3 outbox rows per epoch (26 → 50 each,
    issuance image 33 → 56 KB).
  - Everything else is flat.

  The recipient issuance growth is pre-existing and not caused by this track. It is relevant to
  G1 and to 14f case 11. Script: `<evidence>/track-r3/bin/growth_diff.py`.

## 8. Suites against base

The suites ran from the worktree root at a07e3206 (the later commits change only docs and formatting),
with `--exclude ".claude/**" --exclude "**/.logs/**" --no-coverage --testTimeout=120000`. Reports:
`<evidence>/track-r3/tests/head-*.json`. The comparison is per test, by file and full name. A "new
failure" is a test that fails at head and did not fail at base.

| Set                                                  | Head result                                                           | Base used                                                                                                                                             | New per-test failures                                                                               |
| ---------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `packages/node`                                      | 1071 tests, 1023 passed, 48 failed                                    | Track L's final run of its head, the code merged into 4bb6bc7d (1070 tests, 48 failed); also an earlier swap of the node and seal sources to 4bb6bc7d | **0** (the extra test at head is `interval-reconnect`, which failed to load at L's run, and passes) |
| `packages/storage` and `packages/storage-browser`    | 625 of 625 passed                                                     | —                                                                                                                                                     | **0**                                                                                               |
| storage-node retirement set (6 files)                | 209 tests, 158 passed, 49 failed, 2 skipped                           | Track L's run at its head (identical counts)                                                                                                          | **0**                                                                                               |
| Root set (92 path filters; vitest matched 187 files) | 1036 tests, 676 passed, 336 failed, 24 skipped; 70 files had failures | Those 70 failing files run at 4bb6bc7d in this worktree, with every changed code file swapped back to base (141 files matched)                        | **0**                                                                                               |

- The storage set printed one vitest RPC timeout (`Timeout calling "onTaskUpdate"`) while its nested
  clean-checkout gate ran (61 s under load), so vitest exited 1 with no failed test. The gate itself
  passed.
- In the root set, 1 test failed at base and passed at head
  (`d110c-0c1f5b0a-settlement-codec-red`, the bounded advance predicate). This track does not touch
  it.
- One root test failed at both, but for a different reason at head:
  `phase-3-exit-envelope-purity-red`, "keeps both node runtime entrypoints unchanged". At head it failed
  with a module-initialisation `ReferenceError`. Rerun alone at head, it fails exactly as at base (the
  node root's exports differ from the pinned list).
- Failures that are the same at base and head include load errors (`@grpc/grpc-js`, the
  `@ts-drp/storage-node/room-head` dist, the `@ts-drp/object` dist for `spawn-scaling`), fixture
  requirements (`SHIPPING_CHAT_CATALOG_DIR`, `R11_DISPOSABLE_FIXTURE_REQUIRED`,
  `ROLE_FROZEN_ARTIFACTS_AND_EVIDENCE_REQUIRED`), many existing RED and governance pins, and
  load-related timeouts.
- The room path's own tests pass:

  - `tests/room-database-retirement-native.test.ts`, 4 of 4;
  - Track L's `tests/recipient-lull-reopen-close-native.test.ts`, 3 of 3;
  - Track K's `tests/recipient-long-room-journal-retention-native.test.ts`, 2 of 2;
  - `tests/recipient-lull-reopen-four-epochs-native.test.ts`, 3 of 3 (run separately at HEAD).

  The last three run on the default host.

- `pnpm -r typecheck` reports 0 errors, and `node scripts/check-shadowed-sources.mjs` is clean.

## 9. Default flip

**The default flip is NOT in.** The room database stays opt-in: `createBrowserV3RoomDatabaseStorageHost()`
in the example, and `STARTUP_HEALTHY_GRID_ROOM_DATABASE=1` for the Grid. The default host, its six
databases and its per-owner path are unchanged. The flip's conditions are not met:

1. 14f is incomplete: SIGKILL cases 5–9 and the browser long room (case 11) have not run.
2. 14b, 14d and 14e are not implemented. Without 14d, an existing room cannot move to the room database,
   so the default host could only serve new rooms.
3. Flipping would buy little latency (§7).

## 10. What remains, and the risks

**What remains, in order:**

1. **14b, the actual latency fix.**
   - Build the in-session ledger of verified facts, verify-on-open of the retained window, and the
     decision from carried facts, with exact-byte checks inside the acting transaction.
   - That removes the per-pass re-acquisition and re-authentication, about 45% of a lull, and with them
     the four passes.
   - Only then can one retirement per epoch run as one room transaction (the 14a end state), and only
     then can the millisecond range be reached. Stage 1a is the executor that this will run on.
2. **Wire 14c into the node.** Write the per-owner floor fence as step A and check it on open. Today the
   room path keeps the floor's existing two-phase participant, ordered after a session checkpoint.
3. **14d migration.** Fence, verbatim copy with receipt, then empty and keep fenced, with its crash
   matrix. Until then the room host refuses existing rooms.
4. **14e.** The per-transaction cap, and charge-before-first-delete for the single retirement
   transaction.
5. **14f.**
   - SIGKILL cases 5–8 on the room path, with the death harness of
     `phase-3a1b-p4-browser-live-journal-death-red.pw.ts`. The kill points are inside T1, between T1 and
     the floor, between the floor and T2, and inside T2.
   - Case 9, once 14d exists.
   - Case 11, the browser long room with steady-state bounds. It needs a fix or an explicit bound for the
     recipients' issuance growth (§7), and a Grid proof-event budget that survives 16 rollovers.
6. **Joint verification inside the session (optional, small).** Today `verifyCompleted` re-reads every
   owner after the session commits, and the drains run after it. Moving them into the session saves
   transaction overhead, but not their decode and hash CPU.

**Risks:**

- **Session hold time.** The session holds one read-write transaction over every room store, for about
  106–116 ms at p50 and up to about 380 ms per install. Gameplay writes to the room database wait behind
  it. The concurrent Grid shows no regression in per-move latency during lulls. The recipient install's
  p90 is wider on the room path (§7, unresolved).
- **Web Locks.** Node has no Web Locks, and the browser snapshot owner refuses retirement exclusion without
  them. Node-level tests must install a lock manager.
- **Module instances.** The room owners and the session registry must come from one module instance (§3).
- **Filtered facade.** A future change that mints new issuance facades must keep the maintenance
  capability association. Otherwise the room path refuses with `RETENTION_FOREIGN_OWNER` (fail closed).
- **Shared-path fixes.** The two residual fixes change the default path too. Their evidence is:

  - the four-epoch RED;
  - Track L's tests;
  - the long-room test;
  - the room crash test.

  No SQLite crash injection exists for residual 2.

- **Environment notes.** Some packages failed to load in the node suite for environmental reasons, at
  base and at head (§8). The worktree's `node_modules` received a copy of the `node_datachannel.node`
  binary from the main checkout (read only there), so that the node-datachannel tests could load.

---

# Track R2 result

* Worktree: `<worktree agent-aeb6ebdfc4584ace2>/`.
* Branch: `worktree-agent-aeb6ebdfc4584ace2`.
* Base: de70325e.
* Commit: **676b09c1**, "test: prototype single-database epoch retirement with crash, replay and
  poison tests". After the rebases onto Tracks K and L it is **84fd4c8f**. 8955d40d later formatted its
  two files with prettier, so line counts below are those of 676b09c1.
* Patch: `track-r2.patch`, next to this file.
* Guarantee ids are from `scratchpad/track-r/GUARANTEES.md`. The Step 4 design and the full G1–G28
  argument are in `STEP4.md`. All other paths here are relative to
  `scratchpad/track-r2/`.

## 1. Outcome in brief

* **Step 4 verdict (`STEP4.md`).** A single-database watermark retirement can satisfy G1–G27. G28,
  native three-engine and SIGKILL evidence, is still owed. Three conditions apply:
  1. The trust model is "verify on arrival and on every open; in session only in-memory verified
     facts are authority". Track E's "trusted after ingress" is rejected under G5 and G8.
  2. The watermark is a write fence, an index and a resume point, never an authority.
  3. The host floor stays a separate custody database. A per-owner floor fence is written first
     (step A), then one strict retention transaction runs (step B).

  It cannot replace the production path this cycle. It changes formats, digest domains and the
  database layout (the 6B:63 non-goal), and it needs an authenticated migration and native
  evidence. Spec slices S1–S6 are in §6.
* **Committed: an opt-in, unwired prototype of that store.**
  * `packages/storage-browser/tests/prototypes/epoch-retirement-store.ts`, 967 lines.
  * `packages/storage-browser/tests/epoch-retirement-store.test.ts`: 29 tests over
    fake-indexeddb, including one fast-check property.
  * Mutation check (`bin/mutate.py`, `tests/mutation-final.log`): 17 of 18 mutants killed. The
    survivor drops a guard that only matters for two concurrent migrators, and is equivalent under
    sequential execution.
  * Chromium, strict durability on disk, 48 rows (about 170 KiB) retired per epoch, a 144-row
    window, 3 × 57 retirements: **retire p50 6.7–7.1 ms**.
    * Step A (floor) is about 1.5 ms; step B (retention) is about 5.3 ms.
    * p95 is 9.1–10.2 ms; max is 16–28 ms.
    * `verifyOnOpen` of the window takes 5.6–7.4 ms. Its verifier is a SHA-256 tag, not Ed25519.

    The current Grid lull is 2.4–3.0 s per epoch.
  * The prototype is not wired. The Grid bundle built from 676b09c1 is **byte-identical** to the
    base bundle (`diff -rq` of the whole bundle tree is empty), so it cannot change Grid latency.
* **Not committed: the pump-cost reduction, option (a).**
  * I salvaged it from the stopped worktree:
    * one bound sentinel handler pair;
    * native-active turn admission;
    * plus an empty-queue fast path I added.
  * Review found it sound, and its 6 tests pass. Two of them fail on base, so they pin the new
    behaviour.
  * Measured in 4 interleaved blocks (16 runs), it gave **no measurable lull gain** (§5).
  * The brief's salvage rule is "sound *and* measurably helps", so it was left out of the commit.
    The patch is `pump-not-landed.patch` and its tests are
    `draft/native-read-reservation-turn.test.ts.final`.
* **Not attempted: stage fusion, option (b).** It still needs a durable format and policy change
  plus a spec slice. Track R's Step 3 verdict stands.

## 2. What was implemented

### Placement

The prototype lives under `tests/prototypes/`, not `src/`. My first placement, in
`src/internal/`, made two governance tests fail:

* `idb-ownership-controls.test.ts`, "allows only the governed raw-IDB owner modules";
* `phase-2d2a-idb-adapter-governance-red.test.ts`.

Both failed with 144 violations. The IDB ownership checker allows raw IndexedDB only in reviewed
owner modules under `src/`. Registering an unwired prototype as a production owner would be
premature, so I moved it under `tests/`. There it is typechecked and tested, but never built,
shipped, exported or imported by production code. Promoting it into `src/` means registering it
with that checker as a reviewed owner, after the spec slices.

### Store and operations

The store is one IndexedDB database, version 1, with five stores:

| Store | Key |
|---|---|
| `retainedRows` | `[owner, scope, epoch, kind, id]` → exact bytes |
| `retainedBlobs` | `[scope, digest]`, with a `["scope","lastRef"]` index |
| `retainedHeads` | `scope` |
| `retirementMarks` | `[scope, owner]` → `{fence, drained, revision, decision}` |
| `migrationReceipts` | legacy database name |

Operations:

* **`verifyOnOpen`.** Checks, in this order:
  * the head must equal the verified head;
  * every row above its fence is re-verified by the caller's verifier;
  * every blob must satisfy `digest(bytes) == key`.

  Marks are read before the per-owner host floor:
  * a mark above the floor is `CORRUPT`;
  * a mark inside the protected set is `CORRUPT`;
  * a floor above a mark only raises that mark's write fence and deletes nothing.

  An unverified scope refuses every other call with `UNVERIFIED` (G5).
* **`append`.** One strict transaction. Each owner's mark is read inside it as a write fence. An
  epoch at or below the fence is `RETIRED`, and the whole batch makes zero writes. Rows are
  immutable exact bytes:
  * different bytes under an existing key are a `CONFLICT`;
  * the same key twice in one batch with different bytes is also a `CONFLICT`.

  Blobs are verified on arrival, and blob references at or below the `#blobs` mark are refused.
* **`replace`.** A late update or acknowledgement. The same fence applies, and a refusal is
  `RECORD_PRUNED`.
* **`retire(decision)`.** The decision comes from the caller's in-memory verified facts.
  * **Step A** runs `floor.fence(scope, {owner: through})`: one strict transaction in a separate
    database, monotone per owner.
  * **Step B** is one strict transaction with no non-IndexedDB awaits:
    1. exact head compare, `HEAD_CHANGED` on a mismatch;
    2. marks, with `CORRUPT` and `STALE` checks;
    3. a bounded `getAll(range, cap+1)` census per owner, charged against the budget before any
       delete. A protected key inside the range is `CORRUPT`. Pending or malformed rows, or going
       over the cap, block only that owner;
    4. exact-compare rewrites, such as the AHE lineage-floor rewrite;
    5. blobs selected by `lastRef` but kept if protected;
    6. range deletes, rewrites and blob deletes, then the marks.

    Every refusal aborts the transaction, so it makes zero writes.
* **`migrateLegacy`.** Four steps:
  1. fence each legacy database: reopen it at `version+1`, adding only a `migrationFence` store;
  2. authenticate every row through the caller's `carry`. A throw fails the migration closed;
  3. advance the floor, then copy rows, fences and a receipt (a digest over the copied keys and
     bytes) in one strict transaction;
  4. delete the legacy database. Once a receipt exists, the legacy database is only deleted, never
     read again.

### A design error found and fixed during the work

The first version kept one scope-wide floor fence. When the planner held issuance back below a
verified pending record, that fence still hid the pending row and refused its acknowledgement with
`RECORD_PRUNED`. That violates G19 and G2.

The floor fence is now per owner. The test "pending work the planner knows of holds back only its
own owner; it stays readable and finishable" and the mutant `scope-wide-floor` pin the fix.
`STEP4.md` §2.3 records it.

## 3. Guarantee-by-guarantee argument

**Production path.** Nothing changes: the shipped dist and the Grid bundle are identical to base.
G1–G4, G6, G7, G16, G18, G20, G21, G23, G24 and G27 therefore hold exactly as on de70325e.

**The prototype's own claims**, and the tests and mutants that pin them:

| id | Prototype behaviour | Pinned by |
|---|---|---|
| G5 | Verify on arrival (blobs); verify on every open; `UNVERIFIED` gate | "a flipped byte…", "nothing is read, written or retired … before it is re-verified", "blobs: … refused on arrival and on open"; mutants `verify-on-open-skips-rows`, `no-blob-arrival-verify` |
| G7, G8 | Only a verified decision deletes. Marks are fences, never authority; rows below a rolled-back mark are hidden, not deleted, until a decision | "marks rolled back below the host floor…"; mutants `hide-nothing-on-read`, `no-fence-raise-on-open` |
| G9, G11, G12 | Head, marks and candidates rechecked inside the same read-write transaction that deletes (native exclusion) | "a foreign head change … HEAD_CHANGED", "a protected key inside a retired range … CORRUPT"; mutants `no-head-check`, `no-protected-key-check`, `stale-mark-check-off` |
| G14, G15 | One checkpoint (the mark), atomic with the deletes; floor first, then retention; old XOR new; idempotent replay | "crash at every step" (before-floor, after-floor, after-reads, after-deletes, after-commit), "replays idempotently", the property test; mutants `no-floor-step`, `mark-drained-not-written` |
| G16 | `durability:"strict"` required, otherwise `DURABILITY` | code only. fake-indexeddb always reports strict, so native evidence is owed |
| G17 | In-transaction writer fence; `RETIRED` and `RECORD_PRUNED`; a newer version closes old connections; old pinned versions get `VersionError` | "refuses any append at or below the fence…", "late acknowledgement…", "a newer schema closes this connection…"; mutants `no-writer-fence`, `no-blob-fence` |
| G18 | Monotone marks and floor; stale decisions are no-ops; lineage-floor rewrite exact-compared in the same transaction | "replays idempotently… never lowers a mark", "an owner rewrite (AHE lineage floor)…" |
| G19, G2 | Pending or malformed rows block only their owner, with zero writes. Planner-held-back pending work stays readable and finishable | "a malformed or pending issuance candidate…", "pending work the planner knows of…"; mutants `no-classifier-block`, `scope-wide-floor` |
| G21, G22 | Bounded census; every read byte charged before the first delete; over budget means zero writes | "over-budget or over-cap census…"; mutant `no-budget` |
| G24, G6 | Floor regression, a mark above the floor, or an older head fails closed and is never repaired. Whole-origin rollback is not claimed | "a regressed host floor…", "the whole retention database rolled back…", "a mark rolled forward…"; mutant `no-floor-corrupt-on-open` |
| G25 | Fence before read, authenticate, atomic copy with receipt, idempotent delete. Unverifiable rows fail closed and the legacy database stays fenced | 4 migration tests; mutant `migration-no-fence` |
| G26 | No check relaxed | — |
| G28 | **Not met.** fake-indexeddb is mechanism evidence, and the Chromium micro-benchmark measures cost only | — |

## 4. Test before/after diff

Scripts and data:

* runner: `bin/suite.sh`;
* reports: `tests/before-*.json` and `tests/after-*.json`;
* diff: `bin/diff-tests.py` → `tests/diff-before-after.txt`.

Before ran on pristine de70325e, with pristine dist. After ran with the final change in place, with
the prototype then still in `src/internal/` (see the governance row). Load was 11–86 before and
27–95 after.

| Suite | Before (tests / passed / failed) | After | New failures |
|---|---|---|---|
| storage¹ | 1244 / 934 / 305 | 1273 / 960 / 308 | 4, all explained below |
| storage-browser | 296 / 295 / 1 | 325 / 321 / 4 | 4, explained below |
| seal (`packages/seal`) | 0 test files | 0 test files | — |
| seal root tests² | 12 / 2 / 7 | 12 / 2 / 7 | 0 |
| node | 934 / 899 / 35 | 934 / 899 / 35 | 0 |
| storage-node | 684 / 375 / 304 | 684 / 371 / 308 | 4, explained below |

¹ vitest's `packages/storage` filter is a substring match, so it also runs the storage-browser and
storage-node tests.

² `tests/phase-5a-c-seal-safety-red.test.ts` and `tests/phase-5a-seal-digest-law-red.test.ts`.
`packages/seal` has no test files of its own.

The 29 added tests are the new file; all pass. One test flipped from failing to passing:
`corrective-clean-checkout-red`.

Every new failure is explained:

* **Governance, caused by my first placement, fixed.**
  * `idb-ownership-controls`, "allows only the governed raw-IDB owner modules";
  * `phase-2d2a-idb-adapter-governance-red`.

  These failed with 144 violations because the prototype sat in `src/internal/`. After the move
  to `tests/prototypes/`, both pass. A rerun on 676b09c1 of the two governance files plus the new test file passed 37 of
  37 tests (`tests/governance-final-rerun.log`, load about 37).
* **Load timeouts, passing on rerun.**
  * `phase-2e7-publication-component-red`, "ships a consumer-usable typed root…";
  * `phase-2g-b-presence-red`, "ships the exact browser composition…".

  Both hit their own 30 s timeout while running `pnpm build` and `npm pack` at load 70+. On rerun
  at load about 55 they pass, in 14.7 s and 12.8 s.
* **storage-node process-death and race tests: environmental, reproduced on the pristine tree.**
  * `phase-3a0-c-anchor-trust-sigkill-red`, "recovers authoritative old XOR exact new…";
  * `phase-4c-b-snapshot-quarantine-red`, "survives genuine SIGKILL…";
  * `sqlite-sigkill-red`, "recovers old XOR complete-new…";
  * `snapshot-recovery-retention-native-red`, "two independent processes compete…".

  The three SIGKILL tests use 10 s child timeouts and fail identically with the R2 files stashed
  (`tests/pristine-rerun-storage-node.json`). The race test passed on the pristine rerun but
  failed on the changed rerun. Meanwhile "adapter retention: ack-loss" in the same file passed
  after and on the pristine rerun, and failed only on the changed rerun. That is flakiness in both
  directions.

  None of these tests imports or hashes the new files. They use the storage-node SQLite dist and
  `@ts-drp/storage`, and the retention test's custody hash list does not include the new files.
  The storage-node counts in the "storage" row are the same tests.
* **`pnpm -r typecheck`: 0 errors**, exit 0, including storage-browser's
  `tsconfig.typecheck.json`, which covers the prototype (`tests/typecheck-after.log`).

## 5. Bench

### Grid pairs (base1 against mine1)

* `mine1` = base plus the pump change. These are the only Grid-path changes I measured.
* Settings: `STARTUP_HEALTHY_GRID_POOL_LULL=1`, 8 rollovers.
* Order: interleaved (base, mine, mine, base) × 4 blocks, 16 runs, all passed.
* Data: `bench/pairs-p1.txt` and `bench/pairs-p2.txt`; summary in `bench/pairsum-p1p2.txt`.

Lull t4–t8 is the creator pool-maintenance lull. "Seal" is the creator sealing-inclusive span and
"install" the recipient install-inclusive span, both t4–t7.

| Run | Load at start / end | Lull mean | Lull max | Seal mean | Install mean | Creator issue p50 |
|---|---|---|---|---|---|---|
| p1-base1-1 | 56.5 / 56.7 | 2634 | 3308 | 325 | 393 | 103.6 |
| p1-mine1-2 | 56.7 / 39.7 | 2477 | 2695 | 311 | 430 | 86.9 |
| p1-mine1-3 | 39.7 / 36.8 | 2571 | 3163 | 347 | 374 | 77.3 |
| p1-base1-4 | 36.8 / 93.7 | 3223 | 3702 | 408 | 522 | 89.4 |
| p1-base1-5 | 103.4 / 72.4 | 2688 | 3096 | 374 | 394 | 90.9 |
| p1-mine1-6 | 72.4 / 83.9 | 2789 | 3269 | 424 | 419 | 85.7 |
| p1-mine1-7 | 83.8 / 59.4 | 2594 | 2852 | 324 | 376 | 77.9 |
| p1-base1-8 | 59.4 / 53.9 | 2658 | 2986 | 393 | 386 | 92.0 |
| p2-base1-1 | 47.7 / 38.4 | 2378 | 2607 | 362 | 362 | 78.5 |
| p2-mine1-2 | 38.4 / 33.3 | 2883 | 3369 | 334 | 434 | 85.9 |
| p2-mine1-3 | 33.3 / 30.7 | 2518 | 2655 | 337 | 360 | 85.0 |
| p2-base1-4 | 30.7 / 25.6 | 2862 | 3170 | 338 | 486 | 82.5 |
| p2-base1-5 | 24.4 / 22.0 | 2677 | 2978 | 334 | 390 | 80.6 |
| p2-mine1-6 | 22.0 / 24.9 | 3011 | 3280 | 334 | 489 | 96.5 |
| p2-mine1-7 | 24.9 / 36.2 | 3532 | 4060 | 399 | 460 | 110.6 |
| p2-base1-8 | 34.3 / 37.7 | 3010 | 3301 | 398 | 447 | 95.0 |

Arm medians (n = 8 each):

| Arm | Lull mean | Seal mean | Install mean | Creator issue p50 | Load at start |
|---|---|---|---|---|---|
| base1 | **2682** | 368 | 393 | 90.2 | 42.2 |
| mine1 | **2691** | 336 | 424 | 85.8 | 39.0 |

Lull per epoch, median and max:

| Arm | t4 | t5 | t6 | t7 | t8 |
|---|---|---|---|---|---|
| base1 | 2480 / 2979 | 2584 / 3096 | 2837 / 3579 | 2959 / 3301 | 2811 / 3702 |
| mine1 | 2360 / 2884 | 2760 / 4060 | 2558 / 3895 | 2773 / 3369 | 2788 / 3745 |

Lull ratio mine/base per block:

| Block | Ratio |
|---|---|
| 1 | 0.862 |
| 2 | 1.007 |
| 3 | 1.031 |
| 4 | 1.150 |

Verdict: no measurable change. Run-to-run spread on this machine is about ±20%, and the 1-minute
load ran from 22 to 103. That agrees with Track R's earlier measurement, so the pump change was
not committed.

### Committed tree against base

The Grid bundle built from 676b09c1 (`bench/build-final1`) is byte-identical to `bench/build-base1`.
Its Grid latency equals base by construction, so a paired run would only measure noise.

### Prototype micro-benchmark

* Script: `microbench/run.mjs` with `microbench/entry.ts`; results in `microbench/result-1.json`.
* Setup: headless Chromium, persistent on-disk profile, strict durability.
* Workload per epoch: journal 12 rows, evidence 6, summary 1, issuance 20, snapshot 5 × 32 KiB,
  AHE 4 × 2 KiB, plus 2 × 4 KiB blobs. The window kept is head plus two rollbacks.
* 1-minute load was about 40 throughout.

| Repeat | Retire p50 / p95 / max (ms) | Step A p50 | Step B p50 / max | Append p50 | `verifyOnOpen` (144 rows) |
|---|---|---|---|---|---|
| 1 | 7.0 / 10.2 / 19.0 | 1.6 | 5.4 / 7.7 | 9.5 | 5.6 |
| 2 | 6.7 / 9.1 / 16.1 | 1.5 | 5.1 / 7.8 | 7.5 | 7.4 |
| 3 | 7.1 / 9.2 / 27.8 | 1.5 | 5.3 / 15.9 | 7.6 | 6.0 |

For comparison:

* Track E's model, one database: 2.5 ms.
* Track R's six-database prototype: 15.3 ms.
* Today's lull: 2.4–3.0 s.

Retirement does not include the readiness capture (`captureCreatorOrdinarySourceWithoutForecast`,
about 200–270 ms). That capture stays in the lull.

## 6. What remains, and the spec slices it needs

Spec slices (detail in `STEP4.md` §6):

* **S1, retention database format.** Stores, keys, exact-byte rows, the mark record and the
  decision digest domain. It supersedes 6B:63 for retirement only.
* **S2, trust statement.** Verify on arrival and on every open; in session, only in-memory
  verified facts; no stored-to-stored digest comparison; incremental digests are caches.
* **S3, host floor.** A bounded per-owner `retiredThrough` record in the room-head floor, the
  A-then-B order and the crash matrix.
* **S4, migration.** From snapshot (v4), journal (v3), issuance (v3), and AHE plus signing in the
  main database (v6 → v7, plus an epoch index on the AHE stores). Fence, authenticate, copy with
  receipt, delete, plus the unverifiable-row policy.
* **S5, bounds and charges.** Reviewed per-owner per-epoch caps and the proof-byte charge table
  (G21, G22).
* **S6, evidence.** Chromium, Firefox and WebKit, plus SIGKILL at A, between A and B, inside B,
  and at each migration step, plus multi-tab `versionchange` (G28).

Engineering after the slices:

* **Wire the planner.** `creator-closed-rollback-data.ts` must build the `RetirementDecision`:
  * the verified protected set (head plus two `baseExpectedHead` ancestors plus pending work);
  * per-owner `through`;
  * classifiers that reuse the existing owner policies.

  Then retire `applyClosedEpochRetirementIntent`, the per-database `retirementControls`, and the
  four-pass loop.
* **Promote the prototype into `src/`.** Register it as a reviewed owner with the IDB ownership
  checker.
* **Measure verify-on-open with real signatures.** Use Ed25519 over the window, with the existing
  exact-byte memo.
* **Keep the readiness capture in mind.** At about 200–270 ms, it becomes the lull's floor once
  retirement drops to milliseconds.
* **Optionally re-measure the pump patch** on a quieter machine. It keeps its 6 tests if it is ever
  landed.
