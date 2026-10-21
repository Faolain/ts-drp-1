# Track W design: Chat's rolling window and the device archive

Base 6066c539. Map: MAP.md (no class (ii) pin has to change). Numbers below come from the shipped v3 code
(probe: <evidence>/track-w/probes/shares-probe.mts).

Revised 2026-10-21 for the owner's review of the limits: the window is 64 KiB (65,536 bytes) per room, with
the same rules (equal split at creation, own-oldest eviction, at most one share per checkpoint, largest message
one share); the archive bound (2,000 messages or 1 MiB) is approved as proposed; late-joiner shares and
departed members' bytes go to a follow-up track. The window has its own budget constant and its own limits;
version-3 rooms keep 32,768 bytes and Track Q's approved limits. The window's ordinary resource bound is
re-derived (section 3a) and needs a fresh approval. Earlier text: trash/DESIGN-32kib-2026-10-21.md.

**STATUS 2026-10-21 12:30: the 64 KiB revision below is BLOCKED and reverted on the branch (ec14c306 on 24d4ca61; efa3c532 on af342318; a6906ef4 on 760607d9).
After the blocker the owner chose to SHIP THE 32 KiB WINDOW (2026-10-21); raising the library's room-state cap is
an open item with no track planned.** The
library caps a room's application state at 32,768 bytes (packages/node/src/v3-room.ts:877/880 for genesis and
every migration/successor base, which the creator installs at each adoption; :1657/:1680 for migration records of
at most 49,152 bytes; packages/outcome-commit/src/index.ts:707 for inherited state), pinned by RED tests
(tests/phase-3-exit-genesis-roots-red.test.ts:358-364; tests/phase-6a-creator-successor-product-red.test.ts:247;
tests/phase-3h-v3-room-rehearsal-red.test.ts:784). A 64 KiB room fails at epoch 58's adoption on Node and in
Chromium ("v3 room migration state is unbounded"). Section 2's claim that 64 KiB needs no library change was wrong:
it checked only v3-live's fold ceiling. The branch ships the 32 KiB design (trash/DESIGN-32kib-2026-10-21.md is
its text; the rules are the same). RESULT.md section 0 has the details and what a library track would need.

## 0. Summary

- New rooms use a **version-4 state format**, produced by a new compiled reducer (artifact `v3-shipping-chat.v4`,
  new authoring source examples/chat/window-blueprint/, new embedded catalog
  examples/chat/src/chat-window-catalog-material.json). Rooms whose genesis signed v3 keep v3, byte for byte.
- The shared state is a **rolling window**: each member's share (an equal split of the window's 64 KiB budget) now
  limits the bytes of that member's messages **in the window**, not over the room's lifetime. A member's new
  message pushes that member's own oldest messages out, deterministically, inside the reducer. Bytes pushed out are
  free for that member's next messages.
- Admission caps what a member may add **within one epoch** at the member's share, so nothing admitted in an epoch
  can be pushed out before that epoch is sealed.
- Each device keeps a **local archive** of the messages it has seen, in its own database outside room storage,
  bounded (2,000 messages or 1 MiB per room per device, oldest dropped first; approved), written after the
  projection callback in a later task, never read by the room.

## 1. State format (v4)

```
{ version: 4,
  messages: [ {author, clientOperationId, displayTimeMs, text}, ... ],   // window, oldest first
  capacity: { version: 1, basisObjectId, allocations: [[author, ceilingBytes, allocationEpoch], ...] } }
```

- `messages` is in **application order** (the order the reducer applied them), oldest first. Identities
  (author, clientOperationId) are unique. v3 sorted by identity; v4 needs the order to know which message is a
  member's oldest.
- `capacity` has the v3 record's shape; its genesis split and reallocation use the v3 rule over the window's own
  budget, `SHIPPING_CHAT_WINDOW_BYTES` = 65,536 (examples/chat/src/v3-chat-window.ts owns its copy of the rule,
  so the follow-up track can change the window's allocation without touching v3 rooms).
- Every author's charge (sum of `encodeCanonical(message).byteLength` over that author's messages in the window) is
  at most the author's ceiling; ceilings plus the empty-state overhead plus 2 bytes of array framing are at most
  65,536 (the v3 overbooking check over the window's budget). So the encoded state is at most 65,535 bytes
  (section 3a). The room's application ceiling
  is its negotiated maxSnapshotBytes (256 MiB in the shipped composition, packages/node/src/v3-live.ts:4478),
  with the library's generic 16,384 items and depth 16; the 32,768 default in
  packages/compaction/src/blueprint-fold.ts:24 applies only to standalone callers. No library change.
- The reducer's capacity check accepts a ceiling up to 65,536 (the only budget value in the compiled
  artifact); artifact digest 13827e6f68227ab1f8182c9023e3cd462f52407064b34ef02f50b438bd38db73.
