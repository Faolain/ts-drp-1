# End-to-end storage verdict

The current lifecycle does **not** provide a finite whole-storage bound for a fixed-size live application state. Authenticated AHE and issuance reclamation work in their own domains; durable journal and signing history remain outside them. Transfer expiry is real deletion, but is not a recovery-retention policy. This is a negative characterization, not production acceptance or authorization to delete additional data.

## Eligibility, deletion, and triggers

| Owner | Implemented deletion and trigger | Remaining obligation |
| --- | --- | --- |
| AHE generations, closures, promotions and blobs | Successor activation invokes authenticated cleanup after adoption. The planner protects the active generation and two immediate physical rollback ancestors; storage reclamation checks the head and removes eligible older lineage/unreferenced content. | This is a physical-generation window, not an epoch-wide or universal byte bound. Unreferenced and shared content must obey the storage owner's eligibility checks. |
| Issued records and issuance outbox | The same activation path prunes an authenticated settled prefix, with lineage, pruning-floor and head checks. Its gate is the authenticated settlement frontier, not publication completion. | Epoch age alone is insufficient. Admission and settlement-frontier advancement must be bounded; a pending publication flag alone does not prevent this authenticated pruning path. |
| Live-journal scopes and accepted entries | No durable history deletion API or deletion trigger in the current journal owner. Close releases resources, not history. | Define an authenticated retirement floor and recovery dependencies before implementing deletion. Current reads address an epoch, but address-local replay does not bound total stored history. |
| Snapshot-transfer scopes and chunks | `openScope` sweeps expired scopes; explicit `sweepExpired` also deletes scopes and their chunks. Cancel deletes an addressed transfer. New missing chunks refresh expiry; duplicates and verification do not. Store creation, receipt release and close are not periodic maintenance. | TTL is temporary transfer retention, not proof of safe snapshot retirement. No periodic production sweep caller was found. Required adopted snapshot bytes can expire. |
| Seal evidence and signer state | Browser stores retain epoch-keyed evidence/signing state; no history deletion path was found. Evidence recovery reads all stored evidence before filtering. | Retirement must preserve anti-double-sign safety, including stale operations and process death; deleting old rows alone would erase safety memory. |
| Vote slots and vote outbox | Dispatch marks an outbox row dispatched; it does not delete it. Pending scans can pass historical dispatched rows. No retirement deletion path was found. | Require an authenticated compact safety floor and explicit late-ack/retry policy before deleting records. |

The cleanup call and its domain boundary are owned by
[successor activation](../../packages/node/src/v3-live.ts) and the
[cleanup planner](../../packages/node/src/internal/closed-epoch-cleanup.ts).
The independent persistence contracts live in the
[journal interface](../../packages/live-journal/src/types.ts),
[browser journal](../../packages/storage-browser/src/live-journal.ts),
[transfer store](../../packages/storage-browser/src/snapshot-transfer.ts),
[seal evidence store](../../packages/storage-browser/src/internal/seal-evidence-store.ts), and
[vote store](../../packages/storage-browser/src/internal/seal-vote-store.ts).
The signing-store conclusions here are browser-source conclusions, not a separately completed Node signing-store audit.

In the live settlement path, the planner requires an issuance row's epoch to be at most `closedEpoch - 2` and either older than the authenticated admission epoch or within its terminal-through author sequence. It admits both published and pending rows under that proof. The separate `prunePublishedPrefix` operation has publication-completion requirements, but no production caller was found; those requirements must not be attributed to `pruneAuthenticatedSettledPrefix`. The authoritative gates are in the planner and [issuance store](../../packages/storage-browser/src/internal/browser-issuance-store.ts).

The current [grid invite builder](../../examples/grid/src/v3-zone.ts) selects `creator-trusted-v1`, whereas both the fixed-state diagnostic and the earlier 60-transition fixture explicitly select `creator-trusted-settlement-v1`. The settlement cleanup evidence therefore does not establish the same partial cleanup for the grid's default invite path. The native legacy control is chat, not a second full grid workload. No profile migration is included here.

## What a bound would require

A prospective bound must account separately for protected recovery state, current journal work, unsettled issuance, transfers, compact signing safety state, and metadata. A useful contract shape is:

`B <= G * A + R * S + W * J + U + C * T + F + M`

Here `G` bounds protected physical generations and `A` their closure bytes; `R` bounds required recovery snapshots and `S` their bytes, including active, rollback and pending-adoption dependencies; `W` bounds recoverable journal epochs and `J` their bytes; `U` bounds issuance not yet covered by the authenticated settlement frontier; `C` bounds admitted temporary transfer scopes and `T` their bytes; `F` bounds durable signing/retirement state; `M` bounds remaining metadata. Recovery snapshots and temporary transfers currently share storage, so the expression is a conservative upper-bound contract shape, not an additive measurement or a claim that separate durable recovery storage already exists. Shared blobs may lower actual usage, but cannot justify dropping a term. Origin filesystem allocation and browser compaction are separate from this logical-content bound.

Only a partial generation window and authenticated prefix cleanup are implemented. Fixed application state alone bounds neither events within an epoch nor issuance outside the authenticated frontier, snapshot admissions, or signing history. A temporal transfer window additionally needs a bounded admission rate (or concurrency cap) and a maximum maintenance delay. No numerical end-to-end budget is justified without these contracts. Arbitrarily many epochs accumulate journal rows even if every expired transfer is eventually swept.

