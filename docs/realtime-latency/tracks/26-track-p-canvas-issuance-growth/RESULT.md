# Track P: Canvas rooms slow down and grow with room age

Worktree: <worktree agent-ae04c762f9072aea6>/
Branch: track-p-canvas-issuance-growth (base 5c6b949d, codex/phase3a1b-p6-golden-path)
Commits: see "Commits" at the end. Evidence: <evidence>/track-p/ (PROGRESS.md, logs/, latency/, chromium/, grid/,
tests/, bin/).

Line numbers are at HEAD. In packages/node/src/v3-live.ts, HEAD and base are identical up to line 20653.

Abbreviations:

- `CCRD` = packages/node/src/internal/creator-closed-rollback-data.ts;
- `BSL` = specs/bounded-storage-lifecycle/README.md;
- `6B README` = specs/phase-6b-bounded-pruning/README.md;
- `6B01` = specs/phase-6b-bounded-pruning/slices/01-issuance-retention.md;
- creator-close.ts and creator-adoption.ts are in packages/node/src.

## Summary

Track M found two problems in Canvas rooms (its findings 12 and 13), on every storage path. Canvas runs the
`creator-trusted-v1` profile, which has no settlement profile.

- **(b) Per-move work compounded with room age. Fixed.**
  - Track M located the cost in the `readOutboxPage` wrapper of `creatorFilteredIssuanceStore`. The wrapper does
    authenticate every retained row it skips, but one pass costs O(rows). The growth with room age had a different
    cause.
  - Each hot successor wrapped its source registration's facade in one more facade. At epoch s, one recovery read
    went through s - 1 facades. Each one re-paged the store beneath it and re-authenticated what that store showed.
    A persisted reopen builds a single facade over the native owner.
  - The fix is in one function. `activateCreatorSuccessorLive` now builds its facades, historical owner and
    displaced source over its source registration's original store. That is the store the source's facade wraps,
    and the existing `creatorOriginalIssuanceStore` already names it. This is exactly the structure a reopen builds.
    It adds 7 lines (one local and its comment) and changes 5, with no new state.
  - Creator native outbox page reads per move were 54 at epoch 8 and 103 at epoch 15. They are now a constant 10,
    the same as a reopened creator. The Writer recipient's went from 22 and 43 to a constant 2.
  - Grid, Chat (both settlement profiles) and receive-only owners never see a facade as their source store; nor
    does Canvas at epochs 1 and 2. For all of them nothing changes.
  - In Chromium, the creator's per-move issue slope fell from +16 to +1-5 ms per epoch. Seal fell from +732-767 to
    +46-183, and the recipient's issue from +14-15 to +1.5-2.3 (section 5.2).
- **(a) Canvas issuance is never retired. Stopped for review: this is a spec gap.**
  - The creator and the Writer recipient each keep every row they ever issued: 33 rows at epoch 16 with 2 moves per
    epoch.
  - Retirement classification does run for Canvas. Its completed decision classifies every row through epoch
    e - 2 and leaves 6 protected holes per author.
  - No deleter is wired for issuance without a settlement plan, and the spec defines none:
    - the specified retirement boundary is "settlement-derived" (BSL:186);
    - the one published-prefix deleter (D.109b) covers a single epoch and has no production caller.
  - Section 4 sets out the gap and four candidate rules. I recommend R-B for review: delete a published, paired
    prefix bounded by the completed coordinated decision.
  - Until (a) is decided, per-move work is linear in the retained rows. It no longer compounds, but latency is not
    flat yet. At 20 moves per epoch, the creator's move is refused in epoch 17 (section 4.4).
- **Checks.**
  - Chat and Grid are unchanged: per-store rows and bytes match base exactly (section 5.3).
  - The suites show no new failures against base (section 5.4).
  - Typecheck is clean (section 5.5).

## 1. Reproduction

New test: tests/canvas-long-room-issuance-retention-native.test.ts, committed RED in 8ed37d08.

- **Composition.** The shipped Canvas: `createV3CanvasApplication(10, 10)`, signed ACL version 1, and
  `creator-trusted-v1`. It runs on genuine SQLite, Ed25519 and room owners on the Node SQLite host, with scripted
  native-byte successor transport.
- **Play.** The creator and one Writer recipient each paint 2 cells per epoch, interleaved. Each move's signed rows
  reach the other peer before the next move.
- **Each epoch follows the shipped product order:**
  1. play;
  2. wait 300 ms (Track M finding 5);
  3. seal, adopt, deliver the successor, install;
  4. take the native census of both peers;
  5. run both peers' `maintainRecoveryPool` lulls.
- **Reopen.** After 16 epochs both owners are closed and reopened from the same databases and floors. The test
  checks that the census, the world and the authority are unchanged, then plays one more epoch and one more
  rollover.
- **Census.** Issued and outbox rows, logical bytes, `next`, the pruning watermark, pending rows, the oldest kept
  epoch, and the completed retirement control's `throughEpoch` and holes.
- **Per-move work.** An observer patches `StatementSync` and counts the native SQL work of each move, then forwards
  to the original:
  - issued-record point reads (one per row that a caller pairs with an outbox row it authenticated);
  - outbox page scans;
  - rows visited by those scans.
- **Two assertions share one run:**
  - **(b)** From the first steady epoch (8) on, the native outbox page reads of one move never exceed epoch 8's, for
    each peer.
  - **(a)** From epoch 8 on:
    - `next` advances by 2 per epoch;
    - nothing is pending;
    - issued and outbox counts are constant;
    - no kept row is older than 8 epochs;
    - each move's point reads and rows visited never exceed epoch 8's, including the moves of the reopened owners.

Run (`CANVAS_LONG_ROOM_VERBOSE=1` prints one `CANVAS_LONG_ROOM` JSON line per epoch;
<evidence>/track-p/bin/census.py tabulates them):

    node_modules/.bin/vitest run tests/canvas-long-room-issuance-retention-native.test.ts \
      --exclude ".claude/**" --no-coverage

