# Track W: Chat's rolling window and the device archive

Worktree: <worktree agent-a9b9982b4fd998b37>/
Branch: track-w-chat-rolling-window, on main (codex/phase3a1b-p6-golden-path) 24d4ca61. First built on 6066c539,
then rebased on the coordinator's requests onto main 725f291b (6b9e27cc with Track Q 46eb7821), 760607d9 (Track U),
af342318 (the owner's decision rows), 369420d0 (Track Y's cache ceilings) and 24d4ca61 (Track X's fixes).
Measured against base 6b9e27cc (first round, 2026-10-20) and 760607d9 (second round, 2026-10-21, after the owner's
review). Commits: see "Commits" at the end. Evidence: <evidence>/track-w/ (PROGRESS.md, MAP.md, DESIGN.md, bin/,
logs/, tests/, latency/, chromium/, bp/).

Shipped Chat kept every message in its replicated state against a lifetime share of a 32 KiB budget, so a busy room
refused new messages for good (Track T: near epoch 57 at 4 messages per epoch). The owner chose "window + local
archive": the shared state keeps a rolling window of recent messages, and each device keeps the messages it has seen
in a local archive. This track builds that for new rooms.

## Summary

- **The window ships at 32 KiB, by the owner's decision (section 0).** The owner first chose a 64 KiB window on
  2026-10-21. It was built test-first (bebb3d95, d332bf4d) and its unit tests pass, but every room fails at the
  first creator adoption after its state passes 32,768 bytes (epoch 58 on Node SQLite and in Chromium: "v3 room
  migration state is unbounded"). The library caps a room's application state at 32,768 bytes
  (packages/node/src/v3-room.ts, packages/outcome-commit), and existing RED tests pin that cap and the 49,152-byte
  migration record. Changing them is outside this track, so the 64 KiB commits are reverted on the branch
  (ec14c306) and stay in its history. After this blocker the owner chose, the same day, to ship the 32 KiB window
  now; raising the library's room-state cap stays an open item, with no track planned yet. The archive bound (2,000
  messages or 1 MiB) is approved and shipped; late-joiner shares go to follow-up W2. Section 0 keeps the 64 KiB
  values, its resource bound and what it costs, for later.
- **What changed.** New Chat rooms sign a new state format (version 4, artifact `v3-shipping-chat.v4`): the shared
  state is a rolling window of each member's newest messages that fit that member's share of 32,768 bytes, and a
  member's new message pushes out only that member's own oldest message. Each device keeps the messages it has
  seen in a local archive (its own database, 2,000 messages or 1 MiB per room, approved), and the page shows the
  window and the archive as one history. Rooms created before this change keep version 3 and are not migrated.
  Nothing under packages/ changed; the settlement profile stays `creator-trusted-settlement-v1`.
- **The window rule is in the compiled reducer**, so every peer folds the same bytes and digest, a reopen or crash
  replay evicts the same messages, and admission caps a member's distinct messages per epoch at the member's share,
  so a message admitted in an epoch is always in the state sealed at that epoch.
- **Map:** nothing that pins Chat's current design had to change. Every pinned item (R9 tests, the frozen
  `carriedChatCapacity` model, the R9 receipt) describes version 3, which is unchanged; no RED, governance or
  contract test, frozen artifact, registry or vector was edited.
- **Node SQLite, 300 epochs (7/7 pass):** 1,200 messages, no refusal; every peer's state digest equals an
  independent model's every epoch; the encoded state stays at or below 32,768 bytes (31,041-32,684 once full);
  room rows are constant (175 creator, 145 per Writer) and bytes flat; seal 213, adoption 572, install 185, creator
  lull 1,915, Writer lull 882, Writer issue 28 and creator issue 377 ms (p50 over epochs 71-300), every slope zero
  or negative; persisted reopen and an archive crash behave as designed.
- **Chromium, 150 and 200 epochs:** room rows (135/128) and bytes flat, state flat at the window. The first
  150-epoch run drifted up by +1.7 ms per epoch (adoption, epochs 60-150), within the swing of a constant-state
  Canvas control; a second run of 200 epochs (2026-10-21) has every transition's slope zero or negative over epochs
  56-200 (adoption -0.34, install -1.03, creator lull -0.27 ms per epoch). **First 50 epochs against base:** within
  0-10% on every transition in the first round; in the second round base 760607d9, the 32 KiB window and the 64
  KiB window, started together twice, are within 5% of each other on every transition, with identical room rows
  and bytes.
- **Real networking (Track X's shipped-app harness, on 24d4ca61):** the shipped page runs 16/16 epochs at 2
  messages per epoch and 30/30 at 8, the second filling the window and evicting from epoch 24; every epoch the
  observer's whole history equals the creator's (section 7.1).
- **Archive:** the projection callback does an O(1) `observe` (0.01 ms); one strict transaction per write in a later
  task, 0.4-2.8 ms per write in Chromium (no trend), 0.2-0.4 ms per message on Node; 296 bytes per message in
  IndexedDB. The origin's IndexedDB usage grows about 5-8 KB per epoch per role without the archive too; the
  archive adds about 1.2 KB of records per epoch until its bound.
- **Track Q's resource bound stands:** window rooms supply the same reader with the same value (32,768 bytes,
  16,384 items, depth 16), and every window state passes Chat's state check under exactly those limits.
- **Suites against base, per test:** no new failure in any set (Chat, the six Canvas/Chat native tests,
  storage-node retirement, packages/node, the 117-file root set with Tracks K-T and Q, and the Canvas/Chat e2e);
  Track W's 21 unit tests and 7 native tests are new and pass. `pnpm -r typecheck`: 0 errors.
  `node scripts/check-shadowed-sources.mjs`: exit 0. The second round reran the checks at the final tip (section
  7.1).
- **The native test now refuses a run too short for its assertions** (the coordinator's CHAT_WINDOW_EPOCHS=60 run
  failed four of them): it names the length it needs (231 epochs, or 120 with CHAT_WINDOW_PAD=400), and its
  assertions at 300 epochs are as strong as before or stronger (section 7.1).
- **Open item, no track planned:** raising the library's room-state cap, which a larger window needs (section 0).
  Track Q's approved bound holds unchanged for the shipped window, so nothing new is up for review.

## 0. The owner's review (2026-10-21), the 64 KiB blocker, and the decision to ship 32 KiB

The owner reviewed section 3's limits on 2026-10-21 (decision rows 42 and 43):

- **The shared window: 64 KiB (65,536 bytes) per room**, with the same rules (equal split at creation, own-oldest
  eviction, at most one share per checkpoint, the largest message one share). Version-3 rooms keep their 32,768
  bytes and Track Q's approved limits; the window format gets its own budget and limits, and Track Q's resource
  bound is re-derived for it.
- **The device archive: 2,000 messages or 1 MiB per room per device, oldest first.** Approved as proposed. This is
  what the branch ships.
- **Late-joiner shares and departed members' bytes** go to a follow-up track (W2) after this merges (section 9).

**The 64 KiB window cannot run on today's library. This branch therefore keeps the 32 KiB window, and the 64 KiB
change is reverted on it. After this blocker the owner chose to ship the 32 KiB window (end of this section).** The
64 KiB change was built and stated test-first
(bebb3d95 RED, d332bf4d product), and its unit tests pass. But a real room fails as soon as its state passes
32,768 bytes:

- **Chromium counterexample** (Track M's harness, room host, creator and a Writer, 2 messages per role per epoch;
  <evidence>/track-w/latency/chromium/long-w64-200.log): epochs 1-57 pass. At epoch 58 the creator's adoption
  throws `TypeError: v3 room migration state is unbounded`, from `normalizeApplicationStateBytes` ←
  `installSuccessorProjectionBase` ← `performCreatorSuccessorAdoption`. The state was 32,337 bytes after epoch 57,
  and epoch 58's messages take it past 32,768.
- **Node SQLite counterexample** (tests/chat-rolling-window-native.test.ts, 300 epochs, creator and two Writers;
  <evidence>/track-w/tests/node-300-w64.log): epochs 1-57 pass (32,411 bytes after epoch 57). At epoch 58 the
  creator's adoption throws the same error from the same place (packages/node/src/v3-room.ts:877 ←
  `installSuccessorProjectionBase` :3187 ← `performCreatorSuccessorAdoption` :6632), and all 7 tests fail.
- **Where the library caps it.** A room's application state is at most 32,768 bytes wherever the room takes a
  state in:

  - packages/node/src/v3-room.ts:877 and :880 `normalizeApplicationStateBytes` (genesis states, and every
    migration or successor projection base, which the creator installs at each adoption): over 32,768 bytes is
    "unbounded", and the decode limit is 32,768;
  - packages/node/src/v3-room.ts:1657 and :1680 (a migration record's state: at most 32,768 bytes, in a record of
    at most 49,152);
  - packages/outcome-commit/src/index.ts:707 (an inherited authenticated state: at most 32,768 bytes).

  Track Q's approved bound for version 3 ({32,768 bytes, 16,384 items, depth 16}) is the same cap.

