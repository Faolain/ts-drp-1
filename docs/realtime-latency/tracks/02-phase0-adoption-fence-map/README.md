# Phase 0: map the creator adoption fence path

**Outcome:** Read-only map. Informed 4c4f192c.

### Brief (plan given to the agent) (2026-10-19 06:44 UTC)

Repository: <repo> (TypeScript monorepo). I'm doing performance root-cause analysis of creator "adoption" of a successor epoch (~2.2s). Profile: "Drain settlement/rebase outbox 1,407ms; Prepare new-epoch ordinary-admission readiness 341ms; Stage adoption 243ms; Publish staged adoption 227ms; Activate successor session 151ms". A prior diagnosis: "The slow local issue is a 433-byte mandatory $drp.author-fence.v1 control (planEffectKind fence). v3-room drainSettlementOutbox issues it when fenceSequence is null. The fence takes original cold maintenance preparation, not ordinary incremental admission. Its native issue 1527ms contains cold quote 697ms / proof capture 586ms, source hint 302ms, forecast 266ms, write reservation 59ms."

Relevant code: packages/node/src/v3-room.ts (find drainSettlementOutbox), packages/node/src/v3-live.ts (21k lines; issuance path), packages/node/src/creator-close.ts: `maintenanceConsumer` inside `bindCreatorLiveClose` (~line 3398-3579) which picks between `prepareCreatorIncrementalIssuanceMaintenanceQuote`, `prepareCreatorOrdinaryIssuanceMaintenanceQuote` (warm), and `prepareCreatorIssuanceMaintenanceQuote` (cold, ~line 2107), plus `captureCreatorOrdinaryIssuanceProofSourceForFence` and `chargeCreatorIssuanceMaintenanceQuote`. Proof acquisition: `acquireCreatorIssuanceMaintenanceProof` in packages/node/src/internal/creator-closed-rollback-data.ts (~line 6526). Also `prepareCreatorOrdinaryReadiness` (creator-close.ts ~4850) for "ordinary-admission readiness".

I need a precise map (file:line) answering:
1. The full call path from adoption (`adoptCreatorSuccessor` / settlement drain) to the fence control's issuance and the maintenance consumer. Which branch does the fence take and why (planEffect.kind === "fence" makes `ordinaryDomain` false?).
2. What does the cold path `prepareCreatorIssuanceMaintenanceQuote` do step by step: reads, authentications, forecasts ("UNKNOWN forecast"), sizing — and which of those duplicate work that was just done during sealing of the same transition (e.g., the close already authenticated the same sources/snapshots).
3. What does `prepareCreatorOrdinaryReadiness` do and is it redundant with the fence's cold proof (both prime the "ordinary proof source")?
4. Is there any reason the fence control could not be prepared (quote computed) during sealing, or issued through the incremental path, from a pure data-dependency standpoint? List the concrete inputs the quote depends on.
5. Any obviously repeated work: e.g., the same proof source captured twice (`captureCreatorOrdinaryIssuanceProofSourceForFence` then later readiness capturing again).

Report concisely with function names and file:line references and a call outline. Read-only; do not modify files.

### Report returned by the agent

#### Creator successor adoption: fence control call path and repeated work

**Short answer:** the fence takes the cold path because a fence carries a `planEffect`. That makes `ordinaryDomain` false at C:3440. It also has nothing warmer to use: the new binding for epoch E+1 has no ordinary source yet, because readiness only runs after the drain (R:6410 → R:6412). The fence's cold proof re-checks data that the close and adoption had just checked. Readiness then repeats all of the fence's native reads a moment later.

File abbreviations (all absolute):
- R = packages/node/src/v3-room.ts
- L = packages/node/src/v3-live.ts
- C = packages/node/src/creator-close.ts
- D = packages/node/src/internal/creator-closed-rollback-data.ts

##### 1. Call path from adoption to the fence and the maintenance consumer

**Adoption (v3-room)**
- `adoptCreatorSuccessor` R:6425 → `performCreatorSuccessorAdoption` R:6217, which runs in this order:
  - `verifyCreatorSuccessorAdoption` R:6266-6272. This checks the new Cut/QC and successor trust.
  - `stageCreatorSuccessorAdoption` R:6277, then `beginRoomHeadAdvance` R:6286.
  - `publishStagedCreatorSuccessorAdoption` R:6294, then `commitRoomHeadAdvance` R:6299.
  - `activateCreatorSuccessorAdoption` R:6305.
  - `predecessor.deactivate` R:6364.
  - `bindCurrentCreatorClose(replacement)` R:6388 (defined R:3929-3974) → `bindCreatorLiveClose` C:3319. This installs `maintenanceConsumer` on the new E+1 registration at C:4834 (L:19495-19503).
  - `commitSuccessorProjection` R:6407; `publishAccepted` R:6409.
  - `drainRebaseOutbox` R:6410 → R:5238 → `drainSettlementOutbox(sources)` R:5269.
  - `prepareCurrentCreatorOrdinaryReadiness` R:6412 (this is the "readiness 341ms" phase).

