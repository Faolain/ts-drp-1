# Track W map: what pins shipped Chat's state, budget and allocation rules

Base: codex/phase3a1b-p6-golden-path @ 6066c539 (worktree branch `track-w-chat-rolling-window`).

Classes: **(i)** unaffected; **(ii)** a RED, governance or contract test, frozen artifact, registry, model or
vector that pins the current (v3, lifetime-share) design; **(iii)** code to change.

## Key fact that shapes the map

The shared Chat state is produced by the **compiled blueprint reducer** (examples/chat/capacity-blueprint/blueprint.ts,
artifact `v3-shipping-chat.v3`, blueprint digest `61ab694a…065f`), which the library folds at seal
(packages/compaction/src/blueprint-fold.ts `BlueprintStateMachine`, state ceiling 32,768 B at line 24). The room
then checks `canonicalStateBytes(project(base, []))` equals the sealed state (packages/node/src/v3-room.ts:3206-3219).
So a window rule cannot live only in the app's projection or admission: it must be in the reducer, which means a
new compiled artifact with a new blueprint digest. Each room's genesis signs its blueprint digest, so a room's
format is fixed by its signed genesis.

The design (DESIGN.md) therefore **adds** a version-4 format with its own blueprint and catalog and **keeps the
version-3 code, blueprint and catalog byte-identical** for rooms whose genesis signed v3. Every class (ii) item
below pins v3 and stays true of v3; none has to change. Nothing in class (ii) is edited.

## Product code

| Item | What it pins | Class | Under the design |
|---|---|---|---|
| examples/chat/src/v3-chat-capacity.ts | v3 format: `ShippingChatState.version: 3`, `SHIPPING_CHAT_RETAINED_BYTES` 32,768 (l.6), `allocations` rows, lifetime charge `shippingChatMessageCharges`, `createShippingChatGenesisStateBytes` (equal split among the genesis roster, l.184-214), `reallocateShippingChatCapacity` (l.222-295), `createShippingChatCapacityAdmissionPolicy` (lifetime charge over base+epoch, l.303-546) | (i) kept | Unchanged; serves v3 rooms. Track Q exports `LIMITS` from here; I do not touch the file. |
| examples/chat/capacity-blueprint/{blueprint.ts,blueprint.json} | v3 reducer: messages sorted by identity, never removed | (i) kept | Unchanged (its bytes define the v3 digest). |
| examples/chat/src/chat-catalog-material.json | the shipped v3 catalog (one entry) | (i) kept | Byte-identical, so `SHIPPING_CHAT_CATALOG_DIR` materialised from it still holds exactly the v3 blueprint. |
| examples/chat/blueprint/ | older `v3-shipping-chat.v2` authoring source (no capacity) | (i) | Untouched. |
| examples/chat/src/v3-chat-message.ts | operation capture; `SHIPPING_CHAT_STATE_LIMITS` 32,768 per message | (i) | Unchanged; v4 additionally requires a message to fit its author's share. |
| examples/chat/src/v3-chat-application.ts | `createShippingV3ChatApplication` accepts only artifact `v3-shipping-chat.v3` (l.57) and wires the v3 owners | (iii) | Small edit: choose the format owner by the resolved artifact id (v3 or v4). Track Q edits this function too; my edit is one format selection plus call-site substitutions. |
| examples/chat/src/index.ts | requires exactly one blueprint in the catalog (l.67-69); creates v3 genesis (l.224); renders `projection.messages` | (iii) | Create new rooms with the v4 catalog; resolve a joined invite's digest in either catalog; wire the local archive; render window + archive. |
| New: examples/chat/window-blueprint/, src/chat-window-catalog-material.json, src/v3-chat-window.ts, src/v3-chat-archive.ts, src/v3-chat-archive-sqlite.ts | v4 reducer, catalog, state/genesis/admission owner, archive and its stores | (iii) new | See DESIGN.md. |

## Tests and harnesses