- **Existing RED tests pin it:**
  - tests/phase-3-exit-genesis-roots-red.test.ts:358-364: a 32,768-byte genesis state is accepted, a 32,769-byte
    one refused (the same function guards successor bases);
  - tests/phase-6a-creator-successor-product-red.test.ts:247 pins the source text of the migration activation
    record's 49,152-byte bound in examples/v3-room/src/index.ts, and tests/phase-3h-v3-room-rehearsal-red.test.ts:784
    asserts a migration record of at most 49,152 bytes. A migration record carries the room's state, so a 64 KiB
    state cannot fit in it.
- **Why it was missed.** Before building, this track checked the library's fold ceiling for application states
  (`maxApplicationStateBytes` = the room's `maxSnapshotBytes`, packages/node/src/v3-live.ts:4478) and concluded
  that 64 KiB needs no library change. It did not check the room's own normalization of genesis and migration
  states. The 32 KiB window never reaches that cap (its largest state is 32,767 bytes), and the 64 KiB unit tests
  never build a room. The room-level runs found it.

Raising the cap is a change to packages/node and packages/outcome-commit and to existing RED tests, which this
track's brief does not allow ("if packages/\* must change, stop and report"; "never edit existing RED or governance
tests"). So the track stops here for 64 KiB. What a library track would need to decide:

1. The room's application-state cap for successor bases, migrations and inherited outcome state (at least
   65,536 bytes for the window; genesis states stay small and could keep 32,768), and the migration record's
   49,152-byte bound that carries the state.
2. What every consumer of those states sizes from them: snapshot chunks, settlement and successor-fence preimages
   (packages/node/tests/creator-ordinary-settlement-capacity.test.ts sizes a 32,768-byte successor fence preimage),
   the creator's ordinary resource reservation (Track Q), and the product states asserted "within unchanged
   ceiling" below 32,768 in tests/phase-6b-d110c-0c1f5b-integration-red.test.ts.
3. A new review of the RED tests above (G21: these caps are reviewed limits).

**The owner's decision after the blocker (2026-10-21): ship the 32 KiB window now.** Raising the library's
room-state cap stays an open item; no track is planned for it yet. The branch ships the 32 KiB window, which the
rest of this record measures, with the limits of section 3 as shipped, and Track Q's approved resource bound holds
for it unchanged. The 64 KiB history and the values in sections 0.1-0.3 stay here for later: the 64 KiB work is in
the branch's history, ready to reapply (`git revert` of this branch's revert commit, or cherry-pick bebb3d95 and
d332bf4d) once the library allows a larger state.

### 0.1 The 64 KiB values, for when the library allows them

- **Shares** (equal split, harnesses' object id): 65,340 bytes for 1 member, 32,633 for 2, 21,731 for 3, 16,280
  for 4, 8,103 for 8; about 353, 176, 117, 87 or 43 typical messages of 185 bytes (32 KiB: 176, 87, 58, 43, 21).
  The page's longer object id leaves 32,611 per member for 2.
- **Per-checkpoint send limit:** one share, about 176 typical messages between checkpoints with 2 members.
- **Largest message:** the share, except that the shared per-message capture (v3-chat-message.ts) refuses a record
  over 32,765 bytes, so a single-member room's limit is about 32 KB, not its 65,340-byte share.
- **Archive interplay:** the window holds at most about 530 messages (typically 350-460), inside the archive's
  2,000; the 1 MiB bound binds first only for messages averaging over 524 bytes.

### 0.2 Bound for owner review (64 KiB; not approved, and moot until the library change)

Derived by Track Q's method (the widest state the window's capture admits, from the capture's limits, never from
observed sizes), implemented in d332bf4d as `SHIPPING_CHAT_WINDOW_STATE_LIMITS` so the proofs could run:

- **{byteLength 65,535, items 9,503, maxDepth 4}.**
  - Bytes: empty state + 2 bytes of count framing + every ceiling ≤ 65,536, and a window of fewer than 16,384
    messages uses at most one of the 2 framing bytes, so at most 65,535 (reached by filling the genesis shares
    exactly with 128 or more messages).
  - Items: the codec counts 25 for the empty state, 18 per message and 8 per member. The most items come from eight
    members holding 61 and 7 × 66 of the smallest (124-byte) records under a one-character object id: 9,503, found
    by an exhaustive search (an unbounded knapsack over members) that is independent of the product; the codec's
    reader counts 9,503 in that witness, the capture admits it, and one more smallest message is refused.
  - Depth: state, capacity, allocations, row.
- G21: its inputs are the owner's 64 KiB and the capture's rules. G22: it dominates every state the capture admits,
  and every state passes the capture.
- The same method at 32 KiB gives {32,767, 4,755, 4}, inside Track Q's approved {32,768, 16,384, 16}, which the
  32 KiB window keeps reporting (section 3).

### 0.3 What 64 KiB costs (measured before the blocker; for the owner's decision)