Base 5c6b949d fails both assertions (<evidence>/track-p/logs/red-base-16.log):

- (b) fails with "creator outbox pages per move at epoch 9: expected 61 to be less than or equal to 54".
- (a) fails on the oldest kept row, which is from epoch 0.

| after install of epoch | creator issued / outbox | recipient issued / outbox | watermark (both) | oldest kept epoch | completed decision throughEpoch (holes) |
| ---------------------- | ----------------------- | ------------------------- | ---------------- | ----------------- | --------------------------------------- |
| 1                      | 3 / 3                   | 3 / 3                     | null             | 0                 | none                                    |
| 4                      | 9 / 9                   | 9 / 9                     | null             | 0                 | creator none; recipient 2 (7)           |
| 5                      | 11 / 11                 | 11 / 11                   | null             | 0                 | 3 (creator 9, recipient 6)              |
| 8                      | 17 / 17                 | 17 / 17                   | null             | 0                 | 6 (6)                                   |
| 12                     | 25 / 25                 | 25 / 25                   | null             | 0                 | 10 (6)                                  |
| 16                     | 33 / 33                 | 33 / 33                   | null             | 0                 | 14 (6)                                  |
| 17 (after reopen)      | 35 / 35                 | 35 / 35                   | null             | 0                 | 15 (6)                                  |

- Nothing is pending at any epoch.
- Both peers grow by exactly 2 rows per epoch: their own moves. Canvas has no author fence.
- The reopen keeps every row.
- Lulls: the creator's is `deferred:unsupported` at every epoch, because shipped Canvas declares no resource bound.
  The recipient's is `maintained` from epoch 3 on.

Per-move native work at base, for the two moves each peer issues in an epoch. Each cell is point reads : outbox
page scans : rows visited.

| moves issued in epoch | creator move 1 | creator move 2 | recipient move 1 | recipient move 2 |
| --------------------- | -------------- | -------------- | ---------------- | ---------------- |
| 2                     | 22:10:52       | 32:10:62       | 4:2:12           | 4:2:14           |
| 3                     | 37:19:140      | 40:15:123      | 11:7:56          | 4:3:27           |
| 7                     | 77:47:724      | 72:35:567      | 19:19:304        | 4:7:119          |
| 8                     | 87:54:940      | 80:40:728      | 21:22:396        | 4:8:152          |
| 11                    | 117:75:1756    | 104:55:1331    | 27:31:744        | 4:11:275         |
| 15                    | 157:103:3236   | 136:75:2415    | 35:43:1376       | 4:15:495         |
| 16, reopened owners   | 134:10:332     | 144:10:342     | 4:2:68           | 4:2:70           |

- The creator's page scans per move grow by 7 per epoch, and its rows visited grow quadratically.
- At epoch 16 the reopened owners hold more rows than the hot owners did at epoch 15. Yet they do about a tenth of
  the hot owners' scan work. Room age, not row count, drove the compounding part.

## 2. Root cause (b): each hot successor stacks one more facade

### 2.1 What the facade does

`creatorFilteredIssuanceStore` (v3-live.ts:12484-12652) wraps an issuance store for a successor's recovery and
publication. Its `readOutboxPage` (12514-12640) pages the wrapped store in native pages of 64 rows, from the
caller's key to the end. For each row it:

- **authenticates** the row in one of three ways:
  - under the filter payload (`authenticateRecoveryVertex`);
  - as a pinned-genesis row;
  - as a covered historical row (`authenticatedCoveredHistoricalOutboxRow`), against the successor's aggregate
    author issuance frontier;
- **checks every row it will hide.** It reads the issued record and requires a byte-identical pair (`readIssued`,
  `matchingOutboxRows`). It also counts the row against the historical budget (`countHistoricalIssuanceRow`, 8449);
- **hides** authenticated, published rows of the filter's own selection, genesis rows and covered historical rows;
- **shows** pending covered or genesis rows, and every other row;
- **returns `[raw]` on any anomaly**, so that the caller's own validation refuses it.

It requires `historicalIssuance.originalIssuanceStore` to be exactly the store it wraps (12494-12499), and records
itself as that context's `filteredIssuanceStore` (12650). `creatorOriginalIssuanceStore` (8432-8441) uses that pair:
for a registration whose store is its context's facade, it returns the store beneath.

One pass is O(retained rows). It cannot skip rows below a watermark or cursor without hiding unverified bytes
(section 2.3).

### 2.2 Where the stacking comes from

- **Adoption and install material carry the live registration's store.**
  - Creator side: `creatorCloseRegistration` builds the source from `registration.issuanceStore` (19732). Adoption
    passes `source.issuanceStore` into the material (creator-adoption.ts:1251).
  - Recipient side: the install material also carries the installed registration's store
    (creator-adoption.ts:2295).
  - A hot transport handoff (`creatorSuccessorTransportHandoff`, 7223) requires
    `registration.issuanceStore === material.issuanceStore` (7249).
- **For a profile without settlement, that store is a facade from epoch 2 on.** `activateCreatorSuccessorLive`
  (20584) builds the successor's store at 20793-20818:
  - the raw `material.issuanceStore` for a receive-only owner or a settlement profile;
  - otherwise, when the predecessor epoch is above 0, a MAX facade: `creatorFilteredIssuanceStore` over
    `material.issuanceStore` with exclusion epoch `MAX_SAFE_INTEGER`;
  - or a native-branch facade over the original native branch.
  - At base, three more stores took the same `material.issuanceStore`: the predecessor recovery store
    (20695-20706), the historical issuance owner (`originalIssuanceStore`, 20682) and the displaced source
    (`creatorSuccessorRecovery`, 20774-20786).
