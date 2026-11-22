# Track V: settlement for the Grid example and the v3-chat demo

Worktree: <worktree agent-a84dc20beddb97044>/
Branch: worktree-agent-a84dc20beddb97044 (base 19caa468, codex/phase3a1b-p6-golden-path)
Evidence: <evidence>/track-v/ (PROGRESS.md, MAP.md, logs/, tests/, bin/, data/, trash/).

The user's decision "R-A for all shipped apps" (2026-10-20) asks that the shipped apps sign
`creator-trusted-settlement-v1`. Track T switched Canvas and stopped for Grid and v3-chat, because tests pin their
genesis bytes. The owner then approved "Amend pins, switch both": change only the profile name and the ACL version in
the pinning tests, switch both apps, and prove that storage and latency stay flat.

## Summary

- **Grid: switched, then stopped at the browser proof. Do not merge the switch yet.**
  - The pin amendment (d5a0015f) and the switch (15bf2ed1) are done. One exported source of truth,
    examples/grid/src/profile.ts, feeds the zone's invite builder.
  - On Node (SQLite, the shipped `createV3ZoneApi`) storage is flat. From epoch 6 the creator and the Writer
    recipient each hold 13 issued rows and 13 outbox rows, with nothing pending. Per-move native work is flat. That
    holds through 16 successors, a reopen of both peers from disk and one more epoch. On legacy each peer gains 2 rows
    per epoch.
  - **In Chromium, on the shipped Grid page with real networking, the creator's blocks stop reaching the Writer after
    the fourth successor.** It happened in 4 of 4 HEAD runs at epoch 5, and in a fifth HEAD run that paused 5 s after
    each install it happened at epoch 4. The Writer's blocks still reach the creator. Base (legacy) passes all 16
    epochs, and 8 of 8 with the pause. This breaks G3: every admitted Writer stays correct on the golden path. Under
    the hard rule I stopped Grid here. The counterexample is in section 3.
  - **The existing shipped Grid spec also fails at HEAD.** tests/phase-3a1b-d9346-v3-zone.pw.ts passes 2/2 at base in
    two runs and 0/2 at HEAD in two runs (section 3.7):
    - An ordinary placement now builds a finishing resource program.
    - After a migration, a new joiner's zone fails with `issuance retirement plan has no lineage`.
- **v3-chat: not switched.** The approval does not cover it. The phase-6a oracle `isD110cBSuccessorAuthority` is
  asserted on the v3-chat product and also on a legacy direct room in the same Playwright test. No literal swap
  satisfies both. Section 1.2 lists the three ways out; none is covered.
- **Pre-existing Grid defects found along the way** (section 5):
  - On legacy, the shipped zone's creator cannot reopen after any rollover, because `join()` gives the creator the
    wrong bootstrap roster. On settlement it reopens.
  - A Node-host Writer reopen right after epoch 2 fails on both profiles.
- **The bench is not the shipped Grid** (section 6.1). Track M/M2's Grid Chromium evidence applies to the settlement Grid
  application, not to the shipped composition.
- **Checks.** `pnpm -r typecheck`: 0 errors (46 packages). `node scripts/check-shadowed-sources.mjs`: clean. The
  amended phase-3 pin test passes 9/9 at HEAD. Section 6 compares the Grid-related test sets with base. I did not run
  the full step-7 suites or the step-5 endurance run, because of the stop.

## 1. Map and pins

The full map is <evidence>/track-v/MAP.md.

### 1.1 Grid: the amended literals (d5a0015f)

Only tests/phase-3-exit-genesis-roots-red.test.ts pins Grid. In the test "routes both real product creator paths
through the shared builder":

| Where                                                         | Base                   | HEAD                              |
| ------------------------------------------------------------- | ---------------------- | --------------------------------- |
| Zone latched ACL, inline `encodeCanonical` (line 644)         | `version: 1`           | `version: 3`                      |
| Profile id asserted for the zone call of `expectProductInput` | `"creator-trusted-v1"` | `"creator-trusted-settlement-v1"` |

**One structural change, flagged for a decision.** `expectProductInput` serves both the chat call and the zone call,
and it hard-codes the profile id. v3-chat stays legacy, so the Grid value cannot change by editing that one literal.
The amendment does three things:

