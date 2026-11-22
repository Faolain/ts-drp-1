# Track T map: what pins or depends on the shipped apps' profile

Base: a3f3f6b0 (codex/phase3a1b-p6-golden-path). Written before any change.

Classes: (i) unaffected, builds its own composition or reads unrelated text; (ii) RED, governance or contract
test, frozen artifact, registry or vector that pins the shipped profile; (iii) code that must change.

## 0. What a switch means at the protocol level

- A profile is chosen only in the signed genesis: `exactCanonicalProfileBytes.profileId` of
  `createV3RoomCreatorInviteMaterial`.
- `creator-trusted-settlement-v1` also requires a **version-3 latched ACL**:
  packages/protocol-v3/src/latched-acl.ts:256, `(snapshot.version === 3) !== (settlementProfile === "v1")` ->
  `snapshot-mismatch`. So every switch changes two genesis literals: `profileId` and the ACL `version` (1 -> 3).
  Version 3 allows the `referee` group (GROUPS_V2) and 256 members (64 for v1). Nothing else in the invite changes.
- Existing rooms keep the profile signed in their genesis; only new rooms change (G25: no migration is implied).

## 1. Example sources (the switch points)

| file:line | today | class | note |
|---|---|---|---|
| examples/canvas/src/index.ts:162 (`creatorInvite`) | `creator-trusted-v1`, ACL `version: 1` (line 149) | iii | Browser-only entry (DOM). Nothing imports it. |
| examples/grid/src/v3-zone.ts:1885 (`createCreatorInviteMaterial`, reached by `createV3ZoneApi().create`) | `creator-trusted-v1`, ACL `version: 1` (1876) | iii, BLOCKED (section 4) | |
| examples/v3-chat/src/index.ts:496 (`createCreatorAuthorityMaterial`, reached by `globalThis.d9336V3Chat.create` and `rehearseMigration`) | `creator-trusted-v1`, ACL `version: 1` (487) | iii, BLOCKED (section 4) | |
| examples/chat/src/index.ts:237 | already `creator-trusted-settlement-v1`, ACL v3 | i | Reference composition. |

App-level requirements of the settlement profile, compared with examples/chat (settlement today):