- **So at successor epoch s, the store was a facade over the previous facade.** Temporary instrumentation recorded
  each facade's depth (<evidence>/track-p/data/debug-layers.patch, reverted;
  <evidence>/track-p/logs/debug-layers-base.log):
  - at s = 2, a native-branch facade (epoch-0 payload, no exclusion) over native;
  - from s = 3, the new MAX facade wrapped a store s - 2 facades deep;
  - a reopened owner at any epoch, by contrast, builds one predecessor facade and one MAX facade, each directly over
    native.
- **Every facade re-pages and re-authenticates the store beneath it.**
  - One outer pass makes one native page call per layer.
  - Each layer re-authenticates the rows its inner store shows.
  - Every native page call is itself O(table): the native owner validates every issuance row on each call
    (node-issuance-store.ts:1518-1526, "Even unused foreign lineages remain part of global validation";
    browser-issuance-store.ts:1383-1384, "Validate the whole held image").
  - Per-move work was therefore O(epoch x rows).
  - Point reads stayed O(rows) even when nested, because each hidden row is hidden by exactly one layer.

The same nesting had two more effects:

- **The publication cursor never carried for Canvas from epoch 3.**
  - A hot handoff carries the predecessor's publication cursor when both registrations have the same original
    store (20186-20198, de70325e).
  - At base, `creatorOriginalIssuanceStore` returned the previous facade rather than the native owner, so the check
    failed.
  - As a result, the hot recipient's first issue after every install re-read and re-authenticated every row: 35
    point reads at epoch 15, against 4 for its second move.
- **Hot state grew per epoch.**
  - Each successor's historical context and facade referenced the previous facade, which referenced its own
    context, and so on back to epoch 2.
  - That kept a per-epoch chain of objects reachable from the live registration: hot-state growth with room age,
    against G1.

### 2.3 Why the wrapper cannot start from a watermark or cursor

The brief asked whether the wrapper could start from an authenticated position while still authenticating every row
it returns or relies on. It cannot, for these reasons:

- **Where a position already exists, it is used.**
  - `publishPending` (16074) starts from the registration's publication cursor (16087-16093).
  - The cleanup scan starts from the pruning watermark (20468-20471).
  - The facade's loop starts from its caller's key.
- **The census relies on every row.**
  - The recovery-dependency census (`readCreatorRecoveryDependencyCensus`, 10025) pages the facade from `null`
    (10210-10214).
  - The native `readBoundedRecoveryCensus` reads the complete image (10149).
  - The creator's per-issue maintenance quote charges the whole retained image against the proof reserve
    (creator-close.ts:2852-2888).
  - Starting any of these later would rely on rows not read in that stage. The guarantee checklist rules exactly
    that unsound under G5, G10 and G11: "caching verified state across stages".
- **A native page read is O(table) whatever its start.** Each call validates the whole issuance table. A later start
  would save authentication in the wrapper, but never native work.
- **The pruning watermark only helps once rows are deleted.** For Canvas nothing deletes them; that is part (a).
- **Memoizing authentication of exact bytes is already done.** `vertexFacts` caches authenticated vertices by exact
  bytes, bounded at `ISSUANCE_RETIREMENT_LIMITS.maxRows` facts (8559-8596). The predecessor's cache is released at
  a hot handoff (20183), and the successor forks verification only from the genuine handoff (20623-20625).

Per-move issue work is therefore O(retained rows) by design, and is bounded only when the retained rows are bounded.
The compounding was the defect; the linear part is (a).

## 3. Fix (b)

### 3.1 Change (packages/node/src/v3-live.ts, `activateCreatorSuccessorLive` only, 28e34f80)

- **The source's original store is resolved after the successor authority is prepared (20654-20660):**

      const nativeIssuanceStore =
        transportHandoff === undefined ? material.issuanceStore : creatorOriginalIssuanceStore(transportHandoff);

  - `transportHandoff` is the genuine live source registration (20622). Its store is `material.issuanceStore`
    (7249).
  - If that store is the source's own facade, `creatorOriginalIssuanceStore` returns the store beneath it, from the
    source's own historical issuance context. Otherwise it returns the store itself.
  - Without a handoff (a persisted reopen, a cold or foreign start), the material store is used unchanged. This
    matches the rule beside it: "Only the genuine live source handoff may carry these pure facts" (20623).

- **It is used wherever a reopen sees the native owner:**
  - the historical issuance owner (`originalIssuanceStore`, 20682);
  - the predecessor recovery facade (20698);
  - the successor's displaced-source store (`creatorSuccessorRecovery`, 20782);
  - both successor facades: MAX (20799) and native-branch (20810).
- **By induction over the hot chain it is the native owner.**
  - At epoch 1 the source store is native, because a predecessor at epoch 0 stays raw.
  - If the source's context wraps native, the successor's facades and context are built over native, so its own
    original store is native.
- **Deliberately unchanged:**
  - The raw branches still pass `material.issuanceStore`: receive-only, a settlement profile, and predecessor
    epoch 0. So does `assertEmptyReceiveOnlyIssuance`.
  - Two "source registration is raw" checks still compare with `material.issuanceStore`:
    `filtersOriginalNativeBranch` (20789-20792) and `retainsNativeBranch` (20822-20828). They therefore select the
    same branch as at base.
  - The hot transport handoff's identity check (7249).
- **An earlier variant was replaced.** c42db91e, superseded by the amended commit, kept a new module-level
  `WeakMap` from each facade to its native owner. It gave identical results. It was replaced because
  tests/phase-3a1-ac-live-persistence-red.test.ts counts module-level `WeakMap` owners in v3-live.ts and treats an
  added one as a "parallel owner" mutant. That test is RED at base with 18 owners, and the variant made it 19. The
  final change adds no state and reuses a relation the publication-cursor carry already depends on (20192).

### 3.2 Why the result equals a reopened owner

