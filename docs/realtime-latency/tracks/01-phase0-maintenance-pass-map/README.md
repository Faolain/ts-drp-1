# Phase 0: map the close-time maintenance passes

**Outcome:** Read-only map. Informed 4c4f192c.

### Brief (plan given to the agent) (2026-10-19 06:44 UTC)

Repository: <repo> (TypeScript monorepo). I'm doing performance root-cause analysis of an epoch "close"/sealing that takes ~7.3s in steady state. Profile says: "Recovery preparation—four passes 3,701ms (Acquire/authenticate/qualify recovery source 1,657ms; Compound native-reservation, lifetime and source-readback checks 597ms; classify journal dependencies 217ms; classify signing summaries 167ms; classify signing details 73ms)" and "Retirement installation and cleanup 2,953ms (coordinate retirement across participants 1,495ms; journal drain branch 354ms; signing-evidence drain 224ms; signing-summary drain 495ms)". A prior diagnosis said: "four complete maintenance passes. Pass1 drains eligible E0/E1 journal 16+12 rows and signing evidence. Pass2 retires five E0 signing-summary rows. Pass3 retires five E1 rows. Pass4 authenticates terminal state and finds no next work. The amplification is complete context reacquisition between lawful per-epoch native units."

Entry point: `reconcileCreatorBoundedRecoveryMaintenance` in packages/node/src/creator-close.ts (~line 2372), which loops `maintenance.reconcile(closeHold, ...)` from `createCreatorSnapshotRecoveryMaintenanceJob` in packages/node/src/internal/creator-closed-rollback-data.ts (~line 21443), which calls `reconcileSnapshotRecoveryRoles` (same file, find it) and `installClosedRetirementSource`. Storage side: packages/storage-browser/src/internal/signing-retirement.ts, packages/storage-browser/src/internal/idb-adapter.ts, packages/storage-browser/src/internal/native-read-reservation.ts, packages/live-journal/src (retirement), packages/storage/src/maintenance*.

I need a precise map (with file:line references) answering:
1. What exactly does ONE reconcile pass do, in order: which reads (IndexedDB/native image reads, generation pages, snapshot reads), which authentications (signature verifies, hash checks, decode of trust records/cuts/QCs), which classification steps, and which native writes (retirement installs/drains). Which of these are the 'acquire/authenticate/qualify recovery source' step?
2. Why does the loop need multiple passes? What in a pass's result returns "fresh-summary-required", and why can't one pass retire signing summaries of multiple epochs (E0 and E1) plus journal rows in one native transaction? Identify the code that limits each pass to one epoch/group (e.g., a selection of 'next group', a per-epoch unit, a limit constant).
3. What state is re-read/re-authenticated in every pass that did not change between passes (e.g., trust records, closed cut evidence, snapshot manifests, signatures), versus what genuinely changes (rows deleted).
4. What does "coordinate retirement across participants" (1.5s) correspond to in code — which function(s)?
5. Where is `ownedMaintenance.parsing` (createCreatorClosedAcquisitionSyntax) used to cache facts across passes, and what is still NOT cached.

Report concisely but concretely: function names, file:line, and a per-pass call outline. Don't propose huge rewrites; just give me the factual map plus your view of which steps are redundant across passes. Read-only; do not modify files.

### Report returned by the agent

Below is the factual map of the close-time recovery maintenance loop, with file:line references. The label-to-code mapping is my inference: no source in the repo contains the profile labels. All paths are under `packages/`. Abbreviations: **RB** = `node/src/internal/creator-closed-rollback-data.ts`, **CC** = `node/src/creator-close.ts`, **CEC** = `node/src/internal/closed-epoch-cleanup.ts`, **SR** = `storage-browser/src/internal/signing-retirement.ts`.

#### 0. Driver (CC:2372-2420)
- **Before the loop:** a pre-census at CC:2377-2390 calls `captureRetirementOwners().acquireEvidence()`, which scans the whole signing image. Its only purpose is to count signer epochs.
- **Pass limit:** `maxMaintenancePasses = 2 + signingEpochs.size + generationCount` (CC:2393).
- **Each pass:** `seal()` builds a new close hold through `registration.sealRecoveryDependencies` (CC:3784 → `node/src/v3-live.ts:19403` → `sealCreatorRecoveryDependencies` `node/src/v3-live.ts:11519`). That rebuilds the replay seal and the runtime dependency census. Then `maintenance.reconcile(...)` runs, and the loop continues while the result is `"fresh-summary-required"` (CC:2406).
- **Job:** `createCreatorSnapshotRecoveryMaintenanceJob` (RB:21443) builds `ownedMaintenance = {input, parsing}` once (RB:21455). Each pass then calls `reconcileSnapshotRecoveryRoles(... currentTrust, ownedMaintenance)` (RB:21464). That returns `installClosedRetirementSource(...)`'s boolean (RB:21393), and `true` is mapped to `"fresh-summary-required"`.

