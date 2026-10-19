# Track R2 result

* Worktree: `<worktree agent-aeb6ebdfc4584ace2>/`.
* Branch: `worktree-agent-aeb6ebdfc4584ace2`.
* Base: de70325e.
* Commit: **676b09c1**, "test: prototype single-database epoch retirement with crash, replay and
  poison tests".
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