- **The construction is the reopen's.**
  - A persisted reopen reaches `activateCreatorSuccessorLive` with `material.issuanceStore` set to the native owner.
  - The hot path now passes the same native owner to the same calls, with the same payloads, exclusion epochs,
    genesis digests and historical contexts.
  - Branch selection is unchanged (above).
- **The visible set is unchanged, except where a reopen also differs.**
  - The outer MAX facade hides nothing by its own filter, because no epoch exceeds `MAX_SAFE_INTEGER`. It hides only
    published genesis rows and published rows covered by the successor's aggregate author frontier.
  - Aggregate frontiers are cumulative and monotone. Coverage at epoch s therefore contains coverage at every
    earlier epoch, so every row an inner MAX facade hid is also hidden by the outer one.
  - The only rows an inner layer hid and the outer one shows are those hidden by the s = 2 native-branch facade:
    rows that authenticated under the epoch-0 payload while still pending.
  - A reopened owner shows those pending rows too, and publishes them like any pending row it owns. No run had one:
    pending was 0 at every epoch.
- **The pairing that guards local settlement sources is unchanged.**
  - The code compares `displacedSource.issuanceStore` with `creatorOriginalIssuanceStore(registration)` at 8829,
    8860 and 10951.
  - Both were the previous facade at base, and both are now the native owner. They still compare equal exactly
    when they did.
- **The publication cursor now carries for Canvas from epoch 3, as its precondition intends.**
  - The carry (20186-20198) is reviewed existing code. It is already active for Grid and Chat at every epoch, and
    for Canvas at epoch 2.
  - Every row at or below the predecessor's cursor is published, or is pending and either displaced or historical
    (`publishPending`, 16128-16145). A successor publishes none of them: a row from an earlier epoch is never
    "current".
  - The cursor never authorizes admission, deletion or retirement. Every census, recovery and cleanup read still
    starts from `null` or from the native watermark.
- **Measured.** The final change and the registry variant give identical census and per-move work at all 17 epochs
  (<evidence>/track-p/logs/fix1-16.census.txt and fix2-16.census.txt). In Chromium, the base and HEAD runs hold
  identical rows and bytes in every store, for both roles, at every epoch (section 5.3).

### 3.3 Guarantee argument

Spec: specs/bounded-storage-lifecycle/golden-path-guarantees.md (G1-G28).

- **G1, no growth with room age.**
  - At a given row count, per-move work no longer depends on room age. The hot owners at epoch 15 do the work of
    the reopened owners at epoch 16: 10 creator page scans and 2 recipient page scans per move, in both cases.
  - The per-epoch chain of facades and historical contexts is gone. Each registration references the native owner,
    its own two facades and its own contexts.
  - Storage still grows. That is part (a), stopped for review (section 4), and the test's (a) assertion stays RED.
- **G5, G10, G11: untrusted bytes, fresh reads, no currency carried across stages.**
  - No state is added. The successor learns which object it should wrap from the live source registration's own
    historical context. That is an object identity, not a row, digest, count, verdict or authority.
  - Every read through the new facade re-reads the native owner and re-authenticates every row it hides or
    returns, as before. Nothing that used to be read is skipped. With one layer instead of s - 1, each row is read
    once per pass rather than once per layer.
  - The publication-cursor carry is pre-existing (section 3.2), skips only rows a successor would never publish,
    and was always active for Grid and Chat. It should be reviewed against G10 on its own merits. This track
    neither adds to nor widens its rule.
- **G19, issuance retention.**
  - The facade code is unchanged. Every row it hides is authenticated, paired byte-identically with its issued
    record, and counted. Any anomaly returns `[raw]` to a caller that refuses it.
  - Nothing is deleted. No pending row is hidden that a reopened owner would show.
- **G3, golden path.**
  - Both peers keep issuing through 16 hot successors and a persisted reopen, with equal projections every epoch.
  - The census is identical across the reopen, and both peers keep issuing after it.
  - Chat, Grid and the native suites are unchanged (sections 5.3 and 5.4).
- **G7, G9, G15, G17, deletion owners.** No deleter, decision, watermark or transaction changed.
- **G18, protected set.** No generation, snapshot or journal store is touched.
- **G21, bounded work.** No limit was added or changed. Per-move work drops from O(epoch x rows) to O(rows).
- **G26, latency never relaxes safety.** No check was removed or weakened. The same checks run, once each.
- **G27, no game-specific carve-outs.** The change keys on the existing store relation, never on a profile,
  application or role. It is a no-op wherever the source store is not a facade.
- **G28, native evidence.**
  - No storage owner or native requirement changed.
  - The node test runs on genuine SQLite.
  - The Chromium runs (section 5.2) run the same code on genuine IndexedDB through the room host.

## 4. Root cause (a): nothing retires issuance without settlement (spec gap; stopped for review)

### 4.1 Classification runs; no deleter does

- **Classification runs for Canvas.**
  - From epoch 4 or 5 on, both peers have a completed coordinated retirement control, with `throughEpoch` = e - 2
    and 6 protected holes per author (section 1).
  - `closedIssuanceProtectedRecordsForRetirement` (CCRD:19066) is profile-agnostic. A row is not a hole when all of
    these hold:
    - it is at or below `throughEpoch - 2`;
    - it is covered;
    - it is paired with a published outbox row;
    - it is outside every protected replay scope;
    - it is absent from the physical journal.