#### 1. One pass, in order: `reconcileSnapshotRecoveryRoles` (RB:20202)

**A. Preliminary reads**
- Snapshot role inventory read: `captureRecoveryRoleInventory` (20223).
- Floor read and capture (20231-20240).
- In the close path `currentTrust` is defined, so `observeCreatorProtectedRecoveryRoles` and `acquireCreatorForwardPromotionSource` are skipped (20252, 20271).

**B. Native exclusions** (`acquireReservations`, 20311-20339), then `checkNativeReservations` (20340):
- journal header hold
- AHE `acquireNativeReadReservation`
- issuance reservation (`lifetime.acquireNativeIssuanceReservation`)
- floor reservation

**C. Optional detached native preparation** (20354-20423, only when `canDetachNativePreparation`):
- `readRetirementControl`, then `captureImages()`, which reads five things: the journal `readRetirementImage`, the snapshot `readRetirementImage`, AHE `readRetirementControl`, the floor `readRetirementImage`, and the inventory.
- All reservations are then released (20402).
- Later, `qualify()` reacquires every reservation and runs `captureImages()` again, byte-comparing (20408-20423). The five images are read twice per pass.

**D. ACQUIRE/AUTHENTICATE/QUALIFY RECOVERY SOURCE (my mapping of the 1,657ms)**

This is `acquireClosedData(...)` at 20435 (RB:7015), followed by `resolveCreatorForwardPromotionSource` (20439), `acquireProtectedUnion()` (20470) and `closeUnion.check()` (20472). Inside `acquireClosedData`:
- Journal header hold and floor read (7112-7138). `openCurrentAnchorTrust(pin)` (7156).
- **Full AHE generations+blobs read:** `acquireBoundedRecoveryRoleRead` (7171).
- Role selection: `selectProtectedRoleImage` (7403) and `strictRoleControls` per row (7407-7412).
- **`authenticate()` (RB:3383):**
  - Blob charge (3419).
  - **Checkpoint trust signature/QC verify:** `openCreatorCheckpointTrust` / `openCreatorForwardPromotionCheckpointTrust` (3489-3506).
  - `prepareCreatorTransitionAdvanceRecheck` (3517).
  - Projection authority checks (3520-3532).
  - `acquireInstalledPromotion` (3538), when the cut has `forwardPromotion`.
  - **`acquireRecoveryRoleCertificate` (3559 → RB:1961).** It does its own `readTarget` for the latest and previous snapshots (2177-2179), `readHeldSourceEnvelope` (2247), source trust (2269, cached) and readback (2442, cached).
  - `matchesCreatorAdoptionReferences` (3567).
  - Snapshot `readiness` (3575).
  - For k in {n-1, n-2}:
    - `openCreatorTransitionClosedCutEvidence` (3584) and the successor-binding inspect (3590-3598).
    - `observeAnchor`: anchor envelope read plus verify (3608).
    - `openCanonicalLatchedAclSnapshot` (3613, 3654).
    - **`readTarget` (RB:3192):** snapshot protection, lookup and acquire; reads every chunk and hashes it with `snapshotChunkDigest` (3315-3324); `decodeSnapshotManifest`.
  - Snapshot `lookup` per cut (3680), `readiness` again (3698), `checkCurrent` (3709).
- `authenticateRole` for the predecessor (7540/7570). `authenticateExcludedHistoricalGenerations` for extra generations (7591).
- **Close-hold section (7610-7809):**
  - `lifetime.borrowDependencies()` (7619).
  - Per retained cut: `readHeldSourceEnvelope` for each epoch (7677), then **`openCreatorSnapshotRecoverySourceTrust`, called directly with no cache** (7712). This re-verifies the anchor chain signatures every pass.
  - An optional extra signing `acquireEvidence` when there are more than 7 trusts (7753).
  - `borrowSigningDependencies`: a full signing image scan (7769).
  - `qualifyNativePreparation` (the second `captureImages`).
  - `qualifyPreparedSnapshots`: `readTarget` again with `qualifiedPreparation`, re-reading every chunk and byte-comparing (3238, 3317-3321).
  - `child.checkWhile(forward.checkCurrent + floorRead)` (7784-7801).

