**Recommendation**

No new v3-room, Node, or protocol API. The grid should compose the existing `V3RoomHeadAuthority` capability by injection: `createV3ZoneApi` gains one required third parameter, a per-open factory that the deployment (the "account") supplies, and the grid passes its result untouched into the room input at `examples/grid/src/v3-zone.ts:638`. The grid never chooses initialization kind, never persists floor state, and never defaults a provider. The browser entry supplies an explicitly labeled genesis-only in-memory model. The D.110c-d harness later supplies its own floor owner through the same seam, which is the only way this slice advances the golden path without pretending to be it.

The reason a factory, not an instance, is needed: `initialization` is a fixed readonly property of each authority (`examples/v3-room/src/index.ts:275-276`), the room reads it once at open (`index.ts:960`), and one zone API instance opens rooms sequentially with different lifecycles (`create()` at `v3-zone.ts:992`, `join()` at `v3-zone.ts:1058`).

**Exact boundary and files**

- `examples/grid/src/v3-zone.ts`: one exported factory type (proposal: input `{ objectId, operation: "create" | "join" }`, output `V3RoomHeadAuthority`, imported as a type from `@ts-drp/example-v3-room` alongside the existing imports at lines 3-13). `createV3ZoneApi(node, onProjection, roomHeadAuthorityFor)` throws synchronously if the third argument is not a function. `performOpen` calls the factory exactly once per open, after invite material exists and before `createV3RoomSession`, and adds `roomHeadAuthority` to the input object. Nothing else in the zone changes: migration target (`index.ts:3817`, opened with the skip flag at `index.ts:3823`), `activateMigration` (`v3-zone.ts:844`), and `createV3ZoneApplication` (`v3-zone.ts:1263`, including the base refusal at line 1291) are untouched.
- `examples/grid/src/index.ts:169`: pass a page-scoped model provider. In-memory map keyed by object id, `create` for an unseen id, `reopen` for an id already opened in this page, `migrate` never. Name and comment must state it is a composition model, genesis-only, not anti-rollback, following the chat disclosure rule at plan lines 94011-94012.
- Tests-only consumer move in the same batch: `tests/phase-3f-b-chat-zone-causal-join-red.test.ts:268` and `tests/phase-3-exit-genesis-roots-red.test.ts:537` currently call the two-argument form and would hit the new fail-closed check. They receive a probe factory. This is the "grid initialization" modernization already assigned at plan lines 97446-97449, done minimally.
- Unchanged: `CreateV3RoomSessionInput` (`index.ts:411` stays required), so `tests/phase-6b-d110c-0b0-floor-red.test.ts:59` and the key list in `tests/fixtures/phase-6a-v3/creator-successor-product-contract.ts:93` continue to hold.

**Trust, lifecycle, and fail-closed invariants**

- Grid-side shape check is mandatory, not optional. The room tolerates a malformed candidate by opening floorless when no signer or declaration is present (`index.ts:1649-1659`). Without a grid check, a bad factory result would silently reproduce today's runtime behavior while the diagnostic disappears. The grid must require an object with `initialization` plus the five methods before calling the room, and throw otherwise.
- `create()` requires the returned `initialization.kind === "create"` because the grid minted a fresh random object id (`v3-zone.ts:1010`); any other kind is a TypeError before any scope is created. `join()` accepts whatever the account returns; the room enforces semantics (`index.ts:955-980`, `1663-1679`).
- Ordinary reopen never creates a floor. The grid passes nothing derived from room storage, `inspectDurableHead`, or the AHE; the room supplies the genesis tuple from the invite's pinned anchor (`index.ts:1640-1644`), matching plan lines 93134-93153.
- Persistence and custody stay with the provider. The grid stores no floor, no seen-scope marker, and no pin. A same-origin marker would be rollbackable with the room bytes and is not a freshness source (plan 93017).
- Floor failures propagate as the room's typed codes; `performOpen`'s existing catch (`v3-zone.ts:707-711`) resets zone state, so a refused open leaves no half-open zone.
- The model provider cannot imply freshness because the grid room cannot advance: it passes no `creatorFinalitySigner`, and close binding requires one (`index.ts:2474`, `2513-2534`). This slice must not add that signer.
- No `transportPeerAuthors` or `authorForPeer` input becomes authenticated; the roster still comes only from the creator-signed join in the current epoch (`v3-zone.ts:1318-1325`).