**Settlement drain**
- `drainSettlementOutbox` R:4895.
  - With zero sources it skips the virgin-author shortcut, because `lineage.next !== 0` (R:4896-4910).
  - `writeMergedSettlementPlan` R:4673-4691: reads the plan, reads the prior fence's issued record, and decodes its epoch. The closure at R:4647-4653 sets `fenceSequence = null` because `priorFenceEpoch !== activeEpoch`. It then writes the plan with `transactWriteSettlementPlan`, which changes the native issuance image.
  - The fence is issued at R:5010-5031: `$drp.author-fence.v1` with `fenceSequence = lineage.next`.
  - `issueSettlement` R:4808: `readSettlementPlan`/`readLineage` (R:4822-4823), `activeHandle.issueLocal` (R:4841), `readIssued` (R:4881), `publishAccepted` (R:4892).

**Issuance (v3-live)**
- `handle.issueLocal` L:19554 → `enqueueLocalIssue` L:15033 → `issueLocal` L:14867.
  - `localSnapshotAdmissionFailure` at L:14884.
  - `isAuthorFenceOperation` → `issueAuthorFence` L:14790.
- `issueAuthorFence` L:14790:
  - `readSettlementPlan` again (L:14804).
  - `readBoundedRecoveryCensus` (L:14826).
  - `issueOneVertex(..., {kind:"fence"})` (L:14854).
- `issueOneVertex` L:14316:
  - `localSnapshotAdmissionFailure` runs a second time (L:14331).
  - The fence branch (L:14519-14556) calls `transactWithPlanEffect` → `issuanceStore.transactIssue` (L:14503) → `buildInNativeJob` (L:14402).
  - `admittedSign` calls `registration.creatorMaintenanceAdmission({kind:"local-issuance", exactCanonicalUnsignedVertexBytes, planEffect})` at L:14443-14449.
  - Then `beginWrite` (L:14450), `nativeSignAdmission(bytes, sign, maintenanceAdmission.context)` (L:14461), `endWrite` (L:14504).
  - After signing: `authenticateRecoveryVertex` (L:14615), `appendAccepted` (L:14682), `advanceCreatorOrdinaryRuntimeCapacityGeometry` (L:14745), `accepted` (L:14752), `release` (L:14786).

**Branch choice in `maintenanceConsumer` (C:3398)**
- `planEffect` is captured at C:3421.
- `ordinaryDomain = planEffect === undefined && archive === undefined && readCreatorOrdinaryPreimageCapacityForSizing(...)` at C:3440. The fence preimage itself is inside the syntactic domain (D:14451-14478); only the plan effect excludes it.
- So the incremental branch (C:3452) and the warm branch (C:3484) are both skipped, and the cold branch runs (C:3496-3524):
  1. `prepareCreatorIssuanceMaintenanceQuote` (C:3497) — the "cold quote".
  2. `captureCreatorOrdinaryIssuanceProofSourceForFence(cold.proof, bytes)` (C:3505-3507) — the "source hint".
  3. `chargeCreatorIssuanceMaintenanceQuote(cold, bytes, planEffect, undefined)` (C:3515) — the "forecast".
  4. `ordinaryProofSource = fenceSource; ordinaryTemplateReady = false` (C:3516-3518).

##### 2. What the cold path does, step by step

`prepareCreatorIssuanceMaintenanceQuote` C:2107:

**a. Hold**
- `sealIssuanceMaintenanceDependencies` C:2116 → L:19444 → `sealCreatorRecoveryDependencies(…, "issuance-preview")` L:11519.
- It captures the runtime, runs `sealCreatorDurableReplay` (L:11559), and runs `readCreatorRecoveryDependencyCensus` (L:11596). The census is the full one: native issuance rows, image and control, anchors, journal and unsettled sources.
- This hold allows `canDetachNativePreparation` (L:3906-3907).