| Item | What it pins | Class | Under the design |
|---|---|---|---|
| tests/r9-chat-capacity-ledger.test.ts | v3 unit contract: exact per-author ceiling, joined reservations, **"rollover carries full messages and ceilings without refreshing credit"** (l.133-143: after a rollover an author whose lifetime share is used is refused), release only on a newer authenticated incarnation | (ii) | Unchanged and still true: it calls the v3 functions directly. v4 behaviour gets its own tests. |
| tests/r9-chat-capacity-room-native.test.ts | v3 in native rooms, e.g. "native Chat lifetime entitlement refuses exact+1 bytes … survives rollover/reopen" (l.847), "dormant entitlement … never refreshes" (l.938); requires `SHIPPING_CHAT_CATALOG_DIR` with exactly one blueprint (l.74-79) | (ii) | Unchanged; run with the v3 catalog it exercises the unchanged v3 path. 15/4 at base per Tracks M and P. |
| tests/r9-chat-shipping-room-native.test.ts, r9-chat-role-network-native.test.ts, r9-creator-selection-room-native.test.ts | shipped Chat sender/time/retry, roles, creator selection on the v3 catalog (each requires exactly one blueprint) | (ii) | Unchanged (v3 path). Base: 0/5, 2/0, and as recorded. |
| tests/r11-disposable-session-native.test.ts, tests/fixtures/r11-disposable-session-child.ts | R11 disposable session with v3 Chat (`createShippingChatGenesisStateBytes`, one-blueprint catalog) | (ii) | Unchanged (v3 path). |
| tests/r9-chat-metadata-native.test.ts | an older API (`createShippingChatAdmissionPolicy`, `shippingChatCanonicalStateBytes`, `restoreShippingChatState`) that no longer exists | (ii) | Unchanged; 6 of 8 fail at base on the missing exports. I add none of them. |
| tests/r9-chat-artifact-contract.test.ts | the older v2 artifact (`SHIPPING_CHAT_BUNDLE_DIR`, state = array), imports missing exports | (ii) | Unchanged; fails at base. |
| examples/chat/e2e/chat.pw.ts (+ playwright.canvas-chat.config.ts) | the shipped UI: create, observer join, one message with metadata, recipient reload, exact message list | (i) | Not edited; must keep passing on v4 (archive merged by identity, no duplicate rows). |
| tests/fixtures/track-m-apps/{long-room-core.ts,long-room-driver.ts,app-long-room.ts,browser/*}, tests/track-m-chat-long-room.test.ts, tests/track-m-apps-creator-issue-profile.test.ts | measurement-only harness (Track M); Chat uses the embedded catalog's `blueprintDigests[0]` and the v3 genesis | (iii) measurement | Select the shipped format explicitly (default: the new v4 window, `TRACK_M_APPS_CHAT_FORMAT=lifetime` keeps v3 for comparisons); add archive size and append-cost measurement. Asserts nothing new. |
| tests/canvas-long-room-issuance-retention-native.test.ts | Track P's Canvas test | (i) | Pattern only. |
| tests/protocol-v3-current-registry-contract-d110c-red.test.ts, tests/fixtures/phase-6b-d110c-registry-current/current-registry-contract.json, tests/fixtures/phase-n1prime-e4/root-test-lifecycle-contract.json, packages/protocol-v3/scripts/check-protocol-v3-freeze.mjs | pin the vitest workspace list including `./examples/chat/vite.config.mts` | (ii) | Unaffected: I do not touch vitest.workspace.ts or examples/chat/vite.config.mts. |
| Every tests/phase-* file that says "chat" (3-exit-genesis-roots, 3a1b-d9346, 3f-b, 3f-c, 3g, 3h, 5e, 6a-*, 6b-d110c-0c1f5b0u/v) and tests/fixtures/startup-discovery/* | the **v3-chat demo** (examples/v3-chat), not shipped Chat | (i) | Not touched (Track V owns the demo; Track U owns startup-discovery). |

## Frozen artifacts, registries, models, evidence

| Item | What it pins | Class | Under the design |
|---|---|---|---|
| packages/protocol-v3/formal/author-lineage-actions.qnt, module `carriedChatCapacity` (l.1214-1320); sha256 pinned in packages/protocol-v3/conformance/freeze-policy-v3.json:35, current-registry-contract.json:3261, specs/current-registry-governance/inventory.json | the v3 lifetime ledger: `committed == protectedMessages` (committed messages are never removed), `ceilingsAndClaimsCarried` across rollover, release only on a newer settled incarnation; an intentional "refresh" mutation is the negative control | (ii) frozen | Unchanged and still models v3. It does **not** model v4's window (eviction removes committed messages from the shared state). No model of v4 exists; listed as a gap, not a blocker (a v4 model would be a new file, not an edit of this frozen one). |
| .logs/bounded-storage-lifecycle/phase6-continuation-01/r8-native-main-integration01/receipt.json, `r9ChatCarriedAdmissionAndShippingUi20261011` (l.4453) and `currentNativeCapacityClosure` (l.4557) | historical evidence: requirement "D.110c-0c1f5b0y deterministic complete retained-byte admission, no rollover refresh"; "initially authenticated enrolled members hold deterministic dormant lifetime shares"; `sourcePins` sha256 of the Chat files | (ii) frozen | Unchanged; no test reads it. Its pins of chat-catalog-material.json and capacity-blueprint stay byte-true; its pin of v3-chat-application.ts (45d919…, matches at base) will no longer match after my edit, as earlier tracks' edits already did for v3-live.ts. The accepted v3 scope is untouched. |
| other tracked .logs/d110c-* files naming ShippingChat | historical program identities/custody | (i) | No test reads them. |
| packages/compaction/src/blueprint-fold.ts:24 `APPLICATION_LIMITS.maxBytes: 32_768` | the library's application-state ceiling | (i) | Unchanged; v4 stays within it. |

## Specs and plans

| Item | Says | Class | Relation |
|---|---|---|---|
| specs/bounded-storage-lifecycle/README.md:170 golden-path row "Discord / persistent chat" | bounded: hot window, edit overlay, archive index working set, page cache, protocol overhead; "intentional archive growth is accounted separately; old messages … remain verifiable through paging" | (i) | The v4 window is the hot window. The device archive is accounted separately, but it is **local and not verifiable** (no paging, no proofs); verifiable paging stays Phase 7 / R12 (requirements-to-evidence.md R12, OPEN). |
| docs/production-hardening/production-hardening-tdd-plan-v2.md:105789 D.110c-0c1f5b0y | design checkpoint for deterministic chat admission (owner examples/v3-chat): exact byte limits, peer-independent overflow, no accepted text truncated or silently dropped, "pre-archive support boundary: hot v3 chat is supported only within its reviewed retained-state budgets; long history … remain Phase 7" | (i) | v4 keeps exact-byte admission and peer-independent results; eviction of sealed messages is a deterministic window rule, not truncation of accepted text; long verifiable history stays Phase 7. |
| plan Phase 7 (l.18242-18256) | 7a: "hot snapshot = recent window + edit/tombstone overlay + archive root; demand paging with inclusion proofs" | (i) | v4 delivers the "recent window" part only. |
| requirements-to-evidence.md R9 rows (l.371, 505-508) | R9 Chat capacity closed at recorded scope | (i) | That scope is v3; unchanged. |
| G1-G28 (specs/bounded-storage-lifecycle/golden-path-guarantees.md) | the bar | — | Argued in DESIGN.md. |

No spec slice defines Chat capacity: its record is the production plan's D.110c-0c1f5b0y checkpoint and the R9 receipt.
The design record for v4 is DESIGN.md and RESULT.md in docs/realtime-latency/tracks/33-track-w-chat-rolling-window/.

## Pins that block

**None.** No class (ii) item has to change, because v3 stays byte-identical for the rooms that signed it. The owner
should know three consequences of that choice:

1. The R9 Chat tests, the `carriedChatCapacity` model and the MAIN receipt describe **v3 rooms only** after this
   change; new rooms are v4 and are covered by Track W's new tests.
2. `SHIPPING_CHAT_CATALOG_DIR` keeps meaning "the v3 catalog" (materialised from chat-catalog-material.json, which
   is unchanged). The v4 catalog is a separate embedded material file.
3. The shipped app carries both catalogs, so existing v3 rooms stay openable; a v3 room still stops near its
   lifetime capacity, by design.

If the owner prefers that new rooms be the only supported format (dropping v3 from the shipped app), the R9 native
tests above would then need the v3 catalog supplied explicitly, which they already do through
`SHIPPING_CHAT_CATALOG_DIR`; no test text would change either way.