**RED and GREEN**

One tests-only RED file. Cases, each failing today for a causal reason:

1. Two-argument `createV3ZoneApi` must throw; today it returns an API.
2. With a probe factory and the room entry mocked as in phase-3f-b, the input captured at the room boundary must carry the exact factory result by identity; today the third argument is ignored.
3. Factory returning `{ kind: "reopen" }` for `create()` must reject before the room is invoked; today nothing checks.
4. Factory returning a non-conforming object must reject at the grid; today the room would open floorless.
5. Real-room case reusing the harness pattern of `tests/phase-6b-d110c-0c1f5b0u-room-runtime-red.test.ts:214`: `join()` with `reopen` and an empty provider rejects with `D110C_FLOOR_MIGRATION_REQUIRED`; a provider that throws rejects with `D110C_FLOOR_UNAVAILABLE`; both leave the zone closed. Today both opens succeed.
6. Source guard in the style of the 0b0 test: `v3-zone.ts` contains no `initialization:` literal and no `begin`/`commit` implementation, and `index.ts` contains the model label.

GREEN evidence: the selected strict grid compiler reports zero diagnostics where it now reports "only the unchanged grid error" (plan 18524, 104271); the RED file passes; the two moved positional fixtures and the existing d9346 semantics suite still pass; the product-contract fixture's room-input key check is unchanged.

**Golden-path fit and explicit deferrals**

This gives D.110c-d and Phase 7 the one seam they need to hand the grid a real floor owner without editing the zone, and it removes the last grid composition item in the decision table at plan line 104271. It does not make the grid long-lived. Still open, by their existing owners:

- D.110c-0c1h successor projection carrier for `transportPeerAuthors` across a snapshot (plan 97537-97555); the base refusal at `v3-zone.ts:1291` remains a guard, not the capability.
- Grid close/adopt capability: signer, snapshot declaration, and zone-level seal/adopt surface. The grid has none today.
- Trusted freshness provider deployment and the participant bootstrap pin (plan 93039-93044, 93150-93153). The index.ts model is not that.
- Migration-target floor: the target opens with the skip flag and stays floorless, an existing room law shared with chat; a later `migrate` initialization through the same factory belongs with 0c1i.
- D.110c-c gaps, the D.110c-d workload freeze, registry governance, and the W0 fence stay separate.

**Alternatives rejected**

- `undefined as never` in the grid: the fixture cast the plan forbids (104271).
- Making `roomHeadAuthority` optional: downgrades the 0b0 mandate (93039-93040) and breaks the floor test assertion.
- Copying chat's provider into `v3-zone.ts`: the grid would choose `create` on every open, so reopen after reload creates a floor, and the harness could not inject its own owner.
- Copying the browser IndexedDB model provider: same-origin storage is explicitly not anti-rollback (93017) and is new storage infrastructure beyond this authorization.
- Library- or Node-selected provider, or a floor derived from the durable head: rejected at 93029 and 93125-93129.

**Decisions root must settle before implementation**

1. Confirm the example-level signature change to `createV3ZoneApi` and the same-batch tests-only move of the two positional consumers, rather than waiting for D.110c-d's fixture modernization. I recommend now, in one batch.
2. Confirm the index.ts demo provider is acceptable as a labeled genesis-only model with `reopen` for ids seen in the same page and `create` otherwise, versus refusing all joins after reload. I recommend the labeled model, since the grid cannot advance epochs under it.
3. Fix the factory input shape and names; I proposed `{ objectId, operation }` but did not verify naming against any repository convention beyond the room's own types.