**b. Proof — `acquireCreatorIssuanceMaintenanceProof` D:6526** (the "proof capture 586ms", called from C:2340 with `mandatoryAdoptionFence = true`)
- Because it is a fence, it gets the larger maintenance book (D:6642, D:6734).
- Reservations: AHE, journal, issuer and floor (D:6606-6630).
- Snapshot `captureRecoveryRoleInventory` is read three times: D:6635, D:6700, D:6762.
- `captureNativeImages` reads the journal, snapshot, AHE and floor retirement images. It runs twice: D:6643 for preparation and D:6699 in `qualify`, which compares them for equality.
- `acquireClosedData` D:7015:
  - Journal header hold, `floorRead` (D:7120). At epoch ≥ 2 it switches to the protected union with a full `acquireBoundedRecoveryRoleRead` (D:7145-7154, D:7171).
  - `selectProtectedRoleImage` and `strictRoleControls` (D:7401-7415).
  - `authenticate` (D:3383). It charges every reader blob, re-opens the E→E+1 Cut/QC/trust (`openCreatorSuccessorTrust` / `openCreatorCheckpointTrust` / `openCreatorForwardPromotionCheckpointTrust`, D:3474-3506), and runs `prepareCreatorTransitionAdvanceRecheck` (D:3517). It also covers the projection/catalog, held snapshot targets, installed promotions and recovery certificates.
  - `borrowSigningDependencies` (D:7769). Its prepare callback (D:7770-7775) runs the quote sizing below.
  - `qualify` (D:7779), `qualifyPreparedSnapshots` (D:7780), and a floor re-read under `checkWhile` (D:7784-7801).
- Afterwards: `captureCreatorMaintenanceReceivedRecoveryScopes` if needed (D:6790), observation charges (D:6794), `check()` (D:6813), and `collectClosedJournalHeaderScopes` (D:6814).

**c. Sizing callback (C:2121-2338)**, run inside proof acquisition via `prepareData` (C:2353 / C:2358):
- `prepareIssuanceContinuation` (C:2124 → L:17451).
- `readProspectiveRuntimeCensusOverhead` (C:2125 → L:17708).
- `inspectCreatorCloseHead` (C:2135) and a census decode.
- `issuanceUnsignedPostimageWidths`, including the plan effect and exact plan bytes (C:2160-2171).
- `previewIssuanceClose` (L:18733): copies the graph, adds the fence, forks and folds the blueprint machine, and builds the projection and ACL preview.
- `prepareProspectiveCreatorCloseMaterialFromPreview` (C:2183-2189): builds a hypothetical close of epoch E+1 (Cut, snapshot payload/manifest/chunks, successor ACL, anchor and QC/trust widths).
- `prospectiveCreatorMetadataWidths` (C:2199).
- `prospectiveCreatorAdoptionBytes` (C:2208): the E+2 projection and history.
- `readProspectivePostAdoptionCensusSizing` (C:2219 → L:17866): sizes the next successor fence at E+2 (L:18264-18546).
- `ordinaryFinishingCapacityDimensions` is skipped because of the plan effect (C:2226).
- `readCreatorCloseSigningFramesForSizing` (C:2228).
- The returned context includes the image digest, control bytes and `planEffect` (C:2242-2246).

**d. Source hint — `captureCreatorOrdinaryIssuanceProofSource` D:5223** (via D:5585; "302ms")
- Runtime source identity (D:5271) and read-only witnesses (D:5273).
- Application journal effects and controls are charged (D:5277-5300, D:5334-5339).
- Fence plan/lineage checks (D:5312-5330).
- It requires `knownMaterial` total to equal `chargedBytes` (D:5342-5345). This forces it to run before the forecast's UNKNOWN charges.
- `detach()` deep-copies the summary, generations, blobs, floor, AHE, snapshot and journal, then builds a material index (D:5544-5555).
- `custody.check` runs twice (D:5256, D:5564).

**e. Forecast — `chargeCreatorIssuanceMaintenanceQuote` C:2820** ("266ms")
- `creatorIssuanceMaintenanceQuoteSizing` (C:2757).
- `readProspectiveCreatorMaintenancePrefixesForSizing` (D:14714) is the "UNKNOWN forecast":
  - Post-adoption readout and snapshot turnover.
  - Journal membership prefixes. When the prefixes are not owned, this reads each scope plus another `readRetirementImage` (D:14742-14748).
  - `isAuthenticatedInitialAdoptionDrain` (D:15346), a fence-only branch.
  - `compose…` can run twice: D:14760, then D:14775 if the capacity envelope does not fit.
- Then known and UNKNOWN charges are applied (C:2844-2855).

**f. Write reservation — `beginWrite` D:6878** ("59ms"): `check`, release of close dependencies and the issuer reservation.

