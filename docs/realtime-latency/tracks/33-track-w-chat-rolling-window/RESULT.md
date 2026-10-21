# Track W: Chat's rolling window and the device archive

Worktree: <worktree agent-a9b9982b4fd998b37>/
Branch: track-w-chat-rolling-window, on main 725f291b (6b9e27cc with Track Q 46eb7821, plus one README commit);
first built on 6066c539 and rebased on the coordinator's request. Measured and compared against base 6b9e27cc.
Commits: see "Commits" at the end. Evidence: <evidence>/track-w/ (PROGRESS.md, MAP.md, DESIGN.md, bin/, logs/,
tests/, latency/, chromium/, bp/).

Shipped Chat kept every message in its replicated state against a lifetime share of a 32 KiB budget, so a busy room
refused new messages for good (Track T: near epoch 57 at 4 messages per epoch). The owner chose "window + local
archive": the shared state keeps a rolling window of recent messages, and each device keeps the messages it has seen
in a local archive. This track builds that for new rooms.

## Summary

- **What changed.** New Chat rooms sign a new state format (version 4, artifact `v3-shipping-chat.v4`): the shared
  state is a rolling window of each member's newest messages that fit that member's share of 32,768 bytes, and a
  member's new message pushes out only that member's own oldest message. Each device keeps the messages it has
  seen in a local archive (its own database, 2,000 messages or 1 MiB per room, proposed), and the page shows the
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
- **Chromium, 150 epochs:** room rows (135/128) and bytes flat, state flat at the window; latency moves with the
  machine's load (adoption 626-797 ms per block, +1.7 ms per epoch over epochs 60-150), within the swing of a
  constant-state Canvas control run on the same harness. **First 50 epochs against base:** within 0-10% on every
  transition, inside the run-to-run noise (base's own format on this branch differs from base by 5-25%).
- **Archive:** the projection callback does an O(1) `observe` (0.01 ms); one strict transaction per write in a later
  task, 0.4-2.8 ms per write in Chromium (no trend), 0.2-0.4 ms per message on Node; 296 bytes per message in
  IndexedDB. The origin's IndexedDB usage grows about 5-8 KB per epoch per role without the archive too; the
  archive adds about 1.2 KB of records per epoch until its bound.
- **Track Q's resource bound stands:** window rooms supply the same reader with the same value (32,768 bytes,
  16,384 items, depth 16), and every window state passes Chat's state check under exactly those limits.
- **Suites against base, per test:** no new failure in any set (Chat, the six Canvas/Chat native tests,
  storage-node retirement, packages/node, the 117-file root set with Tracks K-T and Q, and the Canvas/Chat e2e);
  Track W's 21 unit tests and 7 native tests are new and pass. `pnpm -r typecheck`: 0 errors.
  `node scripts/check-shadowed-sources.mjs`: exit 0.
- **For owner review:** the window and shares (unchanged values, new meaning), the per-checkpoint sending limit,
  and the archive bound (section 3).

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
oldest first (proposed). A record the bound drops while its message is still in the window leaves a tombstone row
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

## 3. Limits for owner review (proposed, not approved)

1. **The shared window: 32,768 bytes per room.** Unchanged from today's cap, and the same value Track Q's approved
   resource bound rests on. What it is: the newest messages every peer carries and every checkpoint signs. Why:
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
5. **Device archive: 2,000 messages or 1 MiB per room per device, oldest dropped first.** What the player sees:
   this device's history beyond that is gone from this device; clearing the site's data clears it.
6. Unchanged and flagged: members added after creation get no share unless bytes are free (as in version 3); a
   departed member's last messages stay in the window. Options: a share for late members (smaller genesis split or
   rebalancing), letting unused shares be borrowed, or an age horizon.

Track Q's resource bound does not change: the window keeps every state within the same limits (section 8), so the
approved basis still holds and there is nothing new to review there.

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
  checkpointed SQLite file. At the proposed default bound (2,000 messages or 1 MiB of records) that is about
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
  bound are listed for review in section 3 with what the player sees. **Track Q's ordinary resource bound stands**:
  its approved basis is that every Chat state passes Chat's own state check, whose limits are
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
  on real IndexedDB (150 epochs, a Canvas control, and base against this branch over 50 epochs). Firefox and
  WebKit were not run (residual, section 9).
- G4, G6, G9-G13, G17-G20, G23, G24: unchanged; no library change, and the archive is outside room custody.

## 9. What remains, and risks

- **Owner review** of the limits in section 3 (window, shares, the per-checkpoint sending limit, the archive bound).
  Until then they are proposals; the code carries them as constants (`SHIPPING_CHAT_RETAINED_BYTES` and the genesis
  split for the window, `SHIPPING_CHAT_ARCHIVE_DEFAULT_BOUND` for the archive).
- **No formal model of version 4.** `carriedChatCapacity` (author-lineage-actions.qnt, frozen) models the version-3
  lifetime ledger only. Version 4's rule is covered by the reducer's differential and randomized tests (40 seeded
  rounds of "nothing admitted leaves before seal") and the 300-epoch native run, not by a model. A model would add
  the window charge, own-oldest eviction and the per-epoch cap; that needs a new spec and a freeze-policy entry
  (governance work, not done here).
- **Version-3 rooms still stop.** Rooms created before this change keep the lifetime format and still refuse new
  messages near their lifetime capacity. Moving them would need a migration the owner chose not to have.
- **Members added after creation** get no share unless bytes are free, and a member who leaves keeps that member's
  last messages in the window (both as in version 3). Options are in section 3, item 6.
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
- **Chromium latency over a long room.** In the 150-epoch run adoption, install and the creator's lull drifted up
  10-15% after epoch 100 while the load fell; one run cannot separate that from the machine (the Canvas control
  swung more), and nothing in Chat's code grows with room age. A paired, repeated long run on a quiet machine, or
  Track U's heap attribution, would settle it.
- **The origin's IndexedDB usage** (`navigator.storage.estimate()`) grows 5-11 KB per epoch per role in every
  Chromium run, with or without the archive, while the room's rows and bytes are flat: backing-store data awaiting
  compaction, outside Chat. No run was long enough to see whether compaction caps it.
- **Real networking.** The Chromium runs relay rows through the harness; the shipped page's own networking ran only
  in the e2e tests (9/9). Track X's settlement delivery stall is known on main and was not exercised here.
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

On track-w-chat-rolling-window, based on main 725f291b (6b9e27cc, which includes Track Q 46eb7821, plus one README
commit). The branch was first built on 6066c539 and rebased twice; the measurements and suites ran on the same
product code at 6b9e27cc (the README commit changes no code).

1. 8431cc42 test(track-w): RED for Chat's rolling window and device archive (fails at base on the missing
   modules: <evidence>/track-w/tests/red-at-base.log)
2. cb59b05f Chat: new rooms keep a rolling window; each device keeps an archive
3. f6faf811 test(track-m): measure Chat's window format and device archive
4. 54a5197b Chat: the window format states Track Q's resource bound
5. bb4516a3 test(track-m): record each role's origin storage usage for every app
6. This RESULT.md.

Before the rebase onto main the same commits were 0b3fe706, e5926052, b3b84fcc, 436549e1 and d1adb6c0; the
evidence logs name those ids (the Node 300-epoch run and the 150-epoch Chromium runs ran at 436549e1, the paired
Chromium runs and the branch's suites at d1adb6c0).
