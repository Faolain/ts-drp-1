# Track V map (step 1)

Base 19caa468. Every tracked test or fixture that reads `examples/grid` or `examples/v3-chat`
as source text, imports them, or builds their shipped composition, classified against the
approval ("change only the profile name and the ACL version in the listed pins").

Lists: refs-grid.txt (51 files), refs-v3chat.txt (33 files), per-file hit lines in refs-lines.txt.

## Decision per app

| App | Decision | Why |
| --- | --- | --- |
| Grid (`examples/grid/src/v3-zone.ts` `createCreatorInviteMaterial`, ACL `version: 1` at 1879, `profileId` at 1885) | **Switch** | Only pin is `tests/phase-3-exit-genesis-roots-red.test.ts`; it needs the zone ACL version and the profile identifier. See the one structural note below. |
| v3-chat (`examples/v3-chat/src/index.ts` `createCreatorAuthorityMaterial`, ACL `version: 1` at 489, `profileId` at 496) | **Left on `creator-trusted-v1`** | The phase-6a oracle `isD110cBSuccessorAuthority` is asserted both on the v3-chat product and on a legacy direct room in the same test. No literal change satisfies both. |

## Covered literals (amended in the pin commit)

`tests/phase-3-exit-genesis-roots-red.test.ts`, test "routes both real product creator paths through the shared builder":

1. Zone expected latched ACL (inline `encodeCanonical`, line 644): `version: 1` -> `version: 3`.
2. Profile identifier asserted by `expectProductInput` (line 274): `"creator-trusted-v1"` -> `"creator-trusted-settlement-v1"` **for the zone call only**.

Not touched in that file: `baseInput` (line 155, generic builder tests, not a product pin),
`expectedChatAcl` `version: 1` (line 247, v3-chat stays legacy), the stand-alone ACL at line 191
(generic builder test).

### Structural note (flagged, beyond a literal swap)

`expectProductInput` is shared by the chat call (line 607) and the zone call (line 630) and
hard-codes the profile identifier. With v3-chat staying legacy, the Grid profile cannot change
by editing that one literal. The amendment moves the literal to the two call sites:
`expected.profileId` is added to the helper's `expected` record; the chat call passes
`"creator-trusted-v1"` (byte-identical assertion to base) and the zone call passes
`"creator-trusted-settlement-v1"`. Both are exact equality on the full canonical profile bytes,
nothing is loosened, and the values are independent literals (not imported from the app). If
both apps had switched, this would have been a single literal swap. This is reported for the
coordinator to accept or revert (it is its own commit).

## Not covered: v3-chat (blocks the v3-chat switch)

`tests/fixtures/phase-6a-v3/creator-successor-product-contract.ts`
- `isD108d2Authority` (722-744) and `isD110cBSuccessorAuthority` (752-775) both require
  `record.profileId === "creator-trusted-v1"`.

`packages/storage-browser/tests/phase-6a-creator-successor-product.pw.ts`, test
"D.110c-b advances one genuine room through hot epoch 0 to 1 to 2 and rebinds epoch 2 close custody":
- 2516, 2518-2527, 2540, 2555-2564 apply `isD110cBSuccessorAuthority` to the **v3-chat product**
  authority (and `rawAuthorityAtEpoch`, entry 730-801, hard-coded `profileId: "creator-trusted-v1"` at 796).
- **2595 applies the same oracle to a direct room**: `openDirectCreator(closeBindFailureName)` ->
  entry `createDirectRoom(name)` with default options, which signs the legacy profile
  (entry 1345 `version: options.nativeGrid === true ? 3 : 1`, entry 1350
  `profileId: options.nativeGrid === true ? "creator-trusted-settlement-v1" : "creator-trusted-v1"`).

So with v3-chat on settlement, the contract literal at 773 must be the settlement id for 2516-2564
and the legacy id for 2595. Ways out, none covered:

- A. Parameterise the oracle (predicate structure change, and the call sites change):
  ```diff
  -export function isD110cBSuccessorAuthority(value: unknown, expectedEpoch: number): boolean {
  +export function isD110cBSuccessorAuthority(value: unknown, expectedEpoch: number, expectedProfileId: string): boolean {
  ...
  -		record.profileId === "creator-trusted-v1"
  +		record.profileId === expectedProfileId
  ```
  plus every call in the pw spec (2516, 2518, 2540, 2555 with the settlement id; 2595 with the legacy id)
  and the pw spec's local type at 39/50. `tests/fixtures/phase-6b-d110c-b/source-shape.mjs:112-115`
  only checks `contract.includes("export function isD110cBSuccessorAuthority(")` and the key checks, so it would still match.
- B. Move the entry's direct chat rooms to settlement too (entry 1345 -> `3`, entry 1350 -> settlement,
  pw 2901 `profileId: "creator-trusted-v1"` -> settlement): changes the composition of every
  direct-room test in that spec (D.108e3, D.108e5, D.110c-0c matrix, D.110c-b close-bind) -
  "any other test", and lines outside the listed ranges.
- C. Accept either profile in the oracle: a loosening, forbidden.

Context: at base this pw spec fails before any test, in its esbuild plugin
`d108e2b-lifetime-instrumentation` (`D110C_0C1_INSTRUMENTATION_SEAM_INVALID: if (!recovered.ok) return rejected("recovery-rejected", ...)`,
source seam drift; log logs/p6a-d110cb-base.log), so no run would show the contradiction today,
but an amendment would encode it. The node-side v3-chat pins (phase-6a red 142-156,
`isD108d2Authority` and entry `rawAuthorityAtEpoch`) are covered and would not block alone.

## Unaffected (no change, and no behaviour depends on the creator profile)