- It adds `readonly profileId: string` to the helper's `expected` record.
- The chat call passes `"creator-trusted-v1"`, so the chat bytes asserted are identical to base.
- The zone call passes `"creator-trusted-settlement-v1"`.

Both checks are still exact equality on the full canonical profile bytes, and nothing is loosened. The values are
independent literals, not imported from the app. Had both apps switched, this would have been a single literal swap.

The commit fails alone, because the zone ACL bytes differ (<evidence>/track-v/logs/pins-amend-only.log). It passes
9/9 after the switch (logs/pins-head.log).

### 1.2 v3-chat: what blocks it (not covered)

- tests/fixtures/phase-6a-v3/creator-successor-product-contract.ts has two oracles that require
  `record.profileId === "creator-trusted-v1"`:
  - `isD108d2Authority` (722-744).
  - `isD110cBSuccessorAuthority` (752-775; the literal is at 773).
- packages/storage-browser/tests/phase-6a-creator-successor-product.pw.ts applies `isD110cBSuccessorAuthority` to two
  different rooms:
  - The v3-chat product, at 2516, 2518-2527, 2540 and 2555-2564. The entry's `rawAuthorityAtEpoch` (730-801)
    hard-codes the literal at 796.
  - At 2595, a direct room: `openDirectCreator(closeBindFailureName)` calls the entry's
    `createDirectRoom(name)`, which by default signs the legacy profile (entry 1345 and 1350).
- So, with v3-chat on settlement, line 773 would have to be the settlement id for 2516-2564 and the legacy id for 2595.
  The ways out:
  - A. Give the oracle an `expectedProfileId` parameter and update its call sites, including the pw types at 39 and 50.
    That changes a predicate's structure.
  - B. Switch the entry's direct rooms and pw:2901 too. That changes another test.
  - C. Accept either id. That loosens the assertion.
- The pw spec itself fails at base, in its bundling step (`D110C_0C1_INSTRUMENTATION_SEAM_INVALID`,
  logs/p6a-d110cb-base.log).
- tests/phase-6a-creator-successor-product-red.test.ts: 9 pass and 4 fail at base, the same at HEAD.

## 2. The switch (15bf2ed1) and every change beyond the two values

- examples/grid/src/profile.ts (new) exports `GRID_GENESIS_PROFILE`, with `profileId`
  `"creator-trusted-settlement-v1"` and `latchedAclVersion` 3. It carries the same legacy-profile comment as
  examples/canvas/src/profile.ts.
- examples/grid/src/v3-zone.ts, `createCreatorInviteMaterial`: the ACL `version` and the profile `profileId` now read
  `GRID_GENESIS_PROFILE`.
- No other app change, and no library change. One consequence: the migration targets this builder makes (via
  `rehearseMigration`) now sign settlement as well.
- The only change beyond the two values is the helper relocation in section 1.1.
- Docs: specs/grid-memory-production/lifecycle-audit.md:29 said the Grid builder selects `creator-trusted-v1`. It now
  keeps that as history and notes the change (27fe2688).
- tests/r9-grid-outcome-transfer-native.test.ts:3511 is an existing test named "native Grid shipped none-settlement
  profile". Its name is now stale. I did not edit it.
- tests/fixtures/startup-discovery/browser-red.pw.ts:176 builds its own legacy invite. Track T already noted it. Track
  U owns that directory.

## 3. The counterexample: the creator's blocks stop reaching the Writer (Chromium)

### 3.1 The harness

The harness is tests/track-v-grid-long-room.pw.ts, run with playwright.track-v-grid-long-room.config.ts.

- It serves the shipped Grid page as d9346 serves it: Vite dev server, network fixtures, and two relays. Gossip and
  direct streams are real libp2p.
- There are two browser contexts. Each has its own account floor (`installGridRoomHeadAuthority`).
- The creator creates the zone through the UI with the Writer's enrollment, and the Writer joins with the invite.
- Each epoch, each peer places 2 blocks, interleaved, through `__TS_DRP_V3_ZONE__.placeBlock`. After each block the
  harness polls the other page until the block shows. Then it waits 300 ms.
- The creator then runs `sealEpoch`, `exportCreatorSuccessor` and `adoptCreatorSuccessor`. The Writer runs
  `installCreatorSuccessor` with the offer, from the creator's peer id.
- Each epoch prints in-page latency, an IndexedDB census and console warning counts.