**E. Snapshot role selection (no write in steady state)**
- `inventoryRead` (20550), `selectAuthenticatedSnapshotTurnoverInventory` (20561), snapshot `readRetirementImage` (20563), `selectCurrentSnapshotTurnoverInventory` (20570).
- `reconcile` (the native snapshot RW) runs only if `retiring.length` is non-zero (20826).

**F. COMPOUND NATIVE-RESERVATION / LIFETIME / SOURCE-READBACK CHECKS (my mapping of the 597ms)**
- These are scattered through the pass: 20340, 20349-20351, 20766-20771, 20823, 20862-20865, 20883, 20944, 21049-21051, 21082 (once per inventory scope, next to `lookupReceivedRecoveryCertificate` at 21083), and 21173/21329-21330.
- Each `closeUnion.check()` or `checkHeldCurrent()` runs `checkCurrentSource` (RB:8108). That re-reads a chunk of each held snapshot and hashes it, checks each certificate proof, re-reads anchor preimages (8115), checks AHE currency (8127) and reads the floor. The non-`checkHeldCurrent` variants also wrap this in `closeDependencies.checkWhile`, which re-checks the census.
- That is about 7-8 full source-currency checks per pass.
- If `unchangedSnapshotReadback` is undefined, `observeCreatorProtectedRecoveryRoles` also runs (20867). That is a whole second role acquisition plus authentication.

**G. Retirement-source assembly**
- Reads: journal `readRetirementImage` (20959), snapshot `readRetirementImage` (20967), `inventoryRead` (20986), AHE `readRetirementControl` (20990), floor `readRetirementImage` (21018).
- `closedGenerationReplayIsUnclassified` (21071), then `lookupReceivedRecoveryCertificate` per scope (21081-21097).
- **CLASSIFY JOURNAL DEPENDENCIES (217ms):** `prepareClosedJournalDetails` (21189, detached path) or `classifySourceOwnedClosedJournalDetails` (21196, held path). Per scope it builds membership prefixes, which can call `verifyVertex` (RB:9585-9604), plus `readPage` on the held path (9664).
- **CLASSIFY SIGNING SUMMARIES (167ms):** `classifyClosedSigningSummaries` (21231 → RB:10109).
- **CLASSIFY SIGNING DETAILS (73ms):** `classifyClosedSigningEvidence` (21245 → RB:10372). It runs only when summaries are undefined, which in practice means pass 1.
- Headers (21262), `classifyClosedGenerationSource` (21270).
- On the detached path, reservations are acquired a third time (21328).
- `finally` releases the lifetime, union, held targets and exclusions (21362-21385).

**H. `installClosedRetirementSource` (RB:18940): native writes**
- Hashes `sourceBytes`, `resumeBasisDigest`, `sourceProofDigest` and `decisionDigest` (19028-19099).
- Initial acquires: `acquireCoordinator` (19109), snapshot, journal and issuance participants (19307-19343), floor (19344), signing via `acquireVote` + `acquireEvidence`, two full signing-image scans (19456-19457, 19585).
- `closedAheDataImage` (19148) and `digestBlob(encodeGenerationRecordV1)` for each generation (19614-19620).
- **`applyClosedEpochRetirementIntent` (19801 → CEC:997)**, covered in section 4.
- Drains: `drainClosedJournalDetails` (19857), `drainClosedSigningEvidence` (19878), `drainClosedSigningSummaries` (19897). Each is followed by a full `verifyCompleted` (19874, 19893, 19914).
- **Return value** (19961-19963): `needsFreshSummary = evidenceCompleted || summaryProgressed || rows.length > 5`.

#### 2. Why four passes