- **Every deleter on the path needs settlement.**
  - **`cleanupCreatorSettlementSuccessor` (v3-live.ts:20218).**
    - It sets `frontier = settlementFrontierFromHistory(historical)` (20227), which is `undefined` for
      creator-trusted-v1.
    - With no frontier it returns at once when a coordinated decision exists (20411-20412).
    - Otherwise it runs AHE-only role cleanup: `planClosedEpochRoleCleanup` with `issuance: {}` (20413-20433).
    - Three paths need a frontier and a complete settlement plan: its issuance scan (20467-20524), Track N's
      coordinated drain (20528-20537) and the planner path.
  - **`pruneAuthenticatedSettledPrefix`** (packages/storage-node/src/internal/node-issuance-store.ts:1902, sharing
    `#prunePrefix` at 1910-2060 with `authenticatedSettled = true`) refuses unless
    `settlementPlanPermitsAuthenticatedPruning(plan)` holds (packages/issuance-store/src/retirement.ts:1783-1804).
    That requires a non-null plan with a fence, and Canvas has no plan.
  - **`prunePublishedPrefix`** (D.109b, 1906) is the same owner with `authenticatedSettled = false`.
    - Every selected row must be in exactly one `closedEpoch` and published, and no plan entry may reference the
      range (node-issuance-store.ts:1975-2031).
    - It has no production caller in packages/node/src. Its slice "does not modify node runtime wiring" (6B01:297).
  - **D.109d runtime reclamation** (v3-live.ts:5635) prunes issuance only when `settlementProfileFor(...) === "v1"`.
  - **The pure planner's no-settlement branch** (`copiedIssuance`, packages/node/src/internal/
    closed-epoch-cleanup.ts:570-668) also takes a single closed epoch of published rows.
- **The lulls do not help.**
  - The creator's lull is deferred, because shipped Canvas declares no resource bound (Track Q is adding one).
  - The recipient's lull maintains AHE and the journal, but never issuance.

### 4.2 What the spec says

- **6B README:162-164:** "An old-epoch issuance row is deletable only when its canonical preimage is valid,
  epoch-bound, paired, and `published`. A `pending`, malformed, one-sided, foreign-digest, or unreadable row blocks
  that owner with no writes." That is a necessary condition, not a wired rule.
- **BSL:186-187:** "Reuse the existing settlement-derived issuance boundary and monotonic sequence high-watermarks."
- **BSL:259:** `retained <= … + unsettled issuance + …`. A profile without settlement is never "settled", so this
  formula has no term that bounds its issuance.
- **6B01 (D.109b)** specifies the published-prefix owner for one closed epoch. That epoch's QC and manifest are
  explicit inputs, and wiring is left out (6B01:297).
- **No slice** defines when, or under which decision, a runtime owner retires the issuance of a profile without
  settlement across many closed epochs.

This is a missing rule, not an existing rule that fails to run. As the brief requires, I did not invent one.

### 4.3 Candidate rules (for review)

- **R-A: put Canvas on a settlement profile.**
  - The shipped Canvas would sign `creator-trusted-settlement-v1`, and the existing settlement drain would apply
    unchanged, as for Chat and Grid.
  - This is a product and profile decision. Existing rooms would need a migration (G25).
  - It adds one author fence per Writer per successor, so one more row per epoch.
  - Every guarantee argument already exists (Track N, D.109c).
- **R-B: a published, paired prefix bounded by the completed coordinated decision (recommended).**
  - This would be a new reviewed native mode of the existing owner. Inside one transaction, it would delete the
    contiguous prefix from the watermark through T, if all of these hold:
    1. every row is paired, decodes to the scope, and is `published`;
    2. its epoch is at or below the completed decision's `throughEpoch`, read natively from the retirement control
       in the same transaction;
    3. the range contains no protected hole of that decision (`assertIssuanceRetirementPruningAllowed`, as today);
    4. no plan entry references the range, and there is no inherited target;
    5. lineage and watermark pass the CAS.
  - It would be wired only in the no-frontier coordinated branch of `cleanupCreatorSettlementSuccessor`, mirroring
    Track N's cold rules. The scan stops at the first hole, at `closedEpoch - 2`, at `throughEpoch` and at the first
    pending row.
  - Guarantees:
    - G19: published, paired, epoch-bound;
    - G7: the decision is the sole owner, and age only restricts it;
    - G9 and G15: one transaction, with the watermark in the same commit;
    - G17: a monotone watermark;
    - G18: holes and the two rollback epochs are kept;
    - G27: it keys on the absence of a settlement plan, not on Canvas.
  - It needs a spec slice, conformance tests on both native owners, and G28 evidence (three engines plus SIGKILL).
  - A loop of per-epoch `prunePublishedPrefix` calls is no substitute. Each call needs that epoch's QC and manifest,
    and the material carries only the cuts for `closedEpoch` and `closedEpoch - 1`.
- **R-C: treat a null settlement plan as complete. Rejected.** Absence is not authority (G5, G8). It would also reach
  `pruneAuthenticatedSettledPrefix`, which allows pending rows below `closedEpoch` (G19).
- **R-D: an explicit bound only.** This turns growth into refusal, and existing bounds already refuse (section 4.4).
  Changing them is a reviewed-limit decision (G21), and fixes nothing by itself.

### 4.4 Consequence: a long Canvas room ends in a refused move

Probe: the same test with 20 moves per Writer per epoch, over 30 epochs, at HEAD. The file is untracked and kept at
<evidence>/track-p/trash/track-p-canvas-census-bound-probe.test.ts; the log is
<evidence>/track-p/logs/probe-head-30.log.

- Both peers grow by 20 rows per epoch, with nothing pending. Each holds 341 rows (330,433 logical bytes) after the
  install of epoch 17.
- In epoch 17 the creator's next move is refused with "v3 local issue transaction failed: creator issuance
  maintenance proof reserve is exhausted". The refusal comes from creator-close.ts:2877 or 2887. Each ordinary issue
  charges a maintenance quote, sized from the retained image, against its fixed proof reserve (G22).
- So a Canvas room stops accepting the creator's moves after about 340-360 retained rows. If the quote follows the
  row count, that is about epoch 17 at 20 moves per epoch, epoch 42 at 8, and epoch 170 at 2 (extrapolated, not
  run).