### 3.2 Runs

| Run        | Side | Epochs passed | Stuck at                       | Note                                                           |
| ---------- | ---- | ------------- | ------------------------------ | -------------------------------------------------------------- |
| c1         | base | 16/16         | -                              | load 40                                                        |
| p5pause    | base | 8/8           | -                              | 5 s pause after each install; no ingress warnings in any epoch |
| c1         | HEAD | 4             | epoch 5, creator's first block | load 26                                                        |
| c2         | HEAD | 4             | epoch 5, creator's first block | load 53                                                        |
| p1         | HEAD | 4             | epoch 5, creator's first block | probe, below                                                   |
| p4nocensus | HEAD | 4             | epoch 5, creator's first block | IndexedDB census off: the harness's reads are not the cause    |
| p3pause    | HEAD | 3             | epoch 4, creator's first block | 5 s pause after each install                                   |

Logs: <evidence>/track-v/logs/chromium-<run>-<side>.log. Traces of the failures are in the matching -results folders
(the c1 HEAD trace is unpacked in data/chromium-c1-head-trace).

### 3.3 What the Writer sees

From the traces and console tails:

- **Every HEAD epoch:** the Writer logs `::v3-ingress not-authenticated` while the creator adopts. That is the
  creator's settlement author fence, published before the Writer has installed the successor.
- **When the creator's first block of the next epoch arrives:** the Writer logs `::v3-ingress graph-rejected`. The block
  waits in pending ingress for the missing fence.
- **Epochs 2-4:** the block arrives about 1.5-2 s after install. That fits the retained-history requests the Writer
  schedules at install (packages/node/src/room-network.ts, delays 0, 0.5, 1.5, 3, 6, 10 and 15 s).
- **The stuck epoch:** the block never arrives, and no further ingress line follows.
- **Base:** no ingress warnings in any epoch, because legacy issues no fence.

### 3.4 The probe

With `TRACK_V_GRID_PROBE=1` (run p1), after the stuck block:

- The creator places another block. It never reaches the Writer either, and the Writer logs nothing for it.
- The Writer places a block. It reaches the creator.
- The Writer's `durableVertexCount` stays at 1, and the creator's is 3.

### 3.5 What this establishes, and what it does not

**Established.** The fence published at adoption depends on the retained repair path. In the shipped browser
composition that path stops delivering the creator's work to the Writer after a few successors. After that, every
creator operation stays pending at the Writer. The Node test does not see this, because its delivery is idealised: each
flush hands the Writer every published row in issue order after install.

**Not established.**

- Whether the cause is in the retained repair, in the ingress queue, or in the relayed direct stream. The stuck point
  is 33-41 s of page time in every run.
- Whether Canvas (already on settlement since Track T) has the same stall with real networking. Track T's Chromium
  evidence used Track M's harness, not the shipped page's network.

Fixing this needs library work, which this track may not do.

### 3.6 The Chromium numbers before the stall

C/R = creator/Writer. Rows are IndexedDB records across all of the origin's databases. Issued is the
issuance store's `issuedRecords` count.

| Epoch       | C rows / issued | R rows / issued | Seal ms | Adopt ms | Install ms |
| ----------- | --------------- | --------------- | ------- | -------- | ---------- |
| base 1      | 57 / 3          | 43 / 3          | 183     | 314      | 215        |
| base 4      | 148 / 9         | 116 / 9         | 266     | 518      | 1167       |
| base 8      | 181 / 17        | 160 / 17        | 2947    | 448      | 1698       |
| base 16     | 213 / 33        | 192 / 33        | 3509    | 449      | 2156       |
| HEAD 1 (c1) | 62 / 5          | 49 / 5          | 116     | 438      | 259        |
| HEAD 4 (c1) | 145 / 7         | 126 / 14        | 263     | 828      | 1571       |

- Base slopes from epoch 8: seal +192 ms per epoch, install +81, issued +2 rows per epoch per peer, IndexedDB rows +4.
- HEAD stops before a steady epoch, so there are no HEAD slopes.

### 3.7 The shipped Grid spec, tests/phase-3a1b-d9346-v3-zone.pw.ts

It runs with playwright.phase-3a1b-d9346-zone.config.ts. Base passes 2/2 in both runs; HEAD passes 0/2 in both runs
(logs/pw-d9346-{base,head}.log and the -2 reruns).