**Per-pass outline**
| Pass | What it does | Commit | Returns |
|---|---|---|---|
| 1 | Summaries undefined: the existing completed signing P is from the previous close, so `throughEpoch !== floor-1` (RB:10229-10237). Evidence entries are classified only for epochs that have collectible journal prefixes (RB:10426). Journal prefixes plus evidence drain under one P with policy "covered-local-finalized-evidence" (19015-19022, CEC policy 11043-11051). | new P1 | `true` (19961, via `evidenceCompleted`) |
| 2 | Evidence branch (10244-10257): reconstructs the deleted evidence frames (10262-10271), validates domain 192 (10289-10299), then filters eligible epochs (10301-10340). This finds both E0 and E1, but `selectClosedSigningSummaryEpoch` keeps only the oldest (10356). | new P2 = digest(summarySource E0), 19089 | `true` (`summaryProgressed`) |
| 3 | `same` with `stored` summary and a finished drain, so the residual path runs (10171-10201). It re-authenticates the residual epochs via `authenticateClosedSigningSummaryEpoch` → `verifyCreatorFinalizedEvidence` (10077-10106) and selects the oldest, E1 (10197). | new P3 | `true` |
| 4 | No residual epochs remain, so it returns `stored` (10226). Install replays the same P: `completedMatches` leads to 5 `inspect`s plus `verifyCompleted` (CEC:1182-1186). The summary drain sees `cursor===count`, `progressed=false` (10939-10942), followed by another `verifyCompleted`. | none (no-op) | `false` |

**What limits each pass**
- **One summary epoch per P:** `selectClosedSigningSummaryEpoch` (RB:10063-10068, "One native eligibility unit per acquisition"), used at 10197 and 10356. The native side does not require one epoch: SR:820-832 accepts a multi-epoch summary plan.
- **One drain per committed P on the native signing control:** `begin` requires `drain == null` (SR:770). If `completed.summarySource` is set, the plan must be a summary plan (SR:769). Only a new P's commit clears `drain` (`projectCompleted`, RB:19607-19610). The P's `signingPreparation` embeds `summarySource` (19436-19440), so a summary drain cannot share the evidence P.
- **Summaries are only eligible after a finished evidence drain:** this is required under the coordinator's completed P (10244-10257).
- **Summaries and details are mutually exclusive in one source** (21242-21244). Journal prefixes are suppressed whenever summaries or a generation source are present (19016).
- **The return value means "made progress", not "more work remains"** (19961-19963). Learning that work is finished therefore always costs one extra full pass (pass 4).

#### 3. Re-done every pass although the data did not change
**Unchanged across passes, but re-read or re-verified:**
- Pin trust open (7156).
- Full AHE generations/blobs read and charge (7171, 3419).
- Checkpoint/QC/cut signature opening (3489-3506) and the transition recheck (3517).
- Installed promotion (3538) and recovery-role certificate (3559). The certificate's internal `readTarget`s (2177-2179) re-read every snapshot chunk.
- Closed-cut evidence, successor binding, `observeAnchor` and latched ACL for both k (3584-3622).
- `readTarget` full chunk read plus hash for both snapshots (3315-3324), repeated again in `qualifyPreparedSnapshots`.
- Snapshot lookup and readiness (3575, 3680, 3698).
- `authenticateRole` and excluded-generation authentication (7540, 7591).
- Retained-cut anchor envelopes plus the uncached source-trust open (7677, 7712).
- Native images captured twice (20393, 20412).
- About 8 `checkCurrentSource` runs (section F).
- `closedAheDataImage` and the per-generation `digestBlob` (19148, 19614).
- The 5 participants' initial acquires in install.

None of the generations, blobs, head, floor state, snapshot manifests/payloads, anchor envelopes, trust records, cuts, QCs or issuance rows change after pass 1. The census and journal change only in pass 1.

**What actually changes:**
- Signing rows: evidence deleted in P1, E0 summaries in P2, E1 in P3.
- Journal rows (P1 only).
- Signing `control` (completed P / drain).
- AHE coordinator control (revision, sequence, completed).
- Each participant's control revision and domain (snapshot, journal, issuance, floor).

#### 4. "Coordinate retirement across participants" (1,495ms)
This is `applyClosedEpochRetirementIntent` (CEC:997-1235), plus the participant setup in install (RB:19109-19670), including `createClosedEpochRetirementMetadataParticipant` (CEC:894).

**For each new P (passes 1-3):**
- Coordinator: `readCoordinator`, then `prepareBound` RW with readback (CEC:1101-1134).
- For each of the 5 participants (roles 4 snapshot, 8 journal, 16 issuance, 32 floor, 192 signing): acquire → `prepareFence` RW → acquire readback → `commitPrepared` RW → acquire readback (CEC:1188-1206).
- Then 5 more `inspect` acquires (CEC:1208), the coordinator `commitPrepared` RW with readback (CEC:1210-1231), and `verifyCompleted` (CEC:1233).
- `verifyCompleted` (RB:19671-19800) acquires the coordinator, an AHE reservation and all 5 participants, and reads the journal, snapshot and AHE retirement images.
- Every signing participant acquire costs two full IDB cursor scans of the signing stores (SR:197-306).
- Every coordinator acquire is an AHE RO with whole-image admission (`storage-browser/src/internal/idb-adapter.ts:441` → `readRetirementImagePoint` :353).
- Total: roughly 40 native transactions and 12 strict RW writes per P.