- Charge is the exact canonical record size, 119 + w(L) + L + w(2t) + w(U) + U bytes for an id of L bytes, a
  display time t (w = 7-bit groups; 6 for current times) and U bytes of UTF-8 text. Examples: harness message
  `m-1-123-0` / `e123 o0` = 143 B; a shipped UI message (UUID id, 22-character text) = 185 B; 100 characters = 263 B.

## 2. The window rule and where it runs

The rule runs **in the reducer** (the compiled artifact). It cannot run only in the projection or in admission:
the library folds the reducer at seal and checks that the successor state equals the app's projection of the
base (packages/node/src/v3-room.ts:3178-3222), and the successor state is what every peer installs.

Message reducer, for a message m by author A (authenticated by the room, `executionContext.author`):

1. If m's identity is already in the window: identical content moves it to the newest position (a retry
   refreshes; no byte change); different content throws (the admission policy refuses it first, as `conflict`).
2. Otherwise A must have an allocation row and `size(m) <= ceiling(A)` (else throw; admission refuses first).
3. Append m; then, while `charge(A) > ceiling(A)`, remove A's oldest message in the window.

Capacity-allocation reducer (admin reallocation, v3 formula): replace `capacity` (basis immutable), then apply
step 3 to every author whose charge exceeds the new ceiling (an author with no row has ceiling 0). Admission only
accepts the allocation the v3 formula computes, which never lowers a ceiling below what the author holds, so this
is a totality rule, not a path that removes anything in practice.

Migration record: the inherited state must be v4 (same rule as v3: empty target prefix). A v3 state is refused, so
there is no v3-to-v4 migration (G25; the library has no users yet).

Properties:

- **Pure and deterministic**: the window after an epoch is a function of the authenticated base state and the
  epoch's operations in the library's projection order. Every peer that folds the same sealed transcript gets the
  same bytes and digest; reopen and crash recovery replay the same journal in the same order, so eviction is
  identical (G3, G14).
- **Per-author order only**: eviction depends only on the order of A's own messages, which A's single device
  issues causally; how other authors' operations interleave never changes which of A's messages leave.
- The reducer computes the canonical size in plain JavaScript (the lint forbids ambient globals, so no
  TextEncoder): UTF-8 length from UTF-16 code units, rejecting unpaired surrogates as the canonical codec does.
  A differential test checks it against `encodeCanonical` over ASCII, multi-byte, astral and boundary cases.
- Cost per message: one pass over the window (at most about 530 records, at most 64 KiB) to sum A's charge, plus
  the v3 `captureState` validation pass the v3 reducer already does. No sort (v3 sorted on every message).

## 3. Shares and released bytes

- Genesis: the v3 equal-split rule over 65,536 bytes among the members enrolled at genesis, after reserving
  maximum-width allocation rows (the same widths as at 32 KiB, so each share is the 32 KiB share plus an
  equal part of the extra 32,768 bytes). With the harnesses' 40-character object id: 65,340 B for 1 member,
  32,633 for 2, 21,731/21,730 for 3, 16,280/16,279 for 4, 8,103/8,102 for 8 (at 32 KiB: 32,572, 16,249,
  10,808, 8,088/8,087, 4,007/4,006). The shipped page's object id (peer id, colon, 32 hex; 85 characters)
  costs 45 bytes more overhead: 32,611/32,610 for 2 members.
- Messages per member at 64 KiB: about 176, 117, 87 or 43 typical UI messages (185 B) for 2, 3, 4 or 8 members
  (at 32 KiB: 87, 58, 43, 21); 228, 151, 113 or 56 of the harnesses' 143-byte messages.
- The ceiling now bounds what a member holds **in the window**. When the member's new message pushes old ones out,
  those bytes return to the same member's share at once (step 3). One member can never take another's bytes
  (fairness unchanged; only the lifetime aspect goes).
- A quiet member's older messages stay in the window until that member posts again; a busy member's window holds
  only their most recent messages that fit. "Most recent that fit" is per member.
- Reallocation keeps the v3 formula (released incarnation: ceiling becomes its current window charge; later
  Writers get a share of whatever is free). As in v3, a genesis roster that splits everything leaves nothing for
  Writers added later (flagged for the owner, unchanged behaviour).

## 4. Admission (`createShippingChatWindowAdmissionPolicy`)

One policy instance per epoch, seeded with the authenticated base window (or the closed postimage, or genesis), as
v3. For each message (or each entry of an applicationBatch):