- **"bounded real Grid movement overlaps placement and observes healthy rollover without an authority bridge"**
  fails at line 474: "supported ordinary placement must not construct future resource programs".
  - The creator's first placement at epoch 0 records an `ordinary-finishing-resource-program-build` in phase
    `boundary-preparation`, inside the placement window.
  - On settlement, an ordinary issue does work that the legacy profile never does on that path.
- **"two real network clients recover and converge one durable v3 zone while movement stays transient"** fails at
  line 908.
  - The sequence is: rehearse and activate a migration, then a new joiner joins with the original invite and is
    redirected to the target zone.
  - The joiner's `zone.snapshot()` then throws `DurableIssuanceError: issuance retirement plan has no lineage`, from
    packages/issuance-store `issuanceRetirementImage`, called by the browser issuance store.
  - The migration target also signs settlement now, because `rehearseMigration` builds it with the same
    `createCreatorInviteMaterial`.

Both are existing tests that this track may not edit, and the cause is in library behaviour under the settlement
profile.

## 4. Node proof (SQLite): the shipped zone API, base vs HEAD

The test is tests/grid-long-room-issuance-retention-native.test.ts (5b55b6e9).

- **Setup.**
  - It drives the real `createV3ZoneApi` for a creator and one Writer recipient. Each has a real Keychain, its own
    SQLite room storage (`createNodeV3RoomStorageHost`) and its own account floor (`createNodeRoomHeadAuthority`).
  - It wraps `createV3RoomSession` with `vi.mock` only to inject the host and to observe accepted vertices.
- **Each epoch.**
  - Each peer places 2 blocks, and each peer's published rows are delivered to the other in issue order.
  - The creator seals and adopts, and the Writer installs from the creator's export.
  - The test takes a census of the native issuance and outbox rows.
- **At the end.** Both peers stop, reopen from disk and play one more epoch.
- **Assertions, from the first steady epoch.**
  - Issued and outbox rows stay constant, and nothing is pending.
  - No kept row is older than the window.
  - Per-move native work (issued point reads, outbox page scan rows) is not above the first steady epoch's.
  - `next` rises by moves plus the fences `settlementProfileFor` reports.
  - After the reopen, the kept rows equal the reopened rows.
- **Result.** 3/3 at HEAD (logs/grid-long-head-1.log and grid-long-head-2.log, about 100 s).

Measurement is ABBA (base, HEAD, HEAD, base): logs/grid-long-abba1-\*.log, loads 47-120, summarised by
bin/summarize-grid.mjs. Columns per peer are issued / outbox / logical bytes / `next`.

| Epoch            | HEAD creator   | HEAD Writer    | Base creator   | Base Writer    |
| ---------------- | -------------- | -------------- | -------------- | -------------- |
| 1                | 5/5/5370/5     | 5/5/5329/5     | 3/3/3284/3     | 3/3/3243/3     |
| 6                | 13/13/12785/20 | 13/13/13049/20 | 13/13/12804/13 | 13/13/12763/13 |
| 8                | 13/13/12791/26 | 13/13/13055/26 | 17/17/16612/17 | 17/17/16572/17 |
| 16               | 13/13/12798/50 | 13/13/13062/50 | 33/33/31860/33 | 33/33/31820/33 |
| 17, after reopen | 13/13/12795/53 | 13/13/13059/53 | reopen fails   | reopen fails   |

- **Rows.**
  - HEAD holds 13 issued rows per peer from epoch 6. Its oldest kept epoch is the current epoch minus 4.
  - Base grows by 2 rows and about 1.9 KB per epoch per peer.
- **Per-move work** (issued point reads / outbox scan rows).
  - HEAD stays at 4/30 from epoch 7.
  - Base rises by 4 scan rows per epoch, to 4/66 at epoch 16.
- **Disk.**
  - HEAD creator DB files grow 128 to 436 KiB, stepwise; the Writer's grow 108 to 208 KiB.
  - The WAL grows about 1.1 MB (creator) and 1 MB (Writer) per epoch until a checkpoint. The reopen truncates it to
    1.8 MB and 1.0 MB.