Recovery retention must protect all bytes needed by the active head, rollback heads and pending adoption until authenticated retirement or a durable alternative source is established. The physical AHE window does not itself guarantee availability of separately quarantined snapshot bytes. A transfer TTL cannot substitute for that invariant.

## Native-browser counterexample

The canonical run is [the fixed-state evidence](../../.logs/grid-memory-production/2026-09-07T07-07-42.211Z/grid-memory-production.pw.-ee812-sistent-process-cold-reopen-chromium/native-browser-evidence.json).
It uses the production grid application with one roster member and one overwritten block, six genuine settlement-profile transitions, native IndexedDB and native quota reporting, without the lifetime instrumentation plugin. It is not the 64-writer workload or a plateau test. The browser reports HeadlessChrome 151.0.7922.34; the artifact records bundle/source hashes, process identities and browser/runtime versions.

| Product records | Epoch 3 | Epoch 6 | After older-transfer expiry sweep |
| --- | ---: | ---: | ---: |
| AHE generations | 3 | 3 | 3 |
| Issued records / issuance outbox, each | 5 | 5 | 5 |
| Journal scopes | 4 | 7 | 7 |
| Journal accepted entries | 8 | 14 | 14 |
| Quarantine scopes / chunks, each | 3 | 6 | 2 |
| Seal evidence / signer state, each | 3 | 6 | 6 |
| Vote slots / vote outbox, each | 6 | 12 | 12 |

The fixture's durable room-head event observer also grows (7 to 13 rows); it is test overhead, not a product retention finding. The table separates journal scopes from transfer scopes rather than summing equal store names across databases. The artifact's `closed-epoch` and `current-epoch` retention-status labels describe age relative to the sample, not deletion eligibility.

Native origin usage was 690,959 bytes at epoch 3 and 1,348,190 at epoch 6. In a fresh browser process after deleting four expired transfers, the estimate was 1,375,162 bytes, not lower than before the cold boundary. This is not a same-process before/after deletion experiment: process restart, page load and store opening also intervene. Each boot initially reported zero usage even with persisted profile data, so startup accounting is an additional caveat; these estimates are not direct filesystem measurements. The census proves logical deletion, not immediate physical shrinkage. Renderer post-GC used heap was 9,912,096 bytes at epoch 6 and 7,035,024 after a new browser process reopened and issued successfully. The intermediate fresh, unopened realm is not comparable to a live-room heap. These small measurements establish native consequences, not a memory ceiling, slope forecast or deployed-device guarantee.

The earlier [60-transition evidence](../../.logs/grid-memory-attribution/capture60-growth/outcome.md) remains supporting long-horizon evidence: fake IndexedDB explains where persisted rows reside in that process, not why production history has no deletion path.

## Recovery boundary

The test closes the browser process, proves its owned process tree exited, and relaunches with the same profile and origin. Sweeping only the four oldest transfer cohorts leaves two recent cohorts; authenticated authority, projection, ACL and issuance survive cold reopen, and the next issuance advances its sequence.

A second process restart retains the snapshot declaration before expiring the remaining required snapshot bytes using the real sweep entry point under controlled time. Cold reopen then rejects with `snapshot-unavailable: creator successor snapshot is unavailable`. Non-transfer durable rows are unchanged by the sweep. This proves an availability boundary for this local recovery configuration; it does not test declaration discovery after maintenance, demonstrate silent acknowledged-state corruption, test every rollback/pending-adoption combination, or establish that a remote durable snapshot source would fail. No retention policy was changed to make recovery pass.

## Verification and review status

- [Final native characterization](../../.logs/grid-memory-attribution/native-browser-verification-03/status.json): both cases passed, including the exact snapshot-unavailable assertion. The numerical table above remains anchored to the separately preserved canonical capture.
- [Final three-engine quarantine suite](../../.logs/grid-memory-attribution/native-quarantine-verification-03/status.json): 21 tests passed, including exact mixed-cohort expiry, retained bytes and verification at a distinct timestamp from the final chunk write.
- [Selected product regressions](../../.logs/grid-memory-attribution/native-product-regression-01/status.json): two of the refactored suite's 17 test definitions passed across Chromium, Firefox and WebKit (six cases), covering hot transitions and both pending-adoption process-death orderings. This is not a full-suite run and does not add a pending-adoption expiry guarantee.
- [Final package typecheck](../../.logs/grid-memory-attribution/native-browser-typecheck-03/stdout.log) remains failing on cross-root example imports and older Phase 6b fixture diagnostics, with output identical to the pre-correction run. The modified `phase-6a-creator-successor-product-entry.ts` retains the pre-existing TS6059/TS6307 diagnostics on its dynamic chat-example import; no diagnostic remains in the new native-browser test or shared server. This is not a package-wide green result.
- [Scoped lint](../../.logs/grid-memory-attribution/native-browser-lint-03/status.json) and [format checks](../../.logs/grid-memory-attribution/native-browser-format-01/status.json) passed for the final two changed test files. The [broader candidate lint](../../.logs/grid-memory-attribution/native-browser-lint-02/status.json) passed with three shared-server JSDoc warnings and no errors.

The command wrappers recorded exact before/after source custody and no remaining processes. [Independent review and correction triage](review.md) are complete at this diagnostic scope. Next implementation requires a separately approved retirement/recovery contract; do not scale to 1,000 epochs or claim whole-storage boundedness from the passing characterization assertions.