- Identity already in the base window or reserved this epoch: identical content is an exact retry, different
  content is `conflict` (as v3).
- **Epoch charge**: the sum of sizes of A's distinct identities reserved in this epoch (pending or committed),
  counting exact retries of base messages too. Refuse with `{kind:"rejected", reason:"capacity"}` if adding the
  planned messages would make the epoch charge exceed `ceiling(A)`. No author row: refused.
- Reservations are joined/released as in v3 (owners counter; released uncommitted entries free their bytes).

Why this is enough, and needed:

- **Nothing admitted is dropped before its epoch is sealed.** Within an epoch, A's messages applied so far are the
  newest of A's messages in the window (new ones are appended, retries move to the end). Eviction removes A's
  oldest first and stops once `charge(A) <= ceiling(A)`. Since A's epoch charge is at most the ceiling, eviction
  stops before reaching any of this epoch's messages. So every message admitted in epoch e is in the window sealed
  at e. (With a larger per-epoch allowance a member's own new messages would push out earlier messages of the
  same epoch; that is the counterexample that fixes the cap at the share.)
- **The reducer never throws on admitted work**: admission refuses every case the reducer throws on, and checks
  conflicts against a superset of the reducer's window (the base window plus every reserved identity).
- **Order independence**: acceptance depends only on the set of A's identities this epoch, never on order or on
  other authors. Journal replay on reopen/recovery (v3-live.ts ~13401, ~13669) re-reserves the same set and accepts
  the same; the creator's predecessor validation seeds the policy with the closed postimage
  (v3-live.ts:20809), where every one of the epoch's messages is a base exact retry, charged once, and their sum is
  at most A's window charge in the postimage, so at most A's ceiling: it always accepts.
- **Displaced work drains**: messages displaced from epoch e (`displacementPolicies.message: "rebase"`) were
  admitted in e under the cap, so re-reserving them first in e+1 fits (same ceiling).
- A remote peer's view of A's operations is a subset of what A's own device admitted, so it never refuses what A
  admitted (single device per author, as in v3).
- Capacity allocation: v3 logic (admin only, no pending entries, exact closed allocation or the v3 formula). The
  formula's "used" is the window charge after this epoch's committed messages, computed with the same rule.

The per-epoch cap is the backpressure the player sees (G2): sends beyond the share before the next checkpoint are
refused and the text is kept for retry (unchanged UI behaviour). At 64 KiB the cap is the larger share (32,633 B
with 2 members, about 176 typical messages per checkpoint); the argument above does not depend on the budget.

**Largest message.** One share, as before, with one exception the 64 KiB window exposes: every message also
passes the shared message capture (examples/chat/src/v3-chat-message.ts, unchanged), whose
`SHIPPING_CHAT_STATE_LIMITS` refuses a record over 32,765 bytes. With 2 or more members every share is below
that (32,633 at most), so the share is the limit; only a single-member room (share 65,340) is limited to about
32 KB per message instead. Raising it would change a v3 file shared by both formats; not done.

## 3a. The window's ordinary resource bound (new value, for owner review)

Track Q's rule: one footprint {byteLength, items, maxDepth} that dominates every state the application's own
capture admits, derived from limits that capture enforces (G21), so a reservation sized from it covers the real
effect (G22). v3 keeps Track Q's approved {32768, 16384, 16}. The window's value is the **widest state the
window's capture admits**, per dimension, and the capture enforces exactly those limits
(`SHIPPING_CHAT_WINDOW_STATE_LIMITS`), so domination holds by construction and the limits never refuse a state
the budget allows:

- **byteLength 65,535.** The capture's whole-budget check is E + 2 + sum(ceilings) <= 65,536, where E is the empty
  state (one byte of messages count). A state's bytes are E + (count bytes - 1) + sum(charges), and a window holds
  fewer than 16,384 messages, so the count takes at most 2 bytes: at most 65,535. Reached: genesis shares, every
  share filled exactly, 128 or more messages.
- **items 9,503.** Items are 25 + 18 per message + 8 per member (the codec's counting: a record is 1 + 3 per
  field + its values; an array 1 + 1 per element + its elements). The smallest record is 124 bytes (one-character
  identity and text, display time 0), and a member has 66 one-character identities ([A-Za-z0-9._:-]), then
  125-byte two-character ones. Each member costs a row (72-74 bytes), so the most items come from eight members
  holding 61 and 7 x 66 smallest records under a one-character basis (an object id may be one character).
  An exhaustive search over the capture's rules (an unbounded knapsack over members, in
  tests/chat-rolling-window-rule.test.ts, independent of the product) gives 9,503; the witness passes the
  capture and the codec's own reader counts 9,503 items; one more smallest message is refused.