- **Latency.** Seal, adoption and install in ms per epoch, from epoch 8.

  | Side | Seal (ms) | Adoption (ms) | Install (ms) |
  | ---- | --------- | ------------- | ------------ |
  | HEAD | 1750-2230 | 320-400       | 900-1210     |
  | Base | 1740-3110 | 230-460       | 970-1560     |

- **Slopes from epoch 8** (ms per epoch, first and second run).

  | Side | Seal          | Adoption     | Install       |
  | ---- | ------------- | ------------ | ------------- |
  | HEAD | -7.6 / +11.9  | +1.3 / +5.9  | -17.6 / -10.6 |
  | Base | -34.2 / -74.2 | -10.5 / +2.3 | +26.2 / -37.0 |

  - Creator issue latency: median 55-115 ms at HEAD, flat, with slopes -1.4 and -1.2. Writer issue latency: 11-19 ms.
  - At this load the slopes are noise around zero on both sides.
  - Seal steps from about 0.2 s to about 2 s at epoch 5 on both profiles.

- **Reopen.** Creator 299 and 464 ms at HEAD.

## 5. Pre-existing defects found (not caused by Track V)

### 5.1 Legacy: the creator cannot reopen after any rollover

On base, the creator's reopen fails at every epoch count tested: 2, 4, 6, 8, 10, 12 and 16. The failure is
`v3 room successor reopen failed: recovery-rejected: creator predecessor recovery failed: admission-rejected: v3
recovery vertex is not authenticated` (logs/grid-reopen-base-e\*.log). At epoch 1 the error is a different one, an
outbox classification error.

- **Cause.** `join()` in examples/grid/src/v3-zone.ts:1160-1166 opens every joiner, including the creator reopening
  its own zone, with the bootstrap roster `[{author: local, order: 1}]`. The genesis `installRoster` has the creator at
  order 0. Legacy keeps the creator's epoch-0 bootstrap row forever, so recovery cannot authenticate it.
- **Confirmed by a probe.** With the creator's first application reused (<evidence>/track-v/trash/), the base reopen
  at epoch 6 passes.
- **HEAD.** On settlement the own-row classification skips retired rows, so the HEAD creator reopens at epochs 1, 3, 4,
  5, 6 and 16. The app bug remains for legacy zones.

### 5.2 Both profiles: a Node-host Writer reopen right after epoch 2 fails

The error is `unable to open database file`, in `openNodeSealVoteStore`, via
`recipientRecoveryContext` and then `ownCreatorSigningStores`.

- It happens on HEAD, and on base with the creator fix.
- It appears to be specific to the Node host. I did not investigate it.

## 6. Bench vs shipped Grid, and other checks

### 6.1 The bench does not match the shipped Grid

The bench composition differs from the shipped Grid in five ways:

- Its parameters lack `authorShareMultiplier: 4`.
- It has no `createOperationAdmissionPolicy`. The shipped Grid uses outcome-commit admission.
- It uses a 64-member corpus roster.
- It runs lulls through `role.session`. The shipped zone API has none.
- The shipped zone also opens an ephemeral plane on open and on each projection.

So Track M/M2's Chromium Grid evidence speaks for the settlement Grid application in the bench's composition, not for
the shipped page with its own networking. Section 3 shows the difference matters.

### 6.2 Other checks

- **Shipped Grid page.** The new Chromium harness is the shipped-composition evidence (section 3).
- **Shipped Playwright specs and test sets.** Base vs HEAD results are in section 6.3 and logs/rest.log.
- **v3-chat.** Its source is unchanged, so its specs are identical at base and HEAD. I did not rerun them.
- **Typecheck.** `pnpm -r typecheck` (logs/typecheck-head.log): 0 errors, 46 packages.
- **Shadowed sources.** `node scripts/check-shadowed-sources.mjs`: clean.

### 6.3 Results base vs HEAD

Vitest runs from the repository root with `--exclude ".claude/**" --no-coverage`. Reports are in
<evidence>/track-v/tests/<side>-<set>.json and the comparison script is bin/vcompare.py.