**What duplicates the seal/adoption of the same transition**
- **Cut/QC and trust for E→E+1:** produced by `actor.close` / `openCreatorSuccessorTrust` (C:4047-4060) and verified again by `verifyCreatorSuccessorAdoption` (R:6268). The cold `authenticate` re-opens them a third time (D:3474-3517).
- **AHE generations and blobs, including the new Adopted generation:** just written by stage and publish. The cold proof re-reads all of them under the protected role read.
- **Snapshot and recovery sources for epochs E and E-1:**
  - The close authenticated the E-1 source through `acquireRecoverySource` → `acquireCreatorForwardPromotionSource`. It did this up to three times: C:3711 or C:3806, and again after membership at C:4041.
  - The close also staged and persisted the epoch-E snapshot (C:3713, C:3882).
  - The cold proof re-authenticates both as held targets and certificates.
- **Fence sizing:** each maintenance quote at epoch E already sized this exact E+1 fence through `readProspectivePostAdoptionCensusSizing` (L:18264-18546: `fenceSequence`, preimage width with a max-safe `logicalTime`, reserved/entered native job phases, journal append, archive continuation). It used the room's preview `mergedSettlementPlan([], priorPlan)` and `fenceLogicalTime` (R:3942-3955). The E+1 cold quote then forecasts again, for the hypothetical E+1 close, the E+2 adoption and the E+2 fence.
- **Within one acquisition:** native images are read twice, inventory three times, and the floor twice. The plan is read three times across R:4674, R:4822 and L:14804.

##### 3. `prepareCreatorOrdinaryReadiness` and overlap with the fence's cold proof

Path: R:5441 → C:4850 → `prepareOrdinaryReadiness` C:4632.
- It takes the fence hint as `priorOrdinarySource` and clears the live slot (C:4644-4645).
- If epoch ≥ 3 and there is a finishing window: `readGenerationPage` (C:4682), `readRetirementControl` (C:4685), `recoveryStatus` (C:4688), then `prepareOrdinaryNativeMetadataForReadiness` (C:4702).
- `prepareSource` (C:4651) → `refreshCreatorOrdinarySourceReadiness` (C:2477):
  - `sealOrdinaryIssuanceMaintenanceRuntime` (C:2484).
  - `acquireCreatorOrdinaryIssuanceMaintenanceProof(prior = fence hint)` (D:6063):
    - New AHE, journal, issuer and floor reservations, plus one snapshot protection per scope (D:6104-6120).
    - A full `acquireBoundedRecoveryRoleRead`, byte-compared to the hint (D:6122-6133).
    - Journal, snapshot, AHE and floor images and the inventory (D:6136-6150).
    - `readNativeIssuance` (D:6151).
    - `creatorOrdinaryMandatoryFencePlansCorrespond` (D:6019, D:6164-6167): checks the real fence postimage against the prior state plus the plan effect, via `checkCurrentOrdinaryWork`.
    - A new ordinary book that re-charges all of the hint's known material (D:6205-6255).
    - `checkCurrentJournal` (D:6257), `anchorRead` per dependency (D:6258-6263), `borrowSigningDependencies` (D:6264).
  - `prepareCreatorOrdinaryIssuanceProofSourceReadiness` (D:5598): `captureReadinessPreparation` (D:5621), the material index again (D:5653), `prepareCreatorOrdinarySourceReadinessForSizing` (D:5655).
- Fallbacks:
  - If the refresh returns undefined, it calls `captureCreatorOrdinarySourceWithoutForecast(…, readiness = true)` (C:4672 → C:2427). That is a second full cold `acquireCreatorIssuanceMaintenanceProof` (C:2440).
  - If the source is still not prepared, it runs `runOrdinaryReadinessMaintenance` / `reconcileCreatorBoundedRecoveryMaintenance` (C:4712-4730) and then another cold capture.

**Is it redundant?** Partly.
- On a warm hit, the hint does avoid a second Cut/QC chain authentication, because the warm proof matches bytes against the hint instead.
- It still repeats all of the fence proof's native I/O moments later: reservations, the full AHE role read, four images, inventory, native issuance, anchors and signing dependencies.
- It also re-charges and re-indexes the same corpus: `createCreatorOrdinaryFinishingMaterialIndex` runs at D:5555 and again at D:5653.
- The hint costs 302ms on the fence's critical path and exists only to make readiness warm.
- By design the two cannot be merged today:
  - The fence capture explicitly declines when readiness is requested (D:5240-5241: `adoptionFencePurpose` set but `readiness !== undefined` → decline).
  - The comment at C:3499-3504 says readiness still owes a new complete ordinary proof of the signed fence and its settlement postimage.

##### 4. Could the quote be computed during sealing, or go through the incremental path?