- **CPU per epoch at a full window** (bin/window-bench.ts: the window application's own work on a full window, CPU
  time per call so the machine's load does not count; <evidence>/track-w/latency/microbench/summary-cpu.txt): 64
  KiB costs about twice 32 KiB.

  | Members | State (32 → 64 KiB) | Messages in window | Project an epoch (ms) | Admit an epoch (ms) | Restore (ms) | Encode (ms) |
  | ------- | ------------------- | ------------------ | --------------------- | ------------------- | ------------ | ----------- |
  | 2       | 32,663 → 65,265     | 230 → 460          | 15.6 → 33.2           | 12.3 → 25.7         | 3.6 → 5.6    | 1.8 → 3.5   |
  | 3       | 32,471 → 65,365     | 228 → 458          | 17.6 → 34.1           | 12.2 → 22.4         | 3.8 → 7.0    | 1.7 → 3.4   |

  So a full 64 KiB window would add about 17 ms of CPU to each projection of an epoch and 10-13 ms to each
  admission of an epoch's messages, on every peer. Against the 0.3-3.4 s transitions measured under this machine's
  load that is below the run-to-run noise, but it is the part of the window's cost that grows with its size.

- **First 50 epochs, paired** (Chromium, base 760607d9 lifetime format, the 32 KiB window and the 64 KiB window
  started together so they share the machine's load, two rounds; <evidence>/track-w/latency/chromium/trio-first-50.txt):
  no difference beyond ±5% on any transition, and identical room rows and bytes (creator 135 rows, 184,377 bytes;
  recipient 128, 182,640 at epoch 50). In the first 50 epochs no message has left either window, so the states are
  byte-identical; this shows the 64 KiB format costs nothing until its window holds more than 32 KiB.
- **Steady state at 64 KiB could not be measured:** no room reaches it (above).

Two rounds, 10:22-10:41 on 2026-10-21, load 60-76. The three runs of a round started together, from one worktree:
the 32 KiB bundle was built from dca097aa's Chat sources (then 3531a4fd), and base's bundle and driver from
760607d9's, in untracked copies removed afterwards. Medians over epochs 1-50 of both rounds (each round alone:
trio-first-50.txt):

| Median, epochs 1-50 (ms) | Base 760607d9 (lifetime) | 32 KiB window | 64 KiB window |
| ------------------------ | ------------------------ | ------------- | ------------- |
| Seal                     | 352                      | 345           | 342           |
| Adoption                 | 1,003                    | 980           | 969           |
| Install                  | 446                      | 445           | 442           |
| Creator issue            | 537                      | 514           | 492           |
| Recipient issue          | 34.6                     | 31.2          | 34.5          |
| Creator admits remote    | 360                      | 351           | 334           |
| Recipient admits remote  | 12.3                     | 10.6          | 11.1          |
| Creator lull             | 3,373                    | 3,366         | 3,227         |
| Recipient lull           | 1,529                    | 1,431         | 1,510         |

**In plain words:** in the first 50 epochs the larger window is not visible in any transition, as expected, since
the states are identical. Past 32 KiB it would cost the CPU above (about twice 32 KiB's) and about 33 KB more in
every copy of the state a checkpoint, snapshot or install carries, and no room gets there on today's library.

## 1. Map: what pins Chat's design

The full map is <evidence>/track-w/MAP.md. The fact that shapes it: Chat's shared state is produced by a compiled
blueprint reducer (examples/chat/capacity-blueprint, artifact `v3-shipping-chat.v3`, digest 61ab694a…065f), which
the library folds at seal; the room then checks that the app's projection of the base equals the sealed state
(packages/node/src/v3-room.ts). So the window rule cannot live only in the projection or in admission: it must be in
the reducer, which means a new compiled artifact with a new digest. Each room's genesis signs its digest, so a room's
format is fixed by its signed genesis.

So the change **adds** a version-4 format beside version 3 and keeps every version-3 file byte-identical. Every
class (ii) item pins version 3 and stays true of it; **no pin blocked and nothing in class (ii) was edited**:

- tests/r9-chat-capacity-ledger.test.ts and tests/r9-chat-capacity-room-native.test.ts (the lifetime ledger: "no
  rollover refresh", "dormant entitlement never refreshes"), r9-chat-shipping-room/role-network/creator-selection,
  r11-disposable-session, and the stale r9-chat-metadata / r9-chat-artifact-contract tests: they build v3 through
  the v3 catalog (`SHIPPING_CHAT_CATALOG_DIR` or the v3 material) and are unchanged.
- packages/protocol-v3/formal/author-lineage-actions.qnt `carriedChatCapacity` (frozen, hash-pinned in
  freeze-policy-v3.json and the registry contract): it models the v3 lifetime ledger
  (`committed == protectedMessages`). It is unchanged and still true of v3. **No model of v4 exists** (a gap,
  section 9).
- The MAIN receipt `.logs/bounded-storage-lifecycle/.../r8-native-main-integration01/receipt.json`
  (`r9ChatCarriedAdmissionAndShippingUi20261011`): historical, read by no test. Its source pin of
  v3-chat-application.ts no longer matches (it already did not after Track Q's edit).
- The registry/lifecycle contracts that pin the vitest workspace list: unaffected (no workspace change).

Consequences the owner should know: the R9 Chat tests, the `carriedChatCapacity` model and the R9 receipt now
describe **version-3 rooms only**; new rooms are version 4 and are covered by Track W's tests. The shipped page
carries both catalogs, so a version-3 room still opens, and still stops near its lifetime capacity, by design.

## 2. The design

The full design is <evidence>/track-w/DESIGN.md (sections 0-9). In brief:

**State format (version 4).** `{ version: 4, messages: [...window, oldest first, in application order],
capacity }`. `capacity` is the version-3 record unchanged (same equal genesis split, same reallocation formula).
Each member's charge is the exact canonical size of that member's messages in the window
(119 + w(L) + L + w(2t) + w(U) + U bytes); every charge is at most the member's ceiling, and the ceilings plus the
empty-state overhead fit in 32,768 bytes, so the encoded state is at most 32,768 bytes forever.

**The window rule (in the reducer).** For a message m by author A: an identical retry of a message already in the
window moves it to the newest place; the same identity with different content is refused; otherwise m is appended
and, while A's charge exceeds A's ceiling, A's own oldest message leaves the window. Eviction depends only on the
order of A's own messages, so how other members' operations interleave never changes which of A's messages leave.
The rule is a pure function of the authenticated base and the epoch's operations in the library's order, so every
peer folds the same bytes and digest, and a reopen or crash recovery that replays the same journal evicts the same
messages. The reducer computes UTF-8 sizes itself (the deterministic lint forbids TextEncoder) and rejects unpaired
surrogates as the canonical codec does; a differential test checks it against `encodeCanonical`.

**Shares.** Unchanged equal split at creation: 16,249 bytes each for 2 members, 10,808 for 3, 8,088 for 4, 4,007
for 8 (about 87, 58, 43, 21 messages of 185 bytes). A member's share now bounds what that member holds **in the
window**; bytes pushed out return to that member at once. One member can never take another's bytes; only the
lifetime aspect is gone.

**Admission** (`createShippingChatWindowAdmissionPolicy`). As version 3 (exact retries, conflicts, joined and
released reservations, admin capacity allocation by the v3 formula), plus one rule: the bytes of a member's
distinct messages admitted in one epoch (exact retries of window messages included) may not exceed the member's
share. That is what makes the window safe: within an epoch a member's messages are that member's newest, and
eviction stops as soon as the member's charge is within the share, so it never reaches a message admitted in the
same epoch. **A message admitted in an epoch is always in the state sealed at that epoch.** Acceptance depends only
on the set of the member's identities in the epoch, never on order, so journal replay after a reopen accepts the
same set, and the creator's predecessor validation (seeded with the closed postimage, where every message is an
exact retry) always accepts. Displaced work was admitted under the same cap, so it re-fits in the next epoch. With a
larger per-epoch allowance, a member's own messages would push out earlier messages of the same epoch: that is the
counterexample that fixes the cap at the share. The randomized rule test checks "nothing admitted leaves before
seal" over 40 seeded rounds.

**Device archive** (examples/chat/src/v3-chat-archive.ts). Application data of one device, in its own database
(IndexedDB `ts-drp-chat-archive-v1--<sha256(objectId, local author)>` in the browser; its own SQLite file on Node),
never a room database, never in a room census, never opened by the room. The projection callback only keeps a
reference (`observe`, O(1)); one write runs in a later macrotask, in one strict transaction (IndexedDB
`durability: "strict"`, SQLite WAL with `synchronous=FULL`), appending in window order every window message the
archive neither holds nor has a tombstone for. Bound: 2,000 messages or 1 MiB of records per room per device,
oldest first (approved 2026-10-21). A record the bound drops while its message is still in the window leaves a tombstone row
(same key, empty record), so that message is not archived again while running or after a reopen; the tombstone
goes once the message leaves the window, so tombstones never outnumber the window. Rows are untrusted: each is
decoded, re-captured and re-keyed on load; a failing row is dropped and deleted. The archive records only messages
this device's room authenticated and admitted (it reads the room's own projection), with the projection's epoch;
it feeds nothing back into the reducer, admission, the projection, a proof or any room store. The page shows the
window and the archive as one history, each message once (the window's copy first); archive-only rows carry the
class `archived` and the title "Kept on this device; no longer in the room's shared history."

**Crash and reopen.** The room's crash atomicity is the library's (unchanged). An archive write is one transaction:
a SIGKILL before or after its commit leaves the old or the new archive (unit test, real child process). A crash
between admitting a message and archiving it is repaired by the first write after reopen, because the recovered
projection still holds the message (it is in the window: either sealed, or replayed from the journal); the
native test crashes a Writer's archive exactly there. The archive misses a message only if it left the window while
the device was not running; the player then does not see it on that device (other devices that archived it do). A
late joiner sees only the window; its archive starts there.

**Format (G25).** New rooms (the page's `create`) sign the v4 digest
`b0bb30c5677e927b0a47a78508b436eae755e635f9c4613387ba490f62897560`; a joined invite is authenticated against the
window catalog first, then the lifetime catalog, and the room runs the format its genesis signed. **Rooms created
before this change keep version 3 (its code, blueprint, catalog and lifetime limit) and are not migrated**: the
library has no users yet, and a v4 migration record refuses a v3 state. The settlement profile stays
`creator-trusted-settlement-v1` with a version-3 ACL.

**Track Q's resource bound.** After the rebase onto Track Q, window rooms supply
`readOrdinaryApplicationResourceBound` too, with Track Q's rule and value ({32,768 bytes, 16,384 items, depth 16},
approved 2026-10-20), so their creator runs its lull. The window's state check now uses
`SHIPPING_CHAT_CAPACITY_STATE_LIMITS` itself, and the admission policy captures the joined window of every message
reservation under those limits before admitting it, as the lifetime policy does; section 8 gives the argument. The
reader accepts only the window catalog entry (through Track Q's unchanged `resourceBoundBases`, passed in) and only
bases that restore as window states.

## 3. Limits, as shipped (proposed 2026-10-20; the owner's decisions of 2026-10-21)

The limits as shipped, by the owner's decisions of 2026-10-21 (section 0): a 32 KiB window, the equal split at
creation, own-oldest eviction, one share per checkpoint, the largest message one share, and the archive at 2,000
messages or 1 MiB per room per device.

1. **The shared window: 32,768 bytes per room.** Shipped by the owner's decision after the 64 KiB window they
   first chose proved to need a library change (section 0). Unchanged from today's cap, and the same value
   Track Q's approved resource bound rests on. What it is: the newest messages every peer carries and every checkpoint signs. Why:
   checkpoints stay the same size however old the room is. What the player sees: older messages leave the shared
   history; they stay on the devices that saw them.
2. **Each member's share of it: an equal split among the members at room creation** (16,249 bytes for 2 members,
   10,808 for 3, 8,088 for 4, 4,007 for 8; about 87, 58, 43 or 21 typical messages). What the player sees: once a
   member's share is full, each new message from that member pushes out that member's own oldest message; other
   members' messages are not affected.
3. **Sending limit per checkpoint: a member's share.** A member can send about one share's worth of messages
   between two room checkpoints; further sends are refused until the next checkpoint and the typed text is kept for
   retry (the page already does this). Why: a message accepted between two checkpoints must still be in the shared
   history when the next checkpoint is signed.
4. **Largest message: the member's share** (about 16 KB of text with 2 members, 4 KB with 8). Unchanged.
5. **Device archive: 2,000 messages or 1 MiB per room per device, oldest dropped first.** Approved by the owner on
   2026-10-21. What the player sees: this device's history beyond that is gone from this device; clearing the
   site's data clears it.
6. **Known limit, to follow-up track W2 after this merges** (owner, 2026-10-21): members added after creation get
   no share unless bytes are free (as in version 3), and a departed member's last messages stay in the window.
   Options: a share for late members (smaller genesis split or rebalancing), letting unused shares be borrowed, or
   an age horizon.

Track Q's approved resource bound holds unchanged: the window keeps every state within the same limits (section
8), so the approved basis still holds and there is nothing new to review there.

## 4. Node SQLite: 300 epochs

Data: <evidence>/track-w/latency/node-300/chat-window-native.jsonl (one record per epoch: state bytes, window,
charges, every store's census per peer, archive stats, latencies, lull outcomes); vitest log and JSON
<evidence>/track-w/tests/native-300.{log,json}; summaries summary.txt, windows.txt and steady-slopes.txt beside the
JSONL (bin/native-summary.py, bin/native-windows.py, bin/file-bytes.py); load samples load.tsv.

Setup (tests/chat-rolling-window-native.test.ts): the shipped Chat composition (window format, Track Q's reader,
creator-trusted-settlement-v1, ACL v3) on the Node SQLite host; creator and two Writers, each with its own
databases; 4 messages per epoch (creator twice, each Writer once; 143-byte records); genuine seal, creator
adoption, two installs and all three peers' lulls (`maintainRecoveryPool()`) every epoch; 300 ms settle; persisted
reopen of every peer at epoch 150; a crash of Writer 1's archive at epoch 155; Writer 2 keeps a 100-message
archive. Run 22:44-23:25 on 2026-10-20, 2,412 s; load average about 20 at the start and 140-270 from epoch 200
on (other agents' work).

**7/7 tests pass**: 1,200 messages over 300 epochs with no refusal; every peer's state digest equals the
independent model's every epoch; the window is exactly each member's newest messages that fit; the joiner's
installed state equals the model's window; reopen and crash behave as designed (below).

Medians (p90) per window of epochs, and the least-squares slope over the steady epochs 71-300 (the window is
full from epoch 71). Times in ms.

| Measure                         | e1-50       | e71-140     | e141-210    | e231-300    | Slope e71-300 |
| ------------------------------- | ----------- | ----------- | ----------- | ----------- | ------------- |
| State bytes (encoded)           | 14,644      | 32,535      | 32,518      | 32,518      | +0.42 B/epoch |
| Messages in the window          | 102         | 228         | 225         | 225         | -0.01         |
| Room rows, creator (all stores) | 175         | 175         | 175         | 175         | 0.000         |
| Room rows, each Writer          | 145         | 145         | 145         | 145         | 0.000         |
| Room table bytes, creator       | 212,135     | 268,073     | 268,019     | 268,298     | +4.2 B/epoch  |
| Room table bytes, each Writer   | 184,668     | 240,682     | 240,594     | 240,940     | +4.3 B/epoch  |
| Seal                            | 178 (257)   | 241 (391)   | 247 (529)   | 192 (251)   | -0.44         |
| Adoption (creator)              | 467 (566)   | 629 (1108)  | 657 (1734)  | 509 (589)   | -1.15         |
| Install (each Writer)           | 141 (186)   | 203 (399)   | 200 (547)   | 162 (210)   | -0.38         |
| Lull, creator                   | 1560 (1908) | 2108 (3647) | 2097 (4746) | 1650 (2134) | -4.11         |
| Lull, each Writer               | 750 (999)   | 967 (1922)  | 968 (2191)  | 770 (1138)  | -2.29         |
| Issue, creator's messages       | 305 (475)   | 390 (746)   | 411 (850)   | 356 (425)   | -0.79         |
| Issue, Writers' messages        | 18 (27)     | 30 (68)     | 31 (67)     | 25 (32)     | -0.08         |

- **Flat with room age (G1).** The encoded state is never above 32,768 bytes (steady 31,041-32,684); every room
  store's row count is constant from epoch 7 to epoch 300 (175 rows on the creator, 145 on each Writer; only
  `journal:scopes` moves between 7 and 8), and the table bytes stay within a 5% band with no trend. Every latency's
  slope over epochs 71-300 is zero or negative; the middle window is slower because the machine's load was highest
  then, and the last window, at the oldest room age, is the fastest steady window.
- **SQLite files** (database plus WAL) stay at or below about 4.2 MB per store, SQLite's WAL autocheckpoint
  plateau: the creator's stores reach it by epoch 20 and stay there; the Writers' signing store was still filling
  its WAL at about 16 KB per epoch (2.4 MB at epoch 300) and has the same ceiling. A persisted reopen truncates
  the WALs: at epoch 151 every room store is 12-417 KB. This is the library's storage, unchanged here.
- **Seal, adoption and lull on Track Q's basis.** The creator's lull is `deferred:unsupported` at epochs 1-2 (the
  lull's own floor, as in Track Q) and `not-needed` at epoch 3; the Writers' lulls are `not-needed` at epochs 1-2;
  every other lull (893 of 900 peer-epochs) is `maintained`, and seals no longer retire inline. Track Q's
  Node Chat numbers (version 3, a near-empty state, 16 epochs, load 14-60) are of the same order: seal
  188-296 ms, adoption 483-1026 ms, install 99-234 ms, creator lull 1.6-3.4 s, creator issue 110-446 ms.
- **Per-message issue cost.** A Writer's message is issued in 25-31 ms (p50 per window). The creator's are slower
  (p50 219 ms for its first message of an epoch and 442 ms for its second, which follows a Writer's delivered
  message); both are flat with room age. Track Q measured the creator's Chat issue at 110-446 ms on a near-empty
  version-3 state; this track did not profile it further.
- **Reopen at epoch 150.** Every peer's state bytes after the reopen equal the creator's before it, and every
  archive lists the same messages in the same order; eviction after the reopen equals the model's (the window rule
  is replayed from the same journal).
- **Crash at epoch 155.** Writer 1's room admitted its message, then its archive was discarded before writing (what
  a crash leaves) and the peer reopened: the message was not in the archive before, was in the window, and was in
  the archive after the first write.

## 5. Chromium: 150 epochs, and the first 50 against base

Data: <evidence>/track-w/latency/chromium/ (one JSONL per run, its log with the load at start and end, and the
summaries `*-summary.txt`, `pair-head-55-compare.txt`, `compare-first-50.txt`; scripts bin/chromium-summary.py,
bin/chromium-buckets.py, bin/chromium-compare.py, bin/archive-trend.py; runner bin/lat-chromium-app.sh).

Setup: Track M's app harness (tests/fixtures/track-m-apps/browser/), measurement only. Headless Chromium, the
creator and a Writer recipient on two pages of two origins, each on the engine's own IndexedDB and Web Locks, the
room host (room database, the shipped page's storage path), the product composition with Track Q's reader (so the
creator runs its lull), 2 messages per role per epoch, 300 ms settle. Rows travel through the harness's relay,
not the page's networking, so Track X's settlement delivery stall does not apply. Track M's room-host failure at
epoch 3 (`creator recovery role transfer source failed: internal-invariant`), which Track Q reported for this
harness's Node runs (`TRACK_M_APPS=1`), did not occur in any Chromium run here (base, window or lifetime format);
this track did not use the Node variant.

### 5.1 The window format, 150 epochs (2026-10-20 23:27-23:45, load 166 falling to 32)

Medians per window of epochs, and the least-squares slope over epochs 60-150 (the window is full from epoch 58).

| Measure                         | e1-24   | e25-49  | e50-59  | e60-74  | e75-99  | e100-124 | e125-150 | Slope e60-150 |
| ------------------------------- | ------- | ------- | ------- | ------- | ------- | -------- | -------- | ------------- |
| State bytes                     | 7,238   | 21,057  | 30,927  | 32,695  | 32,699  | 32,585   | 32,661   | -1.1 B        |
| Creator rows (all room stores)  | 135     | 135     | 135     | 135     | 135     | 135      | 135      | 0             |
| Recipient rows                  | 128     | 128     | 128     | 128     | 128     | 128      | 128      | 0             |
| Creator room bytes              | 141,784 | 169,708 | 189,420 | 193,699 | 193,738 | 193,678  | 193,794  | +0.6 B        |
| Recipient room bytes            | 139,983 | 168,002 | 187,700 | 192,029 | 192,056 | 192,011  | 192,200  | +1.2 B        |
| Seal (ms)                       | 233     | 266     | 269     | 260     | 254     | 278      | 278      | +0.52         |
| Adoption                        | 626     | 665     | 694     | 715     | 707     | 767      | 797      | +1.71         |
| Install                         | 260     | 274     | 282     | 302     | 300     | 328      | 345      | +0.82         |
| Creator issue (per message)     | 330     | 357     | 411     | 357     | 359     | 415      | 423      | +0.87         |
| Recipient issue (per message)   | 21      | 26      | 30      | 32      | 32      | 34       | 33       | -0.07         |
| Creator admits a remote message | 423     | 408     | 401     | 448     | 454     | 456      | 493      | +0.52         |
| Creator lull                    | 2,187   | 2,261   | 2,321   | 2,402   | 2,399   | 2,578    | 2,674    | +4.63         |
| Recipient lull                  | 982     | 1,000   | 974     | 1,114   | 1,067   | 1,123    | 1,140    | +0.80         |
| Creator archive messages        | 50      | 148     | 218     | 268     | 348     | 448      | 550      | +4.0          |

- **Storage is flat.** Every room store's row count is constant from epoch 10 to 150 on both roles, and the room
  bytes are flat once the window is full (193.7-193.8 KB on the creator). The snapshot chunks hold the window (67 KB
  in two chunks at epoch 150), where Track T recorded them growing with the message history (15.7 kB at epoch 8 to
  98.5 kB at epoch 57).
- **Lulls:** `deferred:unsupported` at epochs 1-2 (the floor), `not-needed` 3 times, `maintained` in all other 295
  role-epochs.
- **Latency.** Seal, recipient issue and recipient lull are flat. Adoption, install and the creator's lull drift up
  by about 10-15% between epochs 60-99 and 125-150 (+0.8 to +4.6 ms per epoch) while the load fell. One run cannot
  separate a drift that small from the machine: the Canvas control below swings more than that between 10-epoch
  blocks with a constant 844-byte state. Nothing in Chat's window code grows with room age (the admission policy is
  built per epoch from the authenticated base, the window is bounded, and the archive's per-write work is O(window)
  plus a bounded set), and the 300-epoch Node run of the same code shows no growth. Track U is investigating a
  known per-epoch heap slope in Chromium long rooms on every app (0.36 MB per epoch on the Grid), which would show
  this way.
- **Canvas control, same harness and bundle, 150 epochs** (23:47-00:07, load 99 falling to 35;
  canvas-control-head-150\*): rows flat (135/128), state constant; adoption medians per 10 epochs range 604-915 ms,
  creator lull 2.0-3.0 s, and every slope over epochs 60-150 is negative (adoption -2.0, creator lull -7.0 ms per
  epoch). The swing in both runs follows the load, not the room's age.

### 5.2 First 50 epochs against base

Base 6b9e27cc (lifetime format with Track Q's reader) against this branch, on the same harness and settings; runs
in order: head window then head lifetime (one invocation, 00:33-00:45, load 11-35), then base (00:45-00:51, load
18-107). Medians over epochs 1-50 (ms):

| Measure               | Base (lifetime) | Head, window (pair) | Head, window (150-epoch run) | Head, lifetime (same tree) |
| --------------------- | --------------- | ------------------- | ---------------------------- | -------------------------- |
| Seal                  | 215             | 221                 | 251                          | 256                        |
| Adoption              | 601             | 617                 | 649                          | 665                        |
| Install               | 243             | 265                 | 267                          | 296                        |
| Creator issue         | 286             | 304                 | 345                          | 340                        |
| Recipient issue       | 22.8            | 23.5                | 24.4                         | 29.3                       |
| Creator admits remote | 371             | 361                 | 414                          | 425                        |
| Creator lull          | 1,931           | 1,972               | 2,235                        | 2,420                      |
| Recipient lull        | 918             | 926                 | 991                          | 1,070                      |

- The window format is within 0-10% of base on every transition in the paired run, and base's own format on this
  branch (head, lifetime; the same code as base) differs from base by 5-25%: the differences are run-to-run noise.
  In the first 50 epochs no message has left the window yet, so both formats hold the same messages and the same
  state bytes (824 at epoch 1, 28,389 at epoch 50), and the room's rows and bytes are identical in all four runs
  (creator 135 rows, 184,377 B at epoch 50).
- From about epoch 58 the lifetime format refuses every new message (Track T); the window format keeps taking 4
  per epoch (section 5.1).

### 5.3 IndexedDB size

- The room's databases are flat (above). The archive's own database holds what the census reports: 600 rows,
  177,480 bytes at epoch 150 (296 bytes per message), growing to its bound.
- The origin's usage (`navigator.storage.estimate()`, which counts IndexedDB's backing files, including data not
  yet compacted) grows in every run, with or without the archive. Over epochs 8-50: base's own format on this
  branch without an archive, creator +7.8 and recipient +5.0 KB per epoch; the window format with its archive,
  +9.9 and +5.4 KB per epoch (150-epoch run: +10.5 and +8.7). The archive accounts for about 1.2 KB of record
  bytes per epoch here; the rest is the room's own IndexedDB churn, the same without the archive. In the 150-epoch
  run usage reached 2.2 MB (creator) and 1.8 MB (recipient). Whether Chromium's compaction caps it was not run
  long enough to see; it is outside Chat (record it as a residual for the storage owners).

### 5.4 Second round (2026-10-21): 200 epochs, and the first 50 against base 760607d9

- **First 50 epochs:** base 760607d9, the 32 KiB window and the 64 KiB window started together, twice: within 5%
  of each other on every transition, with identical room rows and bytes (section 0.3 has the table).
- **The 32 KiB window, 200 epochs** (10:41-11:12, load 58-66, run alongside the 64 KiB room until that one failed
  at epoch 58; <evidence>/track-w/latency/chromium/long-w32-200-summary.txt, bin/chromium-steady.py): passed. The
  window is full from epoch 56. Medians per block of epochs, and the slope over epochs 56-200:

  | Measure              | e1-50   | e56-100 | e101-150 | e151-200 | Slope e56-200 |
  | -------------------- | ------- | ------- | -------- | -------- | ------------- |
  | State bytes          | 14,570  | 32,699  | 32,629   | 32,587   | -0.6 B        |
  | Creator rows         | 135     | 135     | 135      | 135      | 0             |
  | Recipient rows       | 128     | 128     | 128      | 128      | 0             |
  | Creator room bytes   | 156,629 | 193,703 | 193,777  | 193,629  | +0.5 B        |
  | Recipient room bytes | 154,819 | 192,029 | 192,139  | 191,984  | +0.8 B        |
  | Seal (ms)            | 335     | 321     | 330      | 312      | -0.05         |
  | Adoption             | 955     | 904     | 868      | 886      | -0.34         |
  | Install              | 437     | 427     | 399      | 379      | -1.03         |
  | Creator issue        | 488     | 481     | 474      | 465      | -0.10         |
  | Recipient issue      | 32      | 37      | 36       | 36       | +0.01         |
  | Creator lull         | 3,192   | 2,963   | 2,972    | 2,913    | -0.27         |
  | Recipient lull       | 1,461   | 1,306   | 1,333    | 1,267    | -0.61         |

  Lulls: `deferred:unsupported` twice (epochs 1-2), `not-needed` 3 times, `maintained` 395 times. Rows are constant
  and bytes flat; no transition grows with the room's age. This settles the first round's +1.7 ms per epoch
  adoption drift (section 5.1) as the machine, not the window. The creator's archive held 800 messages (237,080
  bytes) at epoch 200; the origin's usage grew 9.6 and 7.3 KB per epoch (creator, recipient), as in section 5.3.

## 6. The device archive: size and append cost

| Host and peer                                    | Messages | Record bytes | Database                                                                   | Writes                     | Cost per write | Per message | `observe` |
| ------------------------------------------------ | -------- | ------------ | -------------------------------------------------------------------------- | -------------------------- | -------------- | ----------- | --------- |
| Node SQLite, creator, 300 epochs                 | 1,200    | 170,720      | 4.6 MB file incl. WAL (316 KB after the reopen's checkpoint, 600 messages) | 299, about 4 messages each | 0.82 ms        | 0.21 ms     | O(1)      |
| Node SQLite, Writer 2, 100-message bound         | 100      | 14,300       | 4.2 MB file incl. WAL                                                      | 299                        | 1.48 ms        | 0.37 ms     | O(1)      |
| Chromium IndexedDB, creator, 150 epochs          | 600      | 84,920       | 600 rows, 177,480 B (census)                                               | 600, one per message       | 0.93 ms        | 0.93 ms     | 0.011 ms  |
| Chromium IndexedDB, Writer recipient, 150 epochs | 600      | 84,920       | 600 rows, 177,480 B (census)                                               | 600, one per message       | 1.24 ms        | 1.24 ms     | 0.010 ms  |

- **Off the critical path.** The projection callback only keeps a reference (`observe`, about 0.01 ms in Chromium);
  the write runs in a later task, one transaction per write, never on the seal, adoption, install or lull paths.
  In Chromium the write cost per 25-epoch block moves between 0.4 and 2.8 ms with the machine's load and has no
  trend with archive size (0.38, 0.62, 1.74, 0.61, 1.61, 0.58 ms on the creator).
- **Size.** About 296 bytes per message in IndexedDB (record, key and index), about 0.5 KB per message in a
  checkpointed SQLite file. At the approved default bound (2,000 messages or 1 MiB of records) that is about
  0.6 MB per room per device in IndexedDB. The SQLite file's WAL is SQLite's own (it reaches about 4 MB before
  its autocheckpoint and is truncated on close); the Node store is for tests and Node hosts, the page uses
  IndexedDB.
- **Bound.** Writer 2's 100-message archive holds exactly the newest 100 from epoch 25 on; every record it drops
  while the message is still in the window leaves a tombstone, which goes once the message leaves the window
  (unit tests check both, including across a reopen).
- **Write cost and archive size.** Each write does O(window) work plus building a set of the archive's sequence
  numbers (`kept`, O(archive), at most 2,000 entries under the default bound). That step is bounded but was not
  timed on its own; the runs here reached 1,200 (Node) and 600 (Chromium) records with no trend in write cost. It
  could be O(appended + evicted) instead. Left as measured.

## 7. Suites against base 6b9e27cc, per test

Reports: <evidence>/track-w/tests/suite-{base,head}-<set>.{log,json} (bin/suite.sh; vitest from the repository root
with `--exclude ".claude/**" --no-coverage`), compared per test with <evidence>/track-t/bin/vcompare.py
(root-compare.txt). Base ran 00:51-01:30 and this branch 01:32-02:10 on 2026-10-21, at d1adb6c0 (bb4516a3 after
the rebase onto main; the rebase added only a README commit). The branch's suite runs that were in flight at the
00:09 stop were rerun, not reused.

| Set                                                                                                                                   | Base passed/failed/skipped | Branch passed/failed/skipped | Per test                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ---------------------------- | -------------------------------------------------------- |
| Chat (8 files: Track W's 2 unit files, r9-chat-capacity-ledger, r9-chat-artifact-contract, phase-3h migration, Track M's 3 app files) | 11/0/12                    | 32/0/12                      | 0 new failures; 21 new tests (Track W's), all pass       |
| Six Canvas/Chat native tests (R9 Chat with the rebuilt version-3 catalog, as Track Q ran them)                                        | 35/15/0                    | 35/15/0                      | identical (the 15 failures predate this track)           |
| Storage-node retirement (7 files)                                                                                                     | 162/49/2                   | 162/49/2                     | identical                                                |
| packages/node                                                                                                                         | 1023/48/0                  | 1023/48/0                    | identical (two files fail to load on both sides)         |
| Root: 117 files (Track T's root set plus Track Q's 3; it holds the room and native tests of Tracks K, L, M, M2, N, O, P, S, T)        | 867/907/98                 | 869/905/98                   | 0 new failures; 2 base-only failures, both flaky (below) |
| Track Q's tests (canvas-chat-resource-bound, canvas-chat-creator-lull-native)                                                         | in root                    | 15/0/0 (also run alone)      | pass                                                     |
| Track W's native test (tests/chat-rolling-window-native.test.ts, 300 epochs)                                                          | fails to load (RED)        | 7/0/0                        | RED at base, green here                                  |
| Canvas and Chat e2e (playwright.canvas-chat.config.ts)                                                                                | 9/0                        | 9/0                          | identical                                                |

- `r9-chat-artifact-contract` fails to load on both sides (it needs `SHIPPING_CHAT_BUNDLE_DIR`, a compiler output
  directory; stale, as the map records).
- 559 of the root failures on both sides are `protocol-v3-current-registry-contract-d110c-red`: "protocol-v3
  freeze violation: accepted successor input drifted: packages/protocol-v3/formal/author-lineage-actions.qnt". It
  predates this track, which touches no protocol file.
- The two base-only failures: `phase-4c-snapshot-stream-red` "proves peak verifier ownership on 64 MiB" timed out
  in the base suite and passes alone at base; `d110c-0c1f5b0a-settlement-codec-red` "puts ACL membership …" throws
  `Cannot access '__vite_ssr_import_8__' before initialization` (its four concurrent dynamic imports race a module
  cycle): it failed alone at base twice and alone on this branch once of two runs. Neither is a fix.
- `pnpm -r typecheck`: exit 0, 0 errors (<evidence>/track-w/logs/typecheck-head-q.log).
  `node scripts/check-shadowed-sources.mjs`: exit 0 (logs/shadowed-head-q.log). The new product files have 0
  eslint errors.

### 7.1 Second round (2026-10-21)

The full suites were not rerun. After the revert, the branch's code is the first round's code plus the native
test's guard: `git diff dca097aa` at the final tip shows only tests/chat-rolling-window-native.test.ts and this
file. The bases moved by documents, Track U's startup-discovery fixtures and Track M's Playwright driver header
(kept on both sides), the owner's decision rows, Track Y (369420d0: three library in-memory cache ceilings
lowered, and measurement-only probe hunks in Track M's browser harness, which merged without a conflict) and Track X
(24d4ca61: the library's fixes for real-network settlement delivery, and a shipped-app harness). The
coordinator's verification of the branch merged on main, before the 64 KiB work, passed typecheck, the shadow guard,
every Chat, Canvas, Q, S, O and M2 test it ran, the Canvas/Chat e2e (9/9) and Track M's browser harness for Chat and
Canvas (2/2).

Every run in this round used node v22.15.0 and pnpm 10.24.0, as the first round did. At 14:07 something outside
this track moved fnm's default node to v22.23.4, which has no pnpm. The runs made with it (a build, a typecheck,
the shadow guard, and the first seconds of an e2e and a native run, 14:13-14:18) were set aside in
<evidence>/track-w/logs/node22.23.4-invalid/ and redone on v22.15.0, which every script now puts first on its PATH
and checks. Every paired comparison in this round ran before 14:07, so no pair mixes the two.

At the final tip, on 24d4ca61 (and on 369420d0 before Track X's merge, with the same results):

- `pnpm -r typecheck`: exit 0, 0 errors; `node scripts/check-shadowed-sources.mjs`: exit 0
  (<evidence>/track-w/logs/typecheck-24d4ca61.log, shadowed-24d4ca61.log; typecheck-369420d0.log,
  shadowed-369420d0.log; before these rebases, typecheck-final2.log, shadowed-final2.log).
- Unit: chat-rolling-window-rule 9/9, chat-local-archive 12/12, Track Q's canvas-chat-resource-bound 13/13
  (tests/unit-24d4ca61.log, unit-369420d0.log). Before these rebases the rule file's 40-round randomized test
  timed out once at 10 s in a combined run under load 250 and passed alone (tests/p3-unit.log,
  p3-unit-rule-alone.log).
- The native test's guard: `CHAT_WINDOW_EPOCHS=60` is refused before any epoch runs ("every member's share is full
  at epoch 77, and they need 100 steady epochs after it and more than 131072 bytes sent. Run at least 231
  epochs"), and so is `CHAT_WINDOW_EPOCHS=119 CHAT_WINDOW_PAD=400` ("... at least 120 epochs").
- The guard first asked for 50 steady epochs, as the test's own assertions did. At that minimum,
  `CHAT_WINDOW_PAD=400` with 70 epochs failed one assertion twice with identical bytes: the room stores' byte
  slope, 24.2 bytes per epoch against 16. The stores keep bounded oscillations (earlier snapshot generations
  catching up with a full window, counters widening), and a short series tilts with them. The first round's
  300-epoch data shows the same: 22-24 bytes per epoch over its first 50 steady epochs, at most 2.8 over 100 or
  more. So the test now needs 100 steady epochs (21cce8ed). That keeps 231 epochs at the default text length,
  makes 120 the minimum with `CHAT_WINDOW_PAD=400` (7/7 pass, slopes 10-11 bytes per epoch:
  tests/p3-native32-pad400-120.log), and makes both steady-length assertions stricter at 300 epochs.
- The native test at its default 300 epochs: 7/7 pass on 24d4ca61 (60 minutes;
  <evidence>/track-w/tests/node-300-24d4ca61.log) and on 369420d0 before Track X's merge (39 minutes;
  tests/node-300-369420d0.log). In both, the state, every store's rows and bytes, and the archives are identical
  to the first round's run (state 31,041-32,684 bytes; rows 175 and 145; store bytes +4.2-4.3 bytes per epoch;
  archives 1,200, 1,200 and 100 messages). On 369420d0 every transition's slope over epochs 71-300 is between -0.143 and +0.237 ms per epoch. On
  24d4ca61 the transitions are as fast as that over epochs 71-220 (adoption p50 574-964 ms), then all slow down
  together over epochs 221-300 (adoption 2,130 ms over 251-300): the follow-up issue, 30 ms of local work, slows by
  the same factor of about 3 as adoption, and the run's wall time per epoch went from 6.2 to 22-23 seconds as the
  machine's load rose from 189 to 270-280. That is the machine, not the room, which grows in nothing
  (latency/node-300-24d4ca61/windows.txt, load.tsv; latency/node-300-369420d0/windows.txt).
- Canvas and Chat e2e: 9/9 (<evidence>/track-w/logs/e2e-canvas-chat-24d4ca61.log; 9/9 on 369420d0 and before
  these rebases too, e2e-canvas-chat-369420d0.log, e2e-canvas-chat-final.log). One earlier attempt on 24d4ca61
  failed all 9 tests, Canvas included, because its relay could not listen on port 50002, which another worktree's
  Grid harness held (logs/port-races/); the port wait now checks the relays' ports too.
- **Real networking, with Track X's harness** (tests/track-x-shipped-app-long-room.pw.ts `-g "shipped chat page"`,
  playwright.track-x-shipped-app-long-room.config.ts: the shipped Chat page's own networking, two relays, libp2p
  gossip and direct streams; the creator writes through the page's UI and the shipped joiner is an observer):

  - 16 epochs x 2 messages, the harness's defaults: 16/16 (logs/trackx-chat-w32-16x2.log). Delivery 4-120 ms. From
    epoch 5 the creator's seal takes 2.3-3.0 s, the creator's settlement maintenance that Track X reports (3-9 s)
    for every shipped page. Room rows match Track X's shipped Chat on the lifetime format (creator 160, the
    observer 111) plus one archive row per message on each device: 192 and 143 at epoch 16, after 32 messages.
  - 30 epochs x 8 messages, so the window fills and evicts over real networking: 30/30
    (logs/trackx-chat-w32-30x8.log). The creator is the room's only member at creation, so its share is the whole
    window (32,527 bytes with the page's object id). At 176-177 bytes per message the window is full after 184
    messages and evicts from epoch 24 on (bin/trackx-window-fill.mjs), so the last 7 epochs push 56 messages out of
    the shared window. Every epoch the harness requires the observer's whole history (window and archive) to equal
    the creator's, and it did, 240 messages at epoch 30. From epoch 7 on, rows grow by exactly 8 per epoch on both
    devices, one archive row per message (the archive's bound is 2,000), before and after eviction alike; the rest
    is flat. Seal 3.2-4.2 s from epoch 5, adoption 1.0-1.8 s, install 1.5-2.2 s, delivery 3-121 ms, at load
    168-210.

- The `CHAT_WINDOW_PAD=400` 120-epoch run, the guard refusals and the Chromium runs (section 5.4: the six paired
  first-50 runs and the 32 KiB 200-epoch run, all passing) ran before the rebase onto 369420d0, on the same Chat
  code without Track Y's lower cache ceilings. The only failures in the second round are the 64 KiB rooms (section
  0), which this branch reverts.

## 8. Guarantees

No library code changed (nothing under packages/). The window is a new compiled blueprint that the library folds like
any other, the admission policy and the archive live in examples/chat, and every room mechanism (seal, adoption,
install, settlement, retirement, lulls) is the one Tracks K-T and Q already run.

- **G1 (flat with room age).** The shared state is at most 32,768 bytes forever and holds a bounded number of
  messages; the reducer's work per message is one pass over that window. Chat messages are ordinary operations whose
  issuance, journal and snapshot retention is the library's, so no room store gains a row per message or per epoch.
  The 300-epoch Node run shows it (section 4): state bytes, every store's rows and bytes, and every transition's
  latency flat from the first full window. In Chromium (section 5) rows, room bytes and state are flat over 150
  epochs; latency moves with the machine's load, within the swing a constant-state Canvas control shows. The
  archive is device data in its own database with its own bound; it is
  never read or written on the seal, adoption, install or lull paths (the projection callback only keeps a
  reference), and it is not part of any room census.
- **G2 (backpressure; accepted work finishable).** The per-epoch share is checked at reservation, before the
  operation is issued; a refused send keeps its text. Accepted work is never pushed out before its epoch is sealed
  (section 2), and displaced work re-fits in the next epoch because it was admitted under the same cap.
- **G3 (golden path).** Genuine seal, adoption, two installs and three lulls per epoch with the creator and two
  Writers, a persisted reopen of every peer and a crash of one Writer's archive; every peer's state digest equals
  the independent model's every epoch.
- **G5 (untrusted bytes).** Archive rows are decoded, re-captured and re-keyed on load; tampered rows are dropped and
  deleted (unit test). Room bytes are treated as before.
- **G7, G8 (one decision owner, no sweeper).** Which messages leave the window is decided by one owner, the reducer,
  from authenticated state; there is no sweeper, TTL or count-based deletion of protocol data. The archive's
  count/byte eviction deletes local display copies that are not protocol data and carry no authority; it is outside
  the protocol's retirement and grants nothing.
- **G14, G15, G16 (resumable, atomic, durable).** The room's are the library's, unchanged. Each archive write is one
  strict transaction (IndexedDB `durability: "strict"`, SQLite WAL + `synchronous=FULL`); a SIGKILL before or after
  its COMMIT leaves the old or the new archive (unit test with a real child process). The window is identical after
  a persisted reopen (native test).
- **G21 (bounded work, reviewed limits).** The window (32,768 bytes), the shares, the per-epoch cap and the archive
  bound were listed for review in section 3 with what the player sees; the owner approved the archive bound,
  first chose 64 KiB for the window, and after the library blocker chose to ship 32 KiB (section 0). **Track Q's
  ordinary resource bound stands**: its approved basis is that every Chat state passes Chat's own state check, whose limits are
  `SHIPPING_CHAT_CAPACITY_STATE_LIMITS` (32,768 bytes, 16,384 items, depth 16), and that the admission policy
  refuses anything that would exceed them. Under the window: the window's state check
  (`captureShippingChatWindowState`) encodes every state under exactly `SHIPPING_CHAT_CAPACITY_STATE_LIMITS`; the
  reducer never produces a state outside it (each member's window charge stays within the member's ceiling, and the
  ceilings plus the empty-state overhead fit in 32,768 bytes, the same overbooking check as version 3; a full
  window has a few thousand items and depth 4); the projection and migration re-capture every state; and the
  admission policy captures the joined window of every message reservation, every inherited state and every
  capacity allocation under those limits before admitting it. The limits did not change, so the bound did not.
- **G22 (reservation precedes effects).** Admission reserves a message's bytes against the member's per-epoch share
  before the operation is issued, joined and released exactly as in version 3 (no refunds: a released uncommitted
  reservation frees only its own entry). The resource bound is a planning value only: it grants no validity,
  admission, authority or credit, and the room re-checks every base under it.
- **G25 (authenticated format change).** The format is the blueprint digest the room's genesis signs: new rooms sign
  version 4, existing rooms keep version 3, and a version-4 room refuses a version-3 inherited state (reducer and
  policy), so the two formats never mix in a room and nothing migrates.
- **G26.** No safety check was relaxed for latency. The only latency-motivated choice is that the archive writes in
  a later task instead of inside the projection callback.
- **G27 (no carve-outs).** Everything is in examples/chat; the library folds the new blueprint like any blueprint and
  measures the room by the same census.
- **G28 (native evidence).** Node SQLite native runs (300 epochs; SIGKILL for the archive store) and Chromium runs
  on real IndexedDB (150 and 200 epochs, a Canvas control, and base against this branch over 50 epochs in two
  rounds), and the shipped page over real networking with Track X's harness (section 7.1). The 64 KiB attempt
  failed on both hosts at epoch 58 (section 0), which is why it is reverted. Firefox and WebKit were not run
  (residual, section 9).
- G4, G6, G9-G13, G17-G20, G23, G24: unchanged; no library change, and the archive is outside room custody.

## 9. What remains, and risks

- **A larger window is an open item, with no track planned** (section 0). Today's library caps a room's
  application state at 32,768 bytes, pinned by RED tests, so a 64 KiB window needs a library track first, and its
  resource bound (section 0.2) needs approval then. The owner chose to ship 32 KiB now; its values the code carries
  as constants (`SHIPPING_CHAT_RETAINED_BYTES` and the genesis split for the window,
  `SHIPPING_CHAT_ARCHIVE_DEFAULT_BOUND`, approved, for the archive).
- **No formal model of version 4.** `carriedChatCapacity` (author-lineage-actions.qnt, frozen) models the version-3
  lifetime ledger only. Version 4's rule is covered by the reducer's differential and randomized tests (40 seeded
  rounds of "nothing admitted leaves before seal") and the 300-epoch native run, not by a model. A model would add
  the window charge, own-oldest eviction and the per-epoch cap; that needs a new spec and a freeze-policy entry
  (governance work, not done here).
- **Version-3 rooms still stop.** Rooms created before this change keep the lifetime format and still refuse new
  messages near their lifetime capacity. Moving them would need a migration the owner chose not to have.
- **Known limit, follow-up track W2 after this merges (owner, 2026-10-21):** members added after creation get no
  share unless bytes are free, and a member who leaves keeps that member's last messages in the window (both as in
  version 3). Options are in section 3, item 6. If W2 changes the reducer's rules, the window's artifact digest
  changes.
- **The archive is per device.** A device misses messages that entered and left the window while it was not
  running, a late joiner starts from the window, and clearing site data clears the archive. Nothing syncs archives
  between devices (by design: the archive grants nothing and feeds nothing back).
- **The page's render** merges the window and the archive and sorts them on every projection: up to about 2,200
  rows at the default bound. It is UI-thread work that grows with the archive bound and was not measured here
  (the harnesses do not render).
- **Browsers:** Chromium only. Firefox and WebKit were not run (IndexedDB `durability: "strict"` is a hint some
  engines ignore; the archive's atomicity still holds per transaction).
- **examples/v3-chat** (the demo Chat, Track V's area, not touched here) still keeps lifetime history with
  `state.push`; it needs the same treatment if it is ever shipped. Follow-up for Track V or a later track.
- **Track M's app harness** now measures Chat's window format by default (`TRACK_M_APPS_CHAT_FORMAT=lifetime`
  restores the old measurement), so its Chat numbers before and after this track are different formats.
- **Track Q's canvas-chat-lull harness** composes Chat from the version-3 catalog, so its Chat numbers remain
  version-3 numbers; this track's Node harness (tests/fixtures/chat-rolling-window/) measures version 4.
- **Chromium latency over a long room.** In the first round's 150-epoch run adoption, install and the creator's
  lull drifted up 10-15% after epoch 100 while the load fell. The second round's 200-epoch run has every slope zero
  or negative over epochs 56-200 (section 5.4), so the drift was the machine.
- **The origin's IndexedDB usage** (`navigator.storage.estimate()`) grows 5-11 KB per epoch per role in every
  Chromium run, with or without the archive, while the room's rows and bytes are flat: backing-store data awaiting
  compaction, outside Chat. No run was long enough to see whether compaction caps it.
- **Real networking.** The long Chromium runs relay rows through the harness. The shipped page's own networking
  ran in the e2e tests (9/9) and, on 24d4ca61 with Track X's fixes, in Track X's shipped-app harness (section 7.1),
  which is short (16 and 30 epochs) and has an observer, not a Writer, as the joiner.
- **Archive write cost** includes one O(archive) step (`kept`, at most 2,000 entries at the default bound); it could
  be O(appended + evicted). Left as measured.

## Files and functions touched

Nothing under packages/ changed. Every version-3 file (examples/chat/capacity-blueprint/\*, chat-catalog-material.json,
v3-chat-capacity.ts, v3-chat-message.ts) is byte-identical. Track Q's `resourceDataRecord` and `resourceBoundBases`
are unchanged.

**New, examples/chat**

- `window-blueprint/blueprint.ts`: the version-4 reducer. Functions `denseArray`, `exactKeys`, `captureMessage`,
  `varintBytes`, `utf8Bytes`, `recordBytes`, `captureCapacity`, `ceilingOf`, `chargeOf`, `fitShare`, `captureState`,
  `capacityAllocationReducer`, `migrationRecordReducer`, `migrationActivationReducer`, `messageReducer`,
  `applicationBatchReducer`, `causalJoinReducer`, `aclReducer`.
- `window-blueprint/blueprint.json`: the blueprint package (derived from version 3's: new artifact id
  `v3-shipping-chat.v4`, same operation shapes).
- `src/chat-window-catalog-material.json`: the compiled version-4 catalog (generated; digest b0bb30c5…7560).
- `src/chat-catalogs.ts`: `ShippingChatCatalog`, `ShippingChatCatalogs`, `decodeBase64`, `openEmbedded`,
  `openShippingChatCatalogs` (both catalogs, opened once).
- `src/v3-chat-window.ts`: `SHIPPING_CHAT_WINDOW_ARTIFACT_ID`, `ShippingChatWindowState`,
  `ShippingChatResourceBoundBases`, `shippingChatRecordBytes`, `captureShippingChatWindowState`,
  `shippingChatWindowStateBytes`, `restoreShippingChatWindowState`, `createShippingChatWindowGenesisStateBytes`,
  `fitShare`, `applyMessage`, `reallocateShippingChatWindowCapacity`, `createShippingChatWindowAdmissionPolicy`,
  `createShippingChatWindowApplication` (with its `readOrdinaryApplicationResourceBound` and `project`), and the
  local helpers `record`, `integer`, `dense`, `objectId`, `identityOf`.
- `src/v3-chat-archive.ts`: `SHIPPING_CHAT_ARCHIVE_DEFAULT_BOUND`, the types `ShippingChatArchiveBound`,
  `ShippingChatArchiveStoredRow`, `ShippingChatArchiveStore`, `ShippingChatArchiveRecord`,
  `ShippingChatArchiveStats`, `ShippingChatLocalArchive`, `ShippingChatHistoryMessage`;
  `shippingChatArchiveDatabaseName`, `restoreRow`, `openShippingChatLocalArchive` (`observe`, `flush`, `records`,
  `discard`, `stats`, `close`), `shippingChatHistory`, `openBrowserShippingChatArchiveStore`; helpers `hex`,
  `identityOf`, `contentOf`, `keyOf`, `TOMBSTONE_KEY`.
- `src/v3-chat-archive-sqlite.ts`: `openNodeShippingChatArchiveStore` (Node only; not imported by the page).

**Changed, examples/chat**

- `src/v3-chat-application.ts`: `createShippingV3ChatApplication` dispatches a window-catalog entry to
  `createShippingChatWindowApplication(input, resourceBoundBases)` (3 lines); `ShippingChatProjection` gains an
  optional `epoch`; re-exports of the window module.
- `src/index.ts`: module scope (`catalogs` replaces the single catalog; `archive`), `render` (merged history; class
  `archived` and a title on archive-only rows; same display order as before, by display time, author, identity, now
  in code-unit order instead of `localeCompare`), `openChat` (format choice: create signs the window format; join
  authenticates the invite against the window catalog, then the lifetime catalog, through a local `authenticate`;
  opens the device archive before the room, observes every projection, closes it on failure), `main`'s unload
  handler (closes the archive).

**Tests (new)**

- `tests/chat-rolling-window-native.test.ts` (7 tests), `tests/chat-rolling-window-rule.test.ts` (9),
  `tests/chat-local-archive.test.ts` (12), `tests/fixtures/chat-rolling-window/chat-long-room.ts` (the Node SQLite
  long room: creator and two Writers, genuine seal/adoption/install/lull, persisted reopen, archive crash),
  `tests/fixtures/chat-rolling-window/archive-crash-child.ts` (the SIGKILL child).
- Changed after the RED commit, in Track W's own new tests only: `chat-local-archive.test.ts` (the count-bound case
  observed one window per message, but the archive keeps only the latest projection by design, so the case now
  observes a growing window; two regression tests added for the tombstone rule), `chat-rolling-window-rule.test.ts`
  (one test added for Track Q's bound), `chat-rolling-window-native.test.ts` (archive measurement fields), and
  `chat-long-room.ts` (the exported snapshot payload is the concatenation of its chunks).
- Second round, `tests/chat-rolling-window-native.test.ts`: `WINDOW_BYTES`, `STEADY_EPOCHS` (100) and
  `shortestRun` (the shortest run the assertions hold for, from the genesis shares and the messages the run sends);
  `runChatWindowRoom` refuses a shorter `CHAT_WINDOW_EPOCHS` with a `RangeError` naming the length it needs; the
  two steady-length assertions use `STEADY_EPOCHS` (100, was 50), and one assertion is added (a full window fills
  the budget to within one largest message per member). The 64 KiB values in
  this file and in `chat-rolling-window-rule.test.ts` (bebb3d95) are reverted with the product (ec14c306).

**Measurement harness (Track M's, extended; no assertion changed)**

- `tests/fixtures/track-m-apps/long-room-driver.ts`: `ChatFormat`, `LongRoomOptions.chatFormat`,
  `ArchiveObservation`, `RoleEndpoint.archive`, `RoleEndpoint.storageUsage` (optional), `EpochRecord.archive`,
  `EpochRecord.stateBytes` and `EpochRecord.originUsage`, `labelOf` (adds `-lifetime`), `driveLongRoom` (records
  state bytes, archive stats and origin usage each epoch).
- `tests/fixtures/track-m-apps/long-room-core.ts`: `RoleEnvironment.openArchive`, `applicationFor` (format
  choice through `openShippingChatCatalogs`; replaces the local `chatCatalog`), `openRole` (opens the archive before
  the room, observes each projection with timing, `archive()` and `storageUsage()` endpoints, closes it).
- `tests/fixtures/track-m-apps/browser/entry.ts`: `openArchive` (its own IndexedDB database per role, with census).
- `tests/fixtures/track-m-apps/browser/long-room.pw.ts`: `TRACK_M_APPS_CHAT_FORMAT` (default `window`), `archive`
  and `storageUsage` in the proxied methods.

The harness now measures the window format by default for Chat; `TRACK_M_APPS_CHAT_FORMAT=lifetime` measures the
version-3 format.

## Commits

On track-w-chat-rolling-window, based on main (codex/phase3a1b-p6-golden-path) 24d4ca61. The branch was first
built on 6066c539 and rebased onto main 725f291b, 760607d9, af342318, 369420d0 and 24d4ca61. The bases between 725f291b and
af342318 changed no code under test here (a README commit; Track U's startup-discovery fixtures and Track M's
Playwright driver header, kept on both sides; the owner's decision rows). 369420d0 adds Track Y: three library
in-memory cache ceilings lowered (packages/node, protocol-v3, storage) and measurement-only probe hunks in Track M's
browser harness, which git merged with this branch's harness hunks without a conflict (this branch's changed lines
there are identical before and after the rebase). 24d4ca61 adds Track X: library fixes for the settlement fence
delivery stall (a recipient asks the creator again for a missing dependency; a direct send that never completes
cannot hold a room; the issuance census classifies a migrated Writer's inherited plan) and a shipped-app long-room
harness that drives the shipped Chat page (tests/track-x-shipped-app-long-room.pw.ts). Both rebases applied without
a conflict. The final checks in section 7.1 ran on 24d4ca61.

1. f9853e92 test(track-w): RED for Chat's rolling window and device archive (fails at base on the missing
   modules: <evidence>/track-w/tests/red-at-base.log)
2. d858f67b Chat: new rooms keep a rolling window; each device keeps an archive
3. e90b3d39 test(track-m): measure Chat's window format and device archive
4. 07487efb Chat: the window format states Track Q's resource bound
5. bd5dbe3f test(track-m): record each role's origin storage usage for every app
6. dca097aa docs: record Track W, Chat's rolling window and device archive (the first round's RESULT.md)
7. bebb3d95 test(track-w): RED for the 64 KiB window and its own resource bound (the rule test failed 4 tests at
   32 KiB: <evidence>/track-w/tests/p2-red-rule.log)
8. d332bf4d Chat: the window format keeps 64 KiB per room, with its own limits
9. ec14c306 Revert the 64 KiB window: the room caps application state at 32 KiB (the tree equals commit 6's)
10. 990076f2 test(track-w): the native test refuses a run too short for its assertions
11. 21cce8ed test(track-w): the native test's flatness slope needs 100 steady epochs
12. This RESULT.md.

Earlier ids, which the evidence logs name: commits 1-5 were 0b3fe706, e5926052, b3b84fcc, 436549e1 and d1adb6c0 on
6b9e27cc (the first round's Node 300-epoch run and 150-epoch Chromium runs ran at 436549e1, its paired Chromium runs
and suites at d1adb6c0); commits 1-6 were 8431cc42, cb59b05f, f6faf811, 54a5197b, bb4516a3 and 2629e63b on
725f291b; commits 1-10 were 89fc75d2, ea966e4a, 859728b4, 5bae021e, ba663124, 3531a4fd, 7603d9df, a8135c4d,
a6906ef4 and 6527bf46 on 760607d9 (the second round measured 3531a4fd's and a8135c4d's code); commits 1-11 were
a40b92e2, ced7bc26, a136b334, 417c2e45, 75c81864, 8e65db23, f2315cd7, 0881b9c9, efa3c532, 488010ac and e2d22e9c on
af342318, and f8f885d1, f1a1ae06, 37614925, a3fb69ee, feccbf9e, 641922ab, 19d37857, 921d2ef0, 0864add1, a7cd6495 and
da9c8883 on 369420d0.