| Set                                                                                 | Base                         | HEAD                            | New failures at HEAD |
| ----------------------------------------------------------------------------------- | ---------------------------- | ------------------------------- | -------------------- |
| grid: examples/grid/src (4 files) and the e4-01 and e4-03 ephemeral REDs            | 65/65                        | 65/65                           | 0                    |
| pins: phase-3 exit RED (base content at base, amended at HEAD)                      | 9/9                          | 9/9                             | 0                    |
| pins: phase-6a product RED                                                          | 9 pass, 4 fail               | 9 pass, 4 fail                  | 0                    |
| gridrefs: the 20 vitest files that import or read examples/grid (MAP refs-grid.txt) | 150 pass, 33 fail, 4 skipped | identical                       | 0                    |
| new: tests/grid-long-room-issuance-retention-native.test.ts                         | -                            | 3 pass, 1 skipped (measurement) | -                    |

- The 33 base failures are the same tests at both sides. They are pre-existing REDs in nine files, among them
  phase-3g-v3-room-rebase-red with 18 and phase-6b-grid-successor-state-red with 4.
- packages/network-spike/tests/public-convergence-live.test.ts does not load on either side: it cannot resolve
  `@ts-drp/object`.

Playwright (Chromium), base vs HEAD:

| Spec                                                   | Base                          | HEAD                          |
| ------------------------------------------------------ | ----------------------------- | ----------------------------- |
| tests/phase-3a1b-d9346-v3-zone.pw.ts                   | 2/2, 2/2                      | 0/2, 0/2 (section 3.7)        |
| tests/e4-02-targeted-aoi.pw.ts                         | 1/1                           | 1/1                           |
| tests/track-v-grid-long-room.pw.ts (new)               | 16/16 epochs                  | stalls at epoch 5 (section 3) |
| tests/phase-3a1b-d9336-two-client-room.pw.ts (v3-chat) | not run: v3-chat is unchanged | not run                       |

**Startup-discovery "shipped grid/chat public genesis omission".** Not run. The bundle build
(tests/fixtures/startup-discovery/build.ts) fails on both sides in this worktree, before any test. The cause is
`Could not resolve "@ts-drp/blueprints/v3-canvas"` at tests/fixtures/startup-discovery/shipped.ts:2: the root package
does not link @ts-drp/blueprints (logs/startup-build-{base,head}.log).

## 7. What remains, and risks

- **The live-delivery stall (section 3).** It must be fixed in the library, or the Grid switch must wait. The
  candidates:
  - The retained-history repair after install.
  - The Writer's ingress queue after a retiring install.
  - The relayed direct stream.
- **Shipped settlement apps in a real browser.** Chat and Canvas also sign settlement. Their creator also publishes a
  fence at adoption, before a Writer has installed. A real-network multi-successor Chromium test for them would show
  whether they share the stall.
- **Ordinary placement and migration on settlement (section 3.7).** The d9346 failures need a decision:
  - The extra boundary-preparation work during an ordinary placement may be a lawful settlement cost. If so, the
    d9346 assertion needs an owner-approved change.
  - The migrated joiner's `no lineage` refusal looks like a defect.
- **Legacy Grid zones** (every zone created before this switch) keep growing by 2 rows per Writer per epoch, and their
  creator cannot reopen after a rollover (section 5.1).
- **Not run because of the stop:**
  - The full step-7 suites (packages/node, storage-node retirement, 117 root files, observation, native6).
  - The step-5 100-epoch run, which was not applicable anyway because v3-chat did not switch.
- **E5-02.** Its RED test expects `aclVersion` 2; a settlement zone carries ACL 3. That is a note for whoever takes E5-02.

## Commits

| Commit   | What                                                                                           |
| -------- | ---------------------------------------------------------------------------------------------- |
| d5a0015f | test: amend the shipped Grid genesis pin to the settlement profile (owner approved 2026-10-20) |
| 15bf2ed1 | Grid: sign creator-trusted-settlement-v1 into new zones                                        |
| 5b55b6e9 | test: prove the shipped Grid zone keeps issuance flat over 16 creator successors               |
| 27fe2688 | docs(grid-memory): say the Grid invite builder now signs the settlement profile                |
| d7e9833f | test: measure the shipped Grid page as a long zone in Chromium                                 |
| (this)   | docs: record the Track V result                                                                |

**Merge advice.**

- Merge d7e9833f and this record.
- Hold d5a0015f, 15bf2ed1, 5b55b6e9 and 27fe2688 until the stall in section 3 and the d9346 failures in section 3.7
  are resolved. The pin amendment fails without the switch, the Node test asserts the settlement profile, and the
  doc says the switch happened.