**Incremental or warm path: no, in the current code.**
- `ordinaryDomain` requires no plan effect (C:3440).
- There is no prepared source at E+1. `creatorOrdinaryIssuanceSourceReadinessPrepared` (C:2548) needs readiness, which runs after the fence. Each side is waiting on the other.
- Source identity is tied to the registration (D:6098), so the epoch-E source cannot be used at E+1.
- Warm and incremental proofs use the ordinary-size book (D:5614, D:6205), but the fence needs the maintenance-size book (D:6642).
- Warm `issuancePhases` and `context` drop `planEffect` and the plan bytes (C:2719-2721, C:2732-2733). The fence's `nativeSignAdmission` needs `planEffect` in the context (L:14461; the cold path includes it at C:2245).
- `readCreatorOrdinaryFinishingCapacityForSizing` refuses any `planEffect` (D:14796).

**Sizing DATA during sealing: yes, from a pure data standpoint.** Every byte-level input is fixed once `actor.close` returns:
- **Fence preimage fields:**
  - anchor = successor anchor (from C:4054-4060)
  - author
  - `authorSequence` = `fenceSequence` = `lineage.next` (prospectively `horizonSequence + 1`, L:18267)
  - `dependencies` = [new anchor] (required by D:15365)
  - epoch E+1, objectId, kind, protocolMajor
  - `logicalTime` = the room clock (R:5015; preview `fenceLogicalTime` at R:3952)
- **Plan postimage:** `mergedSettlementPlan([], priorPlan)` with revision + 1 and `fenceSequence` null, then fence applied (R:3951; `applySettlementPlanEffect` L:18293).
- **New-epoch runtime census:** `graphVersion` 0, empty journal and pending ingress, empty unsettled sources (the shape asserted in D:15366-15374).
- **Hypothetical E+1 close material:** the blueprint state after the E fold plus one control vertex, the latched ACL, snapshot chunks (the same app state as the E snapshot), Cut/QC/trust widths.
- **Adoption and E+2 fence sizing,** and **signing frames** (current trust, storage incarnation, signing rows).
- **Snapshot turnover / journal membership prefixes:** from the same authenticated sources the close already held.

**What genuinely exists only after adoption** (custody and currency, not sizing):
- AHE head = the E+1 Adopted generation (after publish).
- Floor stable at E+1 (`commitRoomHeadAdvance`, R:6299).
- The new plane registration and runtime identity, and its signing dependencies.
- The native issuance image digest after the drain's plan write (R:4686). It becomes `context.expectedIssuanceImageDigest` (C:2239-2244), which is the transaction's CAS (compare-and-swap) check.
- Journal, snapshot and AHE retirement images and inventory, plus the native reservations from `acquireReservations` and `qualify`.

So the expensive authentication and sizing could be prepared at seal time. Only a cheap requalification (fresh images, image digest, head and floor equality) has to happen after adoption. Two caveats:
- The plan write's image digest is a real ordering dependency, unless the plan write is moved or folded into the fence transaction.
- The hint's `chargedBytes == known` check (D:5343) requires capturing the hint before any UNKNOWN charge.

##### 5. Repeated work found

1. The E→E+1 Cut/QC/trust is opened three times: by the close, by `verifyCreatorSuccessorAdoption`, and by the cold `authenticate` (D:3474-3517).
2. The closed sources and snapshots are authenticated by the close (`acquireRecoverySource` up to three times, C:3711/3806/4041) and then again in full by the fence's cold proof.
3. The fence proof re-reads its own inputs: native images twice (D:6643, D:6699), inventory three times (D:6635/6700/6762), floor twice (D:7120, D:7787), and possibly a further journal image read in the forecast (D:14747).
4. The fence hint and readiness both build an ordinary source. The fence capture (D:5223) deep-copies everything; readiness (D:6063 + D:5598) then re-acquires every native read, re-charges the whole known corpus, and rebuilds the material index (D:5555 vs D:5653). If the warm refresh misses, readiness does a second full cold proof (C:2440).
5. The prospective fence sizing done at epoch E (L:18264-18546) is not reused. The E+1 fence pays a new full forecast (D:14714), whose compose step can run twice (D:14760/14775).
6. Small items: the settlement plan is read at R:4674, R:4822 and L:14804; the lineage at R:4823 and R:5011; `localSnapshotAdmissionFailure` runs twice (L:14884, L:14331); and `issueAuthorFence` adds an extra `readBoundedRecoveryCensus` (L:14826).

**Side note:** `packages/node/src/creator-close.js` and `packages/node/src/internal/creator-closed-rollback-data.js` are untracked compiled files dated Oct 9, sitting next to the `.ts` sources. They do not contain the fence-hint code, so the profile you have did not come from them. They could still confuse module resolution in some runners.