- This refusal comes earlier than the issuance owner's 1,024-row bound (`ISSUANCE_RETIREMENT_LIMITS.maxRows`, about
  511 issued records). Track N's leaking Grid recipient hit that bound at 506 rows held.
- The probe was not run at base. The facade nesting changes how often rows are read. Whether it also changes the
  charged bytes, and therefore the refusal point, is not measured.
- Above 64 rows each pass needs several native pages, so the probe's own (b) assertion fails on page count. It does
  so linearly in rows: 14 to 30 creator pages per move from epoch 6 to 17. The committed test's (b) assertion holds
  because its outbox stays under 64 rows (its comment says so).

## 5. Evidence

### 5.1 Node test at HEAD

<evidence>/track-p/logs/fix2-16.log (final change); fix1-16.log (registry variant) is identical. (b) passes. (a)
fails on the oldest kept row (0), as expected until (a) is decided.

| moves issued in epoch | creator move 1 | creator move 2 | recipient move 1 | recipient move 2 | rows held before the moves |
| --------------------- | -------------- | -------------- | ---------------- | ---------------- | -------------------------- |
| 2                     | 22:10:52       | 32:10:62       | 4:2:12           | 4:2:14           | 5                          |
| 3                     | 30:10:72       | 40:10:82       | 4:2:16           | 4:2:18           | 7                          |
| 8                     | 70:10:172      | 80:10:182      | 4:2:36           | 4:2:38           | 17                         |
| 11                    | 94:10:232      | 104:10:242     | 4:2:48           | 4:2:50           | 23                         |
| 15                    | 126:10:312     | 136:10:322     | 4:2:64           | 4:2:66           | 31                         |
| 16, reopened owners   | 134:10:332     | 144:10:342     | 4:2:68           | 4:2:70           | 33                         |

- From epoch 3 on, page scans are constant: 10 per creator move and 2 per recipient move.
- Point reads and rows visited grow with the rows held: about 4 point reads and 10 rows visited per creator row.
  The hot owners track the reopened owners exactly.
- The census is identical to base at every epoch. The fix changes no row.

### 5.2 Latency: Chromium, interleaved pairs against base

- **Harness.** Track M's measurement harness, copied untracked from da3704ac (section "Files"). It uses neither the
  retention host option nor any other unmerged Track M product code.
  - Canvas on the room-database host in Chromium, on genuine IndexedDB.
  - A Writer recipient, the shipped lull, 16 epochs, and 300 ms settle before each seal.
- **Bundles.** <evidence>/track-p/chromium/assets-base (5c6b949d) and assets-fix2 (28e34f80) are prebuilt, so the
  runs do not depend on the worktree.
- **Runs.** Order ABBA (base, fix, fix, base), 1-minute load average 8-54 (<evidence>/track-p/bin/chromium-pairs.sh,
  latpairs.py). Transition n means: play in epoch n - 1, then seal, adopt, and install epoch n.