- **maxDepth 4.** State, capacity, allocations, row (messages are depth 3).

Genesis-split rooms reach less (8 members at 8,103 B: 65 smallest records each, 9,449 items); the bound is over
the capture's whole domain, which allocations reachable by reallocation stay inside. The library's consumer
accepts it (byteLength <= maxSnapshotBytes, items <= 16,384, depth <= 16). The same method at 32 KiB would give
{32767, 4755, 4}.

## 5. Local archive (device application data)

**Where it lives.** Browser: its own IndexedDB database
`ts-drp-chat-archive-v1--<hex(hashDomain("ts-drp/chat-archive-database/v1", objectId \0 localAuthor))>`, separate
from every room database (`ts-drp-v3-chat--…` and its suffixes), so no room census or room retention ever sees it.
Node: its own SQLite file (examples/chat/src/v3-chat-archive-sqlite.ts; tests and the Node harness only). The room
never opens, reads or writes it; nothing in packages/* changes.

**What it records.** For each message identity this device's projection has shown: the canonical message record
bytes (author, clientOperationId, displayTimeMs, text: all already authenticated by the room and admitted by this
device), the epoch of the projection it first appeared in, a local sequence number and its byte size. Key:
`<author>/<clientOperationId>/<hex(hashDomain("ts-drp/chat-archive-record/v1", record))>` ("/" separators: the
SQLite TEXT column cut an earlier NUL separator; a same-identity different-content message, possible only after
the first left the window, is kept as its own record).

**How it is written.** `onProjection` calls `archive.observe(projection)`: O(1), it keeps a reference and schedules
one flush in a later macrotask (`setTimeout(0)`), so no archive work runs inside the room's commit, seal, adoption,
install or lull. Only the latest observed projection is kept. The flush appends, in window order, every window
message the archive neither holds nor has a tombstone for (admitted since the last write, or while the archive was
not writing), then evicts by the bound, all in one strict-durability transaction (IndexedDB `durability: "strict"`, SQLite `synchronous=FULL` in WAL mode),
serialised (one flush at a time). Cost is measured per appended message.

**Bound and eviction.** Default, proposed for owner review: at most 2,000 messages and at most 1 MiB of record
bytes per room per device; when either is exceeded, the oldest records by local sequence are deleted in the same
transaction. Configurable per app instance. At open the archive loads at most the bound (one read).
A record the bound drops while its message is still in the window (a quiet member's old message, or any bound
smaller than the window) leaves a tombstone row (same key, empty record) so that message is not archived again,
while running or after a reopen; the tombstone is deleted in the first write whose window no longer holds the
message. Tombstones are never shown and never exceed the window's message count. (A first implementation that
appended only what followed the newest archived window message missed a new message when an exact retry moved an
archived message after it; the unit test for that case is in tests/chat-local-archive.test.ts.)

**Trust.** Stored bytes are untrusted (G5): every record is decoded and re-validated on load (canonical bytes,
message shape, key recomputed); invalid rows are skipped and deleted. The archive grants nothing: it never feeds
the reducer, admission, the projection, a proof or any room store. The UI shows it only as this device's history
(older messages, merged with the window by identity, the window copy winning).

**Crash, reopen, late join.**

- Eviction is identical after a persisted reopen or a crash at any point: the reducer is pure over the persisted
  base and the journal replay order (section 2).
- Archive appends are one transaction: a crash leaves the old or the new archive, never part (G15).
- Crash between admitting a message and appending it: on reopen the room's recovered projection still holds the
  message (it is in the window: journal replay re-admits it, or the sealed state carries it), and the first flush
  appends it. The archive misses a message only if it left the window while this device was not running
  (then this device never shows it again; other devices that archived it still do).
- A late joiner (or a device opening after a long absence) sees only the window, and its archive starts there.

## 6. Format change and compatibility (G25)

- New rooms (shipped `create`) sign the v4 blueprint digest in genesis. A joiner's invite is authenticated against
  whichever embedded catalog holds its digest (v4 or v3); the room's format is the one its genesis signed.
- v3 rooms keep v3 (code, blueprint, catalog unchanged), including their lifetime limit; no migration (the library
  has no users yet). RESULT.md says so.
- Settlement profile stays `creator-trusted-settlement-v1` with a version-3 ACL (unchanged create path).

## 7. Guarantees

- **G1** The shared state is at most 65,535 B forever and holds a bounded number of messages; the reducer's work
  per message is bounded by the window. No room store gains a per-message or per-epoch row: Chat rows are
  ordinary operations whose retention is the library's (settlement, Tracks K-T). The archive is device data in
  its own database with its own bound, never read or written on seal, adoption, install or lull paths. Proven by
  the 300-epoch Node run (state bytes, every store's rows and bytes, latencies, slopes).
- **G2** Admission refuses (backpressure) before a member exceeds the per-epoch share; accepted work is never
  evicted before seal and displaced work re-fits, so it stays finishable.
- **G3** Real transitions, three Writers, rebased work, reopen; peers' digests agree every epoch.
- **G5** Archive bytes re-validated on load, display only; room bytes unchanged in treatment.
- **G7, G8** The window has one decision owner (the reducer over authenticated state); no sweeper, no TTL. The
  archive's count/byte eviction deletes only local display copies that are not protocol data and carry no
  authority; it is outside the protocol's retirement (G7 governs protocol storage).
- **G14, G15, G16** Room crash atomicity is the library's (unchanged); archive transactions are atomic and strict.
- **G21** Every limit is a reviewed constant: the window (65,536, owner 2026-10-21), the shares and per-epoch cap
  (rules approved with it), the archive bound (approved), and the window's resource bound (derived from the
  capture's limits, section 3a; pending approval).
- **G22** Admission reserves bytes before the operation is issued (reservation precedes effects), as v3; the
  resource bound dominates every state the capture admits, so a reservation sized from it covers the effect.
- **G25** The format change is authenticated by the signed genesis blueprint digest; v3 and v4 never mix in a room.
- **G26** No safety check is relaxed to save latency; the only latency-motivated choice is where the archive
  append runs (after the projection callback).
- **G27** No library carve-out: everything is in examples/chat; the library folds v4 like any blueprint.
- **G28** Node SQLite native runs with SIGKILL for the archive store's atomicity; Chromium measurement for the
  browser store (Firefox/WebKit are not run: residual).
- G4, G6, G9-G13, G17-G20, G23, G24: unchanged (no library change; the archive is outside room custody).

## 8. Limits (owner review 2026-10-21: window 64 KiB; archive approved; bound pending)

1. **Shared window: 65,536 bytes per room** (owner, 2026-10-21; was proposed at 32,768). What: the newest
   messages every peer carries and every checkpoint signs. Why: keeps checkpoints the same size however old the
   room is. Player sees: older messages leave the shared history; they stay on the devices that saw them.
2. **Each member's share of it: an equal split among the members at room creation** (32,633 B each for 2 members,
   21,731 for 3, 16,280 for 4, 8,103 for 8): about 176, 117, 87 or 43 typical UI messages (185 B). Player sees:
   when a member's share is full, that member's own oldest messages leave the shared history as they post; other
   members' messages are not affected.
3. **Per-checkpoint sending limit: a member's share per epoch.** Why: a message admitted in an epoch must not be
   pushed out before that epoch is sealed. Player sees: after about a share's worth of messages between two room
   checkpoints, sends are refused until the next checkpoint; the typed text is kept for retry.
4. **Largest message: the member's share** (about 32 KB of text with 2 members, 8 KB with 8); in a single-member
   room the unchanged per-message capture's 32 KB (section 4).
5. **Device archive: 2,000 messages or 1 MiB per room per device, oldest dropped first** (approved). Player sees:
   this device's history beyond that is gone from this device. Clearing site data clears it. At 64 KiB the
   window holds up to about 460 of the harnesses' messages, well inside 2,000, so tombstones (records the bound
   drops while their message is still in the window) arise only with a smaller bound or very long quiet members.
6. Known limit, to a follow-up track (owner, 2026-10-21): members added after creation get no share unless bytes
   are free; a departed member's last messages stay in the window (their share is fixed at what they held).
7. **The window's resource bound: {65,535 bytes, 9,503 items, depth 4}** (section 3a). New value; needs approval.

## 9. Files

Product (examples/chat only): window-blueprint/{blueprint.json,blueprint.ts} (new), src/chat-window-catalog-material.json
(new, generated by the toolchain), src/v3-chat-window.ts (new: v4 state, budget and limits, genesis split,
reallocation, admission, application), src/v3-chat-archive.ts (new: archive core and IndexedDB store), src/v3-chat-archive-sqlite.ts (new:
Node store), src/chat-catalogs.ts (new: both embedded catalogs), src/v3-chat-application.ts (dispatch by artifact
id), src/index.ts (create v4, join either, archive, render). Unchanged: v3-chat-capacity.ts, v3-chat-message.ts,
capacity-blueprint/, chat-catalog-material.json.
Measurement: tests/fixtures/track-m-apps/* (format selection, archive measurement).