**Pass 4** still does the initial acquires, 5 `inspect`s and two `verifyCompleted`s.

**Drain amplification:** each batch calls `checkCoordinator`, a full coordinator acquire (RB:10585, 10756, 10943). Batch sizes are 16: `LIVE_JOURNAL_RETIREMENT_BATCH_ROWS` (`live-journal/src/retirement.ts:38`) and `SIGNING_DETAIL_RETIREMENT_BATCH_ROWS` (`seal/src/internal/seal-vote-intent.ts:354`). For the 28 journal rows that means begin plus 2 batches, so 3 writes and 4 `readState` calls.

#### 5. What `ownedMaintenance.parsing` caches, and what it doesn't
`createCreatorClosedAcquisitionSyntax` is defined at RB:1070-1090 and created once at 21455.

**What it holds:**
- An exact-byte canonical syntax reader: `createCreatorCanonicalSyntaxReader` (`node/src/internal/creator-snapshot-data.ts:54`).
- `snapshot` (`validateCreatorSnapshotData`).
- `recoverySourceTrust` and `recoveryReadback`, backed by `createCreatorSnapshotRecoveryEvidenceJob` (`node/src/internal/creator-transition-advance.ts:2669`). This caches the verified anchor branch (chain inspection plus pin open) and the per-closure source-trust results (2607-2662).

**Where it is used:**
- `acquireClosedData`: 7078-7082, 7390, 7403, 7410, 7468, 7552, 7578, 7597, 7674-7710.
- `authenticate`: 3401-3404, with pass-through at 3551, 3559 and 3640.
- Certificate: 2269, 2442.

**Not cached:**
- `openCreatorSnapshotRecoverySourceTrust` is called directly at 7712 (and 20667), bypassing `parsing.recoverySourceTrust`.
- `openCurrentAnchorTrust`.
- Checkpoint, successor and forward-promotion trust opens (3480-3506).
- `prepareCreatorTransitionAdvanceRecheck`.
- `openCreatorTransitionClosedCutEvidence`, the successor binding, `openCanonicalLatchedAclSnapshot` and `observeAnchor`.
- All snapshot chunk I/O and hashing.
- `authenticateRole` crypto (only syntax is shared).
- All the classifiers: `classifyClosedSigningSummaries` / `classifyClosedSigningEvidence` (raw `decodeCanonical`, `reconstructClosedSigningEvidenceFrame`, `verifyCreatorFinalizedEvidence`, `view()` per closure), `prepareClosedJournalDetails` (`record(census)`, `verifyVertex`), and install (`record(source.census)`, repeated `decodeCanonical` of signing rows, AHE image and record digests).

#### Which steps look redundant across passes (my view)
1. **The whole of section D, about 414ms per pass**, is re-authentication of facts that never change. The cheapest targeted wins are routing 7712 through `parsing.recoverySourceTrust`, and keeping the per-job verified checkpoint, cut and ACL results keyed by exact bytes, the same way the evidence job already does.
2. **Pass 4 is a pure probe.** Its classification result is the same-P replay already known at the end of pass 3. Pass 3 does run `drainClosedSigningSummaries` and its `verifyCompleted` under the same custody, so it could decide "no residual epochs" itself instead of returning `summaryProgressed`.
3. **Splitting E0 and E1 into separate passes is a node-side policy.** It is `selectClosedSigningSummaryEpoch`, not a native limit: the native summary plan accepts multiple epochs (SR:820-832). Pass 2 already authenticates E1 as eligible at 10301-10340 and then discards it.
4. **Repeated checks within a pass:** `verifyCompleted` runs immediately after `apply`'s own `verifyCompleted`, then again after each drain. The images are read twice (C plus qualify), and there are about 8 `checkCurrentSource` runs per pass.

For targeted instrumentation without code changes, the existing `__warmProofEvent` observers can be hooked. `closed-retirement-selection` at RB:21281 reports `summaryEpochs`, `evidenceEpochs` and `journalCollectible` for each pass.