- Canvas already forwards an optional `approveSettlementSourceSelection` (window global), as Chat does.
- Chat also passes `createOperationAdmissionPolicy` from its application; Canvas has none and the room does not
  require one (Track M's harness runs Canvas without it). To be confirmed by the acceptance run.
- Canvas's projection keeps only `paint`/`splash` rows (applications/canvas.ts `gameplayRows`), so author fences
  never reach its state.

## 2. Node and protocol types and runtime checks

| site | class | note |
|---|---|---|
| packages/protocol-v3/src/index.ts:35 `settlementProfileFor` | i | Maps the settlement id to "v1", everything else to "none". |
| packages/protocol-v3/src/latched-acl.ts:256 | i | ACL v3 iff settlement (above). |
| packages/node/src/v3-room.ts:336 `V3RoomSuccessorAuthority.profileId: "creator-trusted-v1"` | i (type only) | Runtime (770-786) already returns either profile; examples/chat's `authority()` already returns settlement under this type. No example reads `authority().profileId` except v3-chat's `snapshot()` (typed pass-through). Widening is not required for any switch. |
| v3-room.ts:770, 7644; v3-live.ts:1836, 4374, 4772, 4907, 10563, 11093, 12451, 17999; creator-close.ts:850, 2578, 3487; CRD:11822-11932, 12472, 13548, 14362; protocol-v3 creator-close.ts:792, creator-checkpoint.ts:146; control-plane creator-trust-checkpoint-advance.ts:123 | i | Each accepts both profiles; the legacy literal selects the no-settlement branch (0 fences). |
| protocol-v3 registry-v1.json/schema, conformance vectors, protocol-v2 field registry, docs/protocol/amendments-v2.json | i | List `creator-trusted-v1` among allowed profiles. Not edited by any switch. |

## 3. Tests and fixtures

### Canvas

| item | class | note |
|---|---|---|
| tests/canvas-long-room-issuance-retention-native.test.ts (Track P) | acceptance | Builds its own invite; line 156 profile and line 147 ACL v1 are the "shipped" copy. Step 4 changes where they come from. |
| tests/fixtures/startup-discovery/shipped.ts `startupShippedCanvas` + browser-red.pw.ts:176 (`profileId: "creator-trusted-v1"`) | i (stale mirror) | Builds its own legacy invite labelled "shipped"; asserts legacy on its own room. Keeps passing unchanged. Not edited. |
| tests/fixtures/track-m-apps/long-room-core.ts:357-370, tests/track-m-canvas-long-room.test.ts:11 | i (measurement harness) | Own copy of the shipped profile, comment says "shipped". Needed for step 5 Chromium latency: base run keeps legacy; for HEAD the harness should read the shipped choice. |
| tests/r9-canvas-receive-only-native.test.ts, r9-rpc-v3-room-native, room-database-retirement-native, recipient-long-room-journal-retention-native, recipient-lull-reopen-close-native, tests/fixtures/track-m/* | i | Own compositions with `createV3CanvasApplication`; profile chosen by the test. |
| tests/v3-canvas-equivalence.test.ts | i | Imports examples/canvas/src/objects/pixel only. |
| examples/canvas/e2e/canvas.pw.ts (playwright.canvas-chat.config.ts) | i | Drives the real app (creator + receive-only joiner); asserts no profile. Should keep passing. |
| packages/node/src/cli/v3-canvas.ts | i | Receive-only daemon; no profile. |

No RED, governance or contract test, frozen artifact, registry or vector reads the shipped Canvas profile.
**Canvas can switch.**

### Grid example

| item | class | note |
|---|---|---|
| **tests/phase-3-exit-genesis-roots-red.test.ts:535-660 "routes both real product creator paths through the shared builder"** | **ii** | Drives the real `createV3ZoneApi().create` and asserts the invite input's `exactCanonicalProfileBytes` equal `profileId: "creator-trusted-v1"` (`expectProductInput`, 271-278) and the ACL bytes equal `version: 1` (624-640). Passes at base (logs/map-phase3exit-base.log: 9/9). A switch makes it fail. |
| tests/r9-grid-outcome-transfer-native.test.ts:3511 "native Grid shipped none-settlement profile ..." | i (label) | Own invite (`shippedProfile ? "creator-trusted-v1"`, 556-561). Not edited; its "shipped" label would go stale on a switch. |
| tests/phase-3f-b-chat-zone-causal-join-red, examples/grid/src/transient-presentation-owner.test.ts, tests/r9-grid-configured-creator.test.ts, tests/phase-3a1b-d9346-v3-zone.pw.ts, startup-discovery `startupShippedGrid` (browser-red "shipped grid public genesis omission") | i | Drive the real create path with mocks or genuine owners; no profile assertion found. |
| packages/node/tests/creator-ordinary-neutral-resource.test.ts:252 | i | Reads only `createV3ZoneApplication`'s resource statements. |
| tests/fixtures/startup-discovery/healthy-grid.ts:365 (bench), tests/recipient-long-room-issuance-retention-native.test.ts (Track N), tests/fixtures/track-m/settlement-room.ts | i | Own invites; settlement by default. Prove the Grid application under settlement, not the shipped invite. |
| packages/ephemeral aoi tests, tests/e4-02-targeted-aoi.pw.ts, tests/fixtures/phase-6b-d110c-0c1k/w0-contract.ts:245, phase-6b-d110c-0c1f5b0v-callback-contract | i | Read unrelated v3-zone text. |

**Grid is blocked** by phase-3-exit-genesis-roots-red.

### v3-chat demo

| item | class | note |
|---|---|---|
| **tests/phase-3-exit-genesis-roots-red.test.ts** (same test) | **ii** | Drives `d9336V3Chat.create`; asserts profile `creator-trusted-v1` and `expectedChatAcl` with `version: 1` (206-248). |
| **tests/fixtures/phase-6a-v3/creator-successor-product-contract.ts:721-775 `isD108d2Authority`, `isD110cBSuccessorAuthority`** | **ii** | Require `record.profileId === "creator-trusted-v1"`. Applied to the v3-chat product's own authority in packages/storage-browser/tests/phase-6a-creator-successor-product.pw.ts:1097 and 2518-2560 (room created through `productApi().create` = `d9336V3Chat.create`). |
| **packages/storage-browser/tests/assets/phase-6a-creator-successor-product-entry.ts:730-801 `rawAuthorityAtEpoch`** | **ii** | Rebuilds the authority from raw IndexedDB with a hard-coded `profileId: "creator-trusted-v1"`; compared with the product authority (pw.ts:1098 `expect(after.authority).toEqual(carrier.authority)`). |
| packages/storage-browser/tests/phase-6a-creator-successor-product.pw.ts:2901 | ii (direct rooms) | Asserts legacy on the entry's direct rooms (own invite, entry:1350). |
| tests/phase-6a-creator-successor-product-red.test.ts:142-156 | ii (contract unit) | Unit-checks `isD108d2Authority` with a legacy authority. |
| phase-6a/phase-5e contract fixtures reading examples/v3-chat as text (creator-adoption-commit, creator-adoption, creator-successor-activation, creator-successor-handle-identity, creator-successor-product, creator-live-close) | i | Check markers unrelated to the profile. |
| tests/phase-3h-v3-room-rehearsal-red, phase-3g-v3-room-rebase-red, phase-6b-d110c-0c1f5b0u-successor-replay-red, phase-6b-d110c-0c1f5b0u-room-runtime-red, startup-discovery/room.ts, grid-room-workload.ts, phase-3g/rebase-outbox-fixture.ts, phase-4c-v3/browser-live-snapshot.ts | i | Import `createV3ChatApplication` and build their own invites. |
| tests/phase-3a1b-d9336-two-client-room.pw.ts, phase-5e creator-live-close entry, startup-discovery `startupShippedChat`/`startupShippedMigration` | i (behaviour) | Drive the demo's own create path; no profile assertion found, but they would run on a changed profile. |

**v3-chat is blocked** by phase-3-exit-genesis-roots-red and the phase-6a product contract.

## 4. Decision

| app | decision | blocking items |
|---|---|---|
| Canvas (examples/canvas) | switch to `creator-trusted-settlement-v1`, ACL v3 | none |
| Grid example (examples/grid/src/v3-zone.ts) | stays on `creator-trusted-v1` | tests/phase-3-exit-genesis-roots-red.test.ts (expectProductInput profile; zone ACL version 1) |
| v3-chat demo (examples/v3-chat) | stays on `creator-trusted-v1` | phase-3-exit-genesis-roots-red (profile; chat ACL version 1); creator-successor-product-contract.ts `isD108d2Authority`/`isD110cBSuccessorAuthority` via phase-6a-creator-successor-product.pw.ts; the entry's `rawAuthorityAtEpoch` literal |

## 5. Source of truth for Canvas

- examples/canvas/src/index.ts cannot be imported outside a browser page (DOM at module load).
- packages/node/src/applications/canvas.ts is Track Q's file.
- So: a new side-effect-free module, examples/canvas/src/profile.ts, exporting the shipped genesis profile
  (`profileId` and the ACL version it requires). index.ts and the tests import it.

## 6. Other observations

- Track P's (a) assertion `next === first.next + (epoch - first.epoch) * MOVES` counts only moves. Under settlement
  each Writer also issues one author fence per successor (Track N: 3 rows per epoch at 2 moves), so `next` would
  advance by MOVES + 1. To be confirmed by running; the assertion is not to be changed.
- The node API type v3-room.ts:336 already disagrees with runtime for examples/chat.