Source-text readers / structure checks of the Grid or v3-chat source:
- packages/ephemeral/tests/aoi-delta-e4-01-red.test.ts, aoi-projection-e4-03-red.test.ts (ZONE_PATH markers)
- packages/node/tests/creator-ordinary-neutral-resource.test.ts:253-263 (`createV3ZoneApplication` statements, catalog JSON)
- tests/e4-02-targeted-aoi.pw.ts:9 (ZONE_SOURCE slice of `publishAoiPopulation`)
- tests/fixtures/phase-6b-d110c-0c1k/w0-contract.ts:245 (`authorShareMultiplier: 4` regex, still present)
- tests/phase-6b-d110c-0c1f5b0v-callback-contract.test.ts:94-95 (`onAcceptedVertex` inventory)
- tests/phase-3a1b-p3-live-transport-red.test.ts (topic census over examples/*/src)
- tests/phase-3a1b-d9346-shared-v3-room-red.test.ts, phase-3a1b-d9346-v3-room-extraction-red.test.ts (module graph)
- tests/fixtures/phase-5e-v3/creator-live-close-contract.ts, phase-6a-v3/creator-adoption-commit-contract.ts,
  creator-adoption-contract.ts:1637, creator-successor-activation-contract.ts, creator-successor-handle-identity-contract.ts,
  creator-successor-product-contract.ts:505 (v3-chat markers), tests/phase-5e-creator-live-close-red.test.ts,
  tests/phase-6a-creator-successor-local-author-red.test.ts:284 (v3-chat source markers; v3-chat unchanged anyway)
- tests/grid-public-infra-profile.test.ts (package.json / demo serve)
- packages/protocol-v3/scripts/check-protocol-v3-freeze.mjs (workspace list; frozen digests do not cover examples or pins)
- tests/fixtures/grid-room-workload.ts:973-998 (protocol-v3 source strings)
- registry / lifecycle JSON (tests/fixtures/phase-6b-d110c-registry-current/current-registry-contract.json,
  tests/fixtures/phase-n1prime-e4/root-test-lifecycle-contract.json): path references only

Import the application only (own invite, own profile; not the shipped genesis):
- tests/grid-memory-runtime-owners/startup-barrier/terminal-readiness.test.ts, tests/fixtures/grid-transition-workload.ts,
  tests/fixtures/track-m/settlement-room.ts, tests/fixtures/track-s/first-lull-reopen.ts,
  tests/recipient-long-room-issuance-retention-native.test.ts, tests/phase-6b-grid-successor-state-red.test.ts,
  tests/r9-grid-outcome-transfer-native.test.ts (its `shippedProfile` flag builds its own legacy invite;
  the name now describes the pre-Track-V shipped Grid; left unedited, it is an existing test and still covers legacy Grid rooms),
  tests/phase-3f-c, 3g-chat-zone, 3g-v3-room, 3h-chat-zone, 3h-v3-room red tests, tests/fixtures/phase-3g/rebase-outbox-fixture.ts,
  tests/fixtures/phase-4c-v3/browser-live-snapshot.ts, tests/fixtures/phase-6b-d110c-0c1f5b/transient-payload-application.ts,
  tests/phase-6b-d110c-0c1f5b0u-*.test.ts, tests/fixtures/startup-discovery/room.ts, packages/storage-browser/tests/fixtures/product-browser-server.ts,
  tests/fixtures/phase-3a1b/grid-room-head-authority.ts (types only)
- tests/fixtures/startup-discovery/healthy-grid.ts (bench): own invite (see bench note below)

Shipped composition through a mocked room (genesis bytes not asserted):
- tests/phase-3f-b-chat-zone-causal-join-red.test.ts (createV3ZoneApi with mocked createV3RoomSession; asserts application, not genesis)
- tests/r9-grid-configured-creator.test.ts, examples/grid/src/transient-presentation-owner.test.ts (vi.mock rooms)

Shipped composition, real room, behaviour only (run base vs HEAD in step 7):
- tests/fixtures/startup-discovery/shipped.ts `startupShippedGrid` + browser-red.pw.ts "shipped grid" case (asserts blocks, floor-read order, transport open/close; no profile)
- Grid Playwright configs serving the shipped app: phase-3a1b-d9346-zone, e4-02, e4-03, e4-04, e3-03, e5-00, e5-01, e5-02, d9349 peer selector, examples/grid modular/public-infra/fully-public
- tests/e5-02-zone-referee-outcome.pw.ts is RED at base (zone has no `setRefereeRole`; it expects `aclVersion === 2` later). Future-design note: a settlement zone is ACL v3, so whoever greens E5-02 must expect 3, not 2.
- v3-chat: tests/phase-3a1b-d9336-two-client-room.pw.ts (unchanged app)

## Bench vs shipped Grid

`tests/fixtures/startup-discovery/healthy-grid.ts` (Tracks M/M2 evidence) does not match the shipped Grid apart from harness wiring:
- parameters carrier: bench uses room.ts `parameters` without `authorShareMultiplier`; shipped zone signs `authorShareMultiplier: 4` (different signed genesis parameters, 4x author share).
- admission: bench passes no `createOperationAdmissionPolicy`; shipped zone passes the outcome-commit admission policy.
- roster: bench signs a 64-member corpus roster; shipped zone signs the creator + enrolled members.
- lull: bench runs `maintainRecoveryPool` through `role.session`; shipped `V3ZoneApi` exposes no lull, so the shipped Grid never runs one.
- room open: shipped zone also opens the ephemeral plane and the presentation projection on every open.
So the Track M/M2 Chromium numbers are evidence for the settlement Grid application, not for the shipped Grid composition.

## Step 4 outcome: Grid stopped at the browser proof (added 2026-10-20 22:05)

The Grid switch keeps storage flat on Node (SQLite), but in Chromium on the shipped page with
real networking the creator's blocks stop reaching the Writer after the fourth successor
(HEAD: 4/4 runs stop at epoch 5, one 5 s post-install pause run stops at epoch 4; base: 16/16
and 8/8 pass). Per the hard rule the Grid track stops here with the counterexample; see
RESULT.md section 3 and PROGRESS.md. The switch commits stay on the branch for a later fix.