8 moves per Writer per epoch (Track M's profile), final change (p3). Each cell is the p50 over transitions 3 or later,
then the least-squares slope over transitions 6-16:

| metric             | base, run 1      | HEAD, run 2     | HEAD, run 3      | base, run 4      |
| ------------------ | ---------------- | --------------- | ---------------- | ---------------- |
| creator issue/move | 227 ms, +16.4/ep | 175 ms, +0.7/ep | 173 ms, +5.3/ep  | 265 ms, +16.3/ep |
| recipient issue    | 84 ms, +14.7/ep  | 37 ms, +1.5/ep  | 38 ms, +2.3/ep   | 95 ms, +14.2/ep  |
| seal               | 4081 ms, +732/ep | 3468 ms, +46/ep | 3579 ms, +183/ep | 4736 ms, +767/ep |
| adopt              | 425 ms, +91/ep   | 251 ms, +9/ep   | 269 ms, +23/ep   | 498 ms, +78/ep   |
| install            | 475 ms, +103/ep  | 356 ms, +22/ep  | 368 ms, +12/ep   | 560 ms, +102/ep  |
| recipient lull     | 1394 ms, +121/ep | 1395 ms, -36/ep | 1462 ms, +16/ep  | 1572 ms, +119/ep |

Per transition, mean of each tree's two runs (ms; rows are the same on both trees and both peers):

| transition | creator issue base | creator issue HEAD | recipient issue base | recipient issue HEAD | seal base | seal HEAD | rows held |
| ---------- | ------------------ | ------------------ | -------------------- | -------------------- | --------- | --------- | --------- |
| 2          | 95                 | 80                 | 15                   | 16                   | 129       | 97        | 17        |
| 4          | 119                | 106                | 28                   | 24                   | 223       | 206       | 33        |
| 6          | 175                | 156                | 41                   | 30                   | 3326      | 3096      | 49        |
| 8          | 194                | 183                | 58                   | 36                   | 4099      | 3583      | 65        |
| 10         | 219                | 162                | 82                   | 36                   | 4703      | 3470      | 81        |
| 12         | 250                | 181                | 113                  | 42                   | 6014      | 3512      | 97        |
| 14         | 291                | 176                | 130                  | 44                   | 7875      | 3662      | 113       |
| 16         | 345                | 213                | 198                  | 52                   | 11245     | 4422      | 129       |

- At HEAD, per-move issue latency is nearly flat over 16 epochs: the creator's slope is +0.7 and +5.3 ms per epoch,
  against +16 at base. The recipient's is +1.5 and +2.3, against +14 and +15. That holds even though rows grow by 8
  per epoch on both trees.
- Seal still grows at HEAD (+46 and +183 ms per epoch, against +732 and +767 at base). The retained rows grow by 8
  per epoch on both trees, and the seal's census and retirement reads cover the whole retained image. I expect that
  growth to end only when (a) bounds the rows. I did not profile it further.
- Two earlier ABBA sets, built from the registry variant (identical structure), agree:
  - 8 moves (p1, load 51-155): creator issue +7.3 and +8.5 against +15.9 and +32.3 ms per epoch; recipient +2.5
    and +4.5 against +22.7 and +24.9; seal +203 and +262 against +980 and +1188.
  - 2 moves (p2, load 97-176): creator +7.2 and +4.1 against +25.5 and +20.0; recipient +1.7 and +1.1 against +12.7
    and +9.9; seal +82 and +12 against +162 and +99.
- No Canvas latency pairs were run on the node host. The node test measures the work deterministically instead
  (section 5.1).

### 5.3 Chat and Grid unchanged

- **Rows and bytes match per store.** In every store, for both roles, at every epoch, and after both the install and
  the lull, these pairs hold identical rows and identical bytes (<evidence>/track-p/latency/):
  - Chat long room on the Node SQLite host (shipped Chat: creator-trusted-settlement-v1, ACL v3, Writer recipient,
    shipped lull, 16 epochs): base-1 against head-2. Both peers are flat at 13 issued and 13 outbox rows from epoch 6.
  - Canvas in Chromium: base against HEAD (p3 runs 1 and 2).
  - Lull kinds are identical.
  - There is no Chat latency claim, because this is one pair, not interleaved, with base under heavier load. HEAD's
    slopes are creator issue +4.0 and seal +35 ms per epoch.
- **Track N's test** (tests/recipient-long-room-issuance-retention-native.test.ts) passes at HEAD, both cases. So do
  Track K's recipient-long-room-journal-retention-native, Track L's recipient-lull-reopen-close-native, R3's
  room-database-retirement-native and r9-grid-outcome-transfer-native.
- **The six native tests** give 35 passes and 15 failures on both trees, identical per test and matching Track M's
  table. The failing tests are r9-chat-capacity-room 4, r9-chat-metadata 6 and r9-chat-shipping-room 5, with
  `SHIPPING_CHAT_CATALOG_DIR` set to Track M's materialised catalog.
- **Grid, 8 rollovers, `STARTUP_HEALTHY_GRID_POOL_LULL=1`** (README recipe; <evidence>/track-p/grid/run-head2-lull8-1,
  bundle build-fix2 at 28e34f80) passes the whole case, including the persisted close, reopen and continued
  gameplay, with `proofEventsTruncated` false.
  - Recipients hold 13/13 issuance rows from adopted-5 (12,657-12,665 B), and the creator 13/13 from adopted-6.
  - This matches Track N's HEAD table checkpoint for checkpoint. The registry-variant run (run-head-lull8-1) is
    identical.

### 5.4 Per-test suite diff against base

Method (<evidence>/track-p/bin/suite.sh, swap.sh, vcompare.py, msgdiff.py; reports in <evidence>/track-p/tests/):

- **Command.** `vitest run <set> --exclude ".claude/**" --exclude "**/.logs/**" --no-coverage --testTimeout=120000`
  with the JSON reporter, in this worktree.
- **Trees.** "HEAD" is 28e34f80. "Base" is the same tree with v3-live.ts written from 5c6b949d, the only product
  file this track changes; it was restored afterwards.
- **Checks.** Besides statuses, msgdiff.py compares the first failure line of every test that fails on both trees.
- **Reruns.** Files with a timeout on either tree were rerun outside the suites (rerun.sh, rerun2.sh).

| set                                    | base (pass / fail / skip) | HEAD (pass / fail / skip) | new failures at HEAD |
| -------------------------------------- | ------------------------- | ------------------------- | -------------------- |
| quick (seal, proof accounting, policy) | 370 / 24 / 0              | 370 / 24 / 0              | 0                    |
| node (`packages/node`)                 | 1021 / 45 / 5             | 1023 / 48 / 0             | 0 (see below)        |
| storage-node retirement                | 158 / 49 / 2              | 158 / 49 / 2              | 0                    |
| six native tests                       | 35 / 15 / 0               | 35 / 15 / 0               | 0                    |
| root (96 files)                        | 672 / 354 / 24            | 674 / 352 / 24            | 0                    |
| observer unit tests                    | 23 / 0 / 0                | 23 / 0 / 0                | 0                    |

- **node.** sync-state-heap-recharacterization-1o-f-ii-red builds the production node package with `pnpm`. At base
  that build hit `spawnSync pnpm ETIMEDOUT` under load, so the file's 5 tests were skipped. Rerun alone at base, it
  matches HEAD exactly: 2 pass, and 3 fail with `ERR_MODULE_NOT_FOUND` in the heap workers. Everything else is
  identical per test and per failure line.
- **root: fixed at HEAD (2).**
  - This track's (b) test.
  - phase-4c-snapshot-stream-red "proves peak verifier ownership on 64 MiB", a load timeout at base. Rerun alone at
    base it passes too, so it is not a fix.
- **root: same status, different failure line.**
  - phase-6b-d110c-0c1f5b-integration-red "composes 64 active writers" timed out at base. Rerun at base, it fails
    with HEAD's message ("creator whole-suffix finishing capacity requires explicit boundary maintenance before the
    first join").
  - phase-3-exit-envelope-purity-red "keeps both node runtime entrypoints unchanged" hit the known module-init
    race at HEAD (`Cannot access '__vite_ssr_import_8__' before initialization`). Rerun alone at HEAD, it fails
    with base's AssertionError.
  - The rest differ only in temporary paths, pids, or a bundle line number: journal-anchor-read-node-red,
    snapshot-declaration-provenance-native-red (71814 against 71818), phase-6b-differential-exit-red and phase-4a.
- **Reruns of the 16 files with a timeout on either tree.**
  - Method: base by file (rerun.sh, 300 s) and then together (rerun2.sh, 120 s); HEAD together (rerun2.sh head all,
    120 s); reports rerun-base-all.json (merged) and rerun2-head.json.
  - Result: 173 tests on each tree, 103 pass and 70 fail on both, with 0 status differences and 0 first-failure-line
    differences.
  - d110c-0c1f5b0a-settlement-codec-red timed out in 9 tests in both root suites. Rerun, it gives 9 pass / 1 fail on
    both trees; the failing test is "centralizes the settlement profile predicate".
  - These timeouts remain on both trees, rerun alone, in the same tests:
    - packages/node: creator-replay-seal-native 2, queue-isolation 2;
    - root: grid-memory-runtime-owners 1, grid-memory-startup-barrier 1, pending-historical-owned-snapshot 3,
      phase-6a-creator-adoption-commit-red 3, phase-6a-creator-successor-local-author-red 1,
      phase-6b-cleanup-eligibility-red 1, phase-6b-d110c-0b0-floor-red 1,
      phase-6b-d110c-0c1f5b0u-room-runtime-red 9, phase-6c-creator-replay-pagination-red 1,
      protocol-v3-creator-author-issuance-frontiers 4.
- **K, L, R3 and N native tests** pass on both trees (section 5.3).
- **Everything else** fails identically on both trees: pre-existing RED, governance and environment failures, for
  example missing `@grpc/grpc-js` and `@ts-drp/storage-node/room-head` entries, and
  `ROLE_FROZEN_ARTIFACTS_AND_EVIDENCE_REQUIRED`.
- **phase-3a1-ac-live-persistence-red** is identical on both trees, with 18 module-level `WeakMap` owners. The
  superseded registry variant had made it 19 (section 3.1).

### 5.5 Typecheck

- `pnpm -r typecheck` at 28e34f80 exits 0 with 0 errors. It covers 46 of 47 workspace projects, every one ending in
  "Done" (<evidence>/track-p/logs/typecheck-head.log).
- `node scripts/check-shadowed-sources.mjs` exits 0.
- Every typecheck script uses `--noEmit` or a tsconfig with `"noEmit": true`, so no files were emitted.
- Root tests are outside the typecheck projects. The new test runs under vitest's transform.

## 6. What remains, and risks

1. **(a) is open.**
   - Canvas issuance still grows with every move, on both peers, and per-move work is linear in it.
   - At 20 moves per epoch the creator's move is refused in epoch 17 (section 4.4).
   - The test's (a) assertion stays RED on purpose. It is the acceptance test for whichever rule is chosen
     (section 4.3).
2. **Seal latency still grows** for Canvas: +46 and +183 ms per epoch at 8 moves in Chromium, against +732 and +767
   at base. It follows the retained rows, which only (a) can bound. That attribution is inferred, not profiled.
3. **The publication-cursor carry now covers Canvas from epoch 3.** It is reviewed existing code (de70325e), already
   active for Grid and Chat at every epoch. A reviewer who finds it unsound under G10 would need to change it for
   every profile, not just for Canvas.
4. **Pending epoch-0 rows of a native branch.** From epoch 3, a hot owner now shows them, as a reopened owner always
   did (section 3.2). No run produced one.
5. **A non-hot activation over a facade still nests by one level.** If a source store is a facade but the live
   handoff predicate fails, the material store is used as at base. That nesting is bounded by the number of such
   activations, not by epochs, and a reopen clears it. No run produced one.
6. **Coverage.**
   - The node test runs on the SQLite node host.
   - The Chromium room-host runs exercise the browser owners, but they are measurements, not assertions.
   - Firefox and WebKit were not run.
7. **Track Q** gives Canvas an application resource bound, so its creator lull will run. That changes when
   maintenance runs, not what it retires; issuance stays unretired until (a). After Track Q merges, re-run this
   test: (b) must stay GREEN.
8. **Tracks O and M2** work on the retention path and the verified-fact ledger. This track does not touch
   retirement, classification, the native owners or the ledger. Textual conflicts are possible only in
   `activateCreatorSuccessorLive`, around the store selection.

## Files and functions touched

Product:

- packages/node/src/v3-live.ts, `activateCreatorSuccessorLive` only (28e34f80): one new local, `nativeIssuanceStore`
  (20654-20660), used at 20682, 20698, 20782, 20799 and 20810.

Tests:

- tests/canvas-long-room-issuance-retention-native.test.ts (new; 8ed37d08).

Docs:

- docs/realtime-latency/tracks/26-track-p-canvas-issuance-growth/RESULT.md (this file).

Not touched:

- the retirement classification (`closedIssuanceProtectedRecordsForRetirement`), the planners, the native issuance
  owners and every limit;
- `cleanupCreatorSettlementSuccessor`, `creatorFilteredIssuanceStore`, packages/node/src/applications/canvas.ts,
  the Chat example and docs/realtime-latency/README.md;
- any RED or governance test, frozen artifact, registry or vector.

Measurement inputs, never committed:

- Track M's harness, copied from da3704ac as untracked files and moved to <evidence>/track-p/trash/ afterwards:
  tests/fixtures/track-m-apps/, tests/track-m-canvas-long-room.test.ts and tests/track-m-chat-long-room.test.ts.
  The only adaptation is that browser/global-setup.ts skips its build when `TRACK_M_APPS_ASSET_DIR` names a
  prebuilt bundle.
- The probe tests/track-p-canvas-census-bound-probe.test.ts, also moved to trash/.
- The Grid bench inputs under .logs/bounded-storage-lifecycle/r8-warm-capacity-01/: observer.ts,
  worker-transport.ts and grid-candidate-01/{grid-benchmark,grid-corpus,grid-role}.ts, copied from the main
  checkout.

## Commits

On branch track-p-canvas-issuance-growth (parent 5c6b949d):

- 8ed37d08 test: a Canvas room's issuance must not grow or compound with room age (RED)
- 28e34f80 fix: a successor filters its source's original issuance store, not its facade
- docs: record the Track P result (this file)
- Superseded and never on the branch: c42db91e, the registry variant of the fix (section 3.1)
