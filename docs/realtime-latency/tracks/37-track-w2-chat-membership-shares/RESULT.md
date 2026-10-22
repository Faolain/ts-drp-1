# Track W2: shares for late members and the bytes of members who leave (Chat v5)

Worktree: <worktree agent-a9b9982b4fd998b37>/
Branch: track-w2-chat-membership-shares, rebased onto main (codex/phase3a1b-p6-golden-path) 30cb474e (Track X's
startup order and readiness ingress hold); built first on ebf4254f (Track X's seal deadlock fix). Decision rows 43
and 56. Measured against base 30cb474e. Evidence: <evidence>/track-w2/ (PROGRESS.md, OPTIONS.md, bin/, logs/,
tests/, latency/). Commits: see "Commits" at the end.

Track W gave shipped Chat a rolling window: each genesis Writer keeps its newest messages within an equal share of
32,768 bytes. Two gaps remained. A member who joins later has no share, so it cannot send. The bytes of a member who
leaves stay booked for good. The owner chose "guarantee and borrow" (OPTIONS.md, section 0) with `N_max` = 16, lazy
release of departed members' bytes (oldest first, before anyone else's surplus), a new artifact
`v3-shipping-chat.v5` beside v4, and a minimal grant control on the shipped page. This track builds that.

## Summary

- **Built as chosen, with no library change.** New rooms sign `v3-shipping-chat.v5`. Each of up to 16 holders is
  guaranteed an equal split of the 32 KiB window and may borrow what others leave unused. A departed member's
  messages leave only when space is needed, oldest first, before anyone else's surplus. Each holder may add
  A = 1,954 bytes per checkpoint. v3 and v4 rooms are unchanged. The rule is in the compiled reducer; the share
  update is an admin operation whose rows are a pure, idempotent formula of the rows and the latched ACL.
- **The test the owner named holds** (C5, pinned on base first): someone outside a checkpoint's ACL cannot have work
  admitted in it, so the fallback was not needed. The RED the owner asked for passes: a share update that misses its
  checkpoint expires under its identity, and the admin carries on.
- **The shipped page** gets a minimal Make Writer / Revoke Writer panel for the admin, built on the library's grant
  and revoke operations. A granted joiner can send from the checkpoint after its share update. Its first Send
  reopens the device as a Writer, and the message is accepted in 141-203 ms on real networking.
- **Proof.** Unit tests 20/20. A native 300-epoch room with two joins, two leaves and a mid-epoch crash passed 4/4,
  twice: every peer's digest equals the creator's every epoch, and state, window and stores stay flat. Each revoked
  member's 33 messages left first over 11-12 epochs. The real-network membership spec passes; a late joiner is
  granted and speaks, and the revoked member's bytes are reclaimed when space is needed. Track X's harness passed
  16/16 twice and 30/30 with more messages than the window holds. Track M's Chromium pair over 80 epochs shows no
  format cost against v4. Canvas/Chat e2e 9/9. Typecheck 0 errors.
- **Suites against 30cb474e:** 0 differences in the chat, native6 and Track X sets; 1 in the root set, a load timeout at
  base that passes alone there. `pnpm -r typecheck` 0 errors; the shadow guard exits 0.
- **Remains:** a device must have followed the previous checkpoint before it can become a Writer, and a revoked
  member's page stops following. Lifting either needs a library change (section 6).

## 1. The rule, and why it is deterministic and bounded

### 1.1 The rule as shipped

The v5 state is `{version: 5, messages, capacity}`. `messages` is the window, oldest first. `capacity` is
`{version: 2, basisObjectId, allowanceBytes, windowBytes, allocations}`, where each allocation row is
`[author, guaranteeBytes, sinceEpoch]`, at most 16 rows, sorted by author.

- **Budget.** `windowBytes` = W(n) = 32,768 − 2 − the encoded size of an empty v5 state with n rows at their widest
  values. With the shipped basis (85 characters): W(1) = 32,483, W(2) = 32,402, W(3) = 32,321, W(16) = 31,268. Each
  row costs 81 bytes of budget.
- **Allowance.** `allowanceBytes` = A = floor(W(16) / 16): 1,954 bytes with the shipped basis (1,957 for a 40-character
  basis, 1,895 for the 1,024-character maximum). A is fixed for the room's life. It is what each holder may add per
  checkpoint, and the largest message (a 20-character message is 183 bytes, so about 10 messages per checkpoint).
- **Guarantee.** Each holder's `guaranteeBytes` is an equal split of W(n) among the n rows (remainder to the first rows
  in author order). Because n ≤ 16, every guarantee is at least A.
- **Borrowing and reclaim (in the compiled reducer).** A message is appended. While the window's message bytes exceed
  `windowBytes`: if any message's author has no row (a departed member), the oldest such message leaves; otherwise
  the oldest message of an author whose charge exceeds its guarantee leaves. Nothing leaves while the window fits.
- **Share update.** One `capacityAllocation` operation `{capacity, epoch, aclDigest}` per checkpoint whose latched ACL
  changed membership. Its rows are a pure function of the current rows and the checkpoint's latched ACL: keep the
  rows of ACL members, add a row for each ACL Writer without one (author order, while there are fewer than 16 rows)
  with `sinceEpoch` = the ACL's epoch + 1, drop rows of authors absent from the ACL, split equally. The formula reads
  no messages and is idempotent. The reducer applies the rows and runs the reclaim.
- **Genesis.** The first 16 genesis Writers get rows from checkpoint 0.
- **Admission (the policy, per checkpoint).** A message is admitted when its author has a row in the checkpoint's
  base with `sinceEpoch` ≤ the checkpoint, and the author's distinct messages admitted in this checkpoint total at
  most A canonical bytes (exact retries of window messages count too). A share update is admitted only from an admin
  of the checkpoint's ACL, for that checkpoint's epoch and ACL digest, with exactly the formula's rows; a second copy
  is a no-op. A share update is not charged to anyone's allowance.
- **When a share update misses its checkpoint.** The application's `displacementPolicies` is
  `{capacityAllocation: "expire", message: "rebase"}`, and `displacedOperationIdentity` names the update `capacity:<epoch>:<aclDigest>`. A displaced update
  therefore expires, with an identity, instead of being rebased, and the admin's session carries on (RED: room test
  (a), rule test "the application expires a share update that misses its checkpoint"). The admin's page computes
  and issues the update again for the next checkpoint.

### 1.2 Why it is deterministic

- **Order independence within a checkpoint.** Admission depends only on the checkpoint's base (rows and `sinceEpoch`)
  and the author's own running total, never on other authors' messages or on arrival order. The share update's
  content depends only on the base rows and the latched ACL, so every admissible copy is identical.
- **Nothing admitted in a checkpoint leaves before that checkpoint is sealed.** An author's messages admitted in one
  checkpoint total at most A, and A ≤ every guarantee. The reclaim takes a departed author's message first, and
  otherwise the oldest message of an author above its guarantee; such an author's oldest message is from an earlier
  checkpoint. A share update in the checkpoint keeps every guarantee ≥ A, and it removes rows only of authors absent
  from the ACL, who cannot have work admitted in that checkpoint (C5, below). So "a message admitted between two
  checkpoints is in the next signed checkpoint" holds with joins and leaves (rule test "nothing admitted in a
  checkpoint leaves the window before it is sealed, with joins and leaves, in any interleaving").
- **C5: a departed author has no work admitted in a checkpoint whose ACL lacks it.** Pinned first, on base, before any
  product change (commit 898bcdd1, tests/track-w2-departed-admission.test.ts): a member revoked at epoch 1 gets
  nothing admitted in epoch 1, whether its displaced message arrives after the seal or after the adoption; it cannot
  install the successor; a member that loses only `writer` (keeps `admin`) stays a member and gets no new work
  admitted. The fallback (rows stay booked until new-incarnation evidence) was therefore not needed.
- **The rule lives in the compiled reducer.** Every peer folds the same bytes; journal replay, crash replay and the
  creator's closed-postimage transcript check accept what was admitted. A differential test folds 30 random rooms
  through the compiled reducer and an independent model.

### 1.3 Why it is bounded

- Every v5 state encodes within 32,768 bytes: at most 16 rows, at most W(n) bytes of message records, and W(n) is
  derived from the widest encoding of the rows (rule test "the state refuses what the format forbids").
- Each holder adds at most A bytes per checkpoint, so displaced or offline work always fits again when it is rebased
  (the allowance never falls).
- Track Q's ordinary resource bound is stated for v5's own catalog entry ({32,768 bytes, 16,384 items, depth 16}), and
  every v5 state passes Chat's state check under exactly those limits (rule test "states Track Q's ordinary resource
  bound for its own catalog entry and v5 states only").
- No per-checkpoint cost while membership is stable: one admin operation in the checkpoint after each membership
  change, and nothing otherwise.

## 2. What changed

Nothing under packages/ changed, and no dist changed. The settlement profile stays `creator-trusted-settlement-v1`.

- **examples/chat/shares-blueprint/** (blueprint.ts, blueprint.json): the v5 compiled reducer (`message`,
  `applicationBatch`, `capacityAllocation`, `acl`, `causalJoin`, `migrationRecord`, `migrationActivation`).
- **examples/chat/src/chat-shares-catalog-material.json**: the embedded single-blueprint catalog for
  `v3-shipping-chat.v5` (artifact digest e500af00…cae3a, blueprint digest f9aba9c0…847349) with its lint evidence,
  admission package and conformance receipt.
- **examples/chat/src/v3-chat-shares.ts**: the state capture, budget and allowance, the share formula
  (`shareShippingChatWindow`), `shippingChatShareUpdate`, the admission policy, the displacement policies and
  identity, and the application.
- **examples/chat/src/chat-catalogs.ts, v3-chat-application.ts**: a third catalog, `shares`, and dispatch by the
  artifact the room's genesis signed. v3 and v4 rooms open exactly as before; nothing migrates.
- **examples/chat/src/index.ts, index.html**: the page (section 3).
- **Tests**: tests/track-w2-departed-admission.test.ts (C5, 3 tests), tests/track-w2-chat-shares-rule.test.ts (14),
  tests/track-w2-chat-shares-room.test.ts (3, native SQLite rooms), tests/track-w2-chat-shares-native.test.ts (4,
  the 300-epoch room), tests/track-w2-shipped-chat-membership.pw.ts (the shipped page on real networking, with
  playwright.track-w2-chat-membership.config.ts), the fixture tests/fixtures/chat-membership-shares/room.ts, and a
  `shares` format in Track M's harness (tests/fixtures/track-m-apps/, `TRACK_M_APPS_CHAT_FORMAT=shares`).

**Digest change.** New rooms sign a different genesis blueprint digest (v5's), so a new room's genesis, state and
every checkpoint digest differ from a v4 room's. The state digest of a v5 room covers the share rows (author,
guarantee, since) and the fixed allowance and budget, besides the window. Every peer's state digest equals the
creator's and an independent model's at every epoch of the native room (section 5.2). v3 and v4 catalogs, artifacts,
states and digests are unchanged byte for byte; Track W's tests were not edited.

## 3. The page: what a player sees

- **Everyone** sees a "Your author ID" row (64 hexadecimal characters, selectable), so a joiner can give it to the
  room's admin.
- **The admin** (the creator; the panel shows only on a page that can send and whose author is an admin of the
  current ACL) gets a "Make Writer" / "Revoke Writer" panel with one input for the member's author ID. It issues the
  library's existing ACL operation (`{action: "acl", kind: "grant" | "revoke", group: "writer", target}`), refuses a
  malformed ID or the admin's own, and says: "Writer granted from the next checkpoint; the member can send once its
  share is in force." or "Writer revoked from the next checkpoint; the member's messages stay until the window needs
  the space." The admin's page then issues the share update by itself in the checkpoint where the change takes
  effect (once per epoch and ACL digest; after a refusal it retries 3 s later).
- **A joiner** opens receive-only, as before ("Connected as an observer; this chat is read-only."), sees the whole
  window, and the message box is closed with the reason beside it:
  - not a Writer: "Read-only. To send, ask the room's admin to make your author ID a Writer.";
  - a Writer without a share yet: "You are a Writer; waiting for the admin's page to give you a share of the window.";
  - a share from a later checkpoint: "You are a Writer; you can send from checkpoint N (now M)."
- **When the share is in force** the box opens. On the first Send the page says "Opening this device as a Writer…",
  reopens the same databases as a Writer (reusing the open room's authority), and issues the message at once
  (141-203 ms on real networking, section 5.3). The device is remembered as a Writer replica, so a reload opens it as a
  Writer directly. If the reopen fails, the page goes back to following the room, keeps the text and says "This
  device can send after it has followed the room through a whole checkpoint. Your text is kept."
- **A revoked member** keeps its messages in everyone's window until the window needs the space; then they leave
  first, oldest first, before any other member's surplus. Its own page stops following at the next checkpoint (section
  6, residual 2).
- **v3 and v4 rooms** keep their rule (genesis Writers only); a joiner there sees "Read-only: this room's format admits
  its genesis Writers only."

## 4. The library constraint for late joiners, and the page flow that needs no library change

A Writer's replica that has not followed the previous checkpoint cannot open or install. In
packages/node/src/v3-live.ts (around line 13804), the predecessor-epoch recovery of a non-receive-only replica fails
("v3 recovery issued record chain is empty") when the replica has no own records in that epoch, no historical
issuance, and no journalled vertex; any journalled vertex, own or received, counts, and `returningPredecessor` covers
only the admission epoch. A joiner's share starts one checkpoint after the share update, so it cannot issue in its
admission checkpoint, and a joiner reopened as a Writer at its admission checkpoint fails its next install
(<evidence>/track-w2/tests/debug-late-4..12.log; probe in trash/w2-debug-late.test.ts).

What works without a library change, and what the page does: follow receive-only, live, until the share is in force
(the creator issues a control row every checkpoint, so the journal is never empty while the device follows); reopen
as a Writer only on Send, then issue at once. After the first issue the replica has its own history and survives
quiet checkpoints and restarts (room test (b): two quiet checkpoints and a reopen, then it speaks again). The room
test (b) and the fixture's `promote` option state this flow; the fixture creates the signing store on the first
Writer open, as IndexedDB does in the browser.

## 5. Proof

### 5.1 The C5 pin, the RED tests and the unit tests (20 tests)

Order of work: the C5 pin first (898bcdd1, passes on base), then the RED tests (0a6a9f75, 17 tests, failing on base
for the missing v5 module), then the product (7db273d4). At the tip all 20 pass, the three files together with exit 0
(<evidence>/track-w2/tests/suite-h30-w2.log); before the rebase each file alone, 3, 14 and 3 tests, exit 0
(tests/w2file-1..3.log):

- tests/track-w2-departed-admission.test.ts (3): C5 (section 1.2).
- tests/track-w2-chat-shares-rule.test.ts (14): the format, genesis, share formula (joins from the next checkpoint,
  departed rows dropped, custodians kept, idempotent), borrowing, departed-first reclaim, exact retries, admission
  per checkpoint in any order with replay, refusal of a Writer without a share or before its first checkpoint, share
  update admission (admin, own epoch and ACL, exact rows, duplicates no-ops), "nothing admitted leaves before the
  seal" under joins and leaves in any interleaving, a 30-room differential of the compiled reducer against the stated
  rule, the expire policy and identity of a missed share update (and batching it beside messages), the state checks,
  and Track Q's resource bound for v5.
- tests/track-w2-chat-shares-room.test.ts (3, native SQLite rooms): (a) **the RED the owner asked for**: a second
  admin's share update misses its checkpoint (the creator seals before it arrives); it expires, and arriving late at
  the creator changes nothing; that admin installs the next checkpoint as active, sends a message and issues the next
  checkpoint's update, both admitted; (b) a late joiner granted Writer speaks from the checkpoint
  after the share update, survives two quiet checkpoints and a reopen, and speaks again, with every state equal;
  (c) a revoked member's messages stay until the window needs their space, then leave first, oldest first.

When the three files run in parallel under load, vitest itself sometimes reports "[vitest-worker]: Timeout calling
\"onTaskUpdate\"" after all 20 pass (exit 1; tests/suite-head-w2.log, suite-head2-w2.log). Each file alone exits 0,
and the same vitest error appears in Track W's packages/node suites at base and head. It is the test runner under
load, not a test.

### 5.2 Native SQLite, 300 epochs with joins, leaves and a crash (4/4 pass, twice)

tests/track-w2-chat-shares-native.test.ts. On the rebased tip: <evidence>/track-w2/latency/native-300-30cb/ (JSONL,
summary.txt, segments.txt, run.txt), 60 minutes, 4/4. On ebf4254f before the rebase: latency/native-300/, 63 minutes,
4/4. The figures below are the rebased run's; the earlier run's are within the ranges given unless stated.

- **Peers:** the creator (admin), a genesis Writer (peer 1), and two joiners (peers 2 and 3) that open receive-only.
  Each epoch the creator sends two messages and every other Writer one (40-300 characters), then the creator seals
  and adopts, every following peer installs, and every following peer runs the recovery-pool lull (as Track W's
  native room does).
- **Events** (JSONL records, numbered from 1): grant peer 2 at 21 → share update at 22 → peer 2 reopens as a Writer
  and speaks at 23 (the stop and reopen took 896 ms; 700 ms on ebf4254f); revoke peer 1 at 101 → share update at 102;
  every peer stops and reopens mid-epoch at 151; grant peer 3 at 181 → speaks at 183 (822 ms; 464 ms); revoke peer 2
  at 251 → share update at 252.
- **Every epoch** every following peer's state bytes equal the creator's and an independent model's (so every
  digest agrees), and the mid-epoch reopen replays every peer to the same state.
- **Departed members' bytes:** each revoked member had 33 messages in the window. The window was full, so space was
  needed at once: they left first, oldest first, 2-4 per epoch, all gone 11 epochs (peer 1: records 101-111 hold
  33 → 4, none at 112) and 12 epochs (peer 2: 251-262 hold 33 → 1, none at 263) later, and while any remained no
  other member's message left (the test checks the eviction order). Same course, to the epoch, on ebf4254f.
- **State:** at most 32,746 bytes; 32,325-32,746 over epochs 71-300 (slope +0.05 B/epoch); 98-104 messages.
- **Storage:** the creator's room stores keep 134-142 rows and 199-207 KB over epochs 71-300 (slopes -0.004 rows and
  -3.9 B per epoch). A joiner's stores step up once when it becomes a Writer (peer 3: 97 → 118-123 rows) and are flat
  after it (epochs 190-300: slope -0.05 rows, -101 B per epoch). Peer 2 over 71-250: 118-123 rows, +24 B/epoch.
- **Latency, p50 over epochs 71-300** (ms): seal 314, adoption 865, install 240, creator issue 545, Writer issue 24,
  creator lull 3,058, other lulls 1,342. By segment (medians, ms):

  | Epochs                | seal | adoption | install | creator issue | Writer issue | creator lull | other lulls |
  | --------------------- | ---- | -------- | ------- | ------------- | ------------ | ------------ | ----------- |
  | 71-130                | 284  | 839      | 217     | 484           | 25           | 2,649        | 1,195       |
  | 131-190               | 330  | 900      | 243     | 589           | 26           | 3,212        | 1,398       |
  | 191-245               | 259  | 686      | 218     | 437           | 22           | 2,326        | 1,070       |
  | 246-300               | 458  | 1,431    | 366     | 770           | 23           | 4,984        | 1,889       |
  | ebf4254f run, 246-300 | 210  | 585      | 189     | 357           | 23           | 2,091        | 948         |

  The rebased run's slopes over 71-300 are positive (seal +2.0, adoption +5.3, install +1.5 ms per epoch), all from
  its last segment: the machine's load (one-minute average) was 14 at the start, and the 15-minute average was
  110-122 over its last half hour. The earlier run had the same room, schedule and storage, and its load fell from
  about 100 to 35; its slopes are
  zero or negative and its last segment is its fastest (p50 over 71-300: seal 287, adoption 785, install 222, creator
  lull 2,594, other lulls 1,180). State and stores are flat in both, so the per-epoch work does not grow; the
  latency follows the machine. For reference only (other time, other load, three peers, no membership changes):
  Track W's native room on 24d4ca61 measured 325 / 869 / 277 / 2,797 / 1,290 over the same epochs.

### 5.3 Real networking (on 30cb474e)

**The membership spec on the shipped page** (tests/track-w2-shipped-chat-membership.pw.ts, with its own config
playwright.track-w2-chat-membership.config.ts on ports 4175, 4181, 51000 and 51002): a creator and a joiner page in
Chromium over Track X's relays. It passed on the rebased tip (<evidence>/track-w2/logs/w2-membership-r2-30cb.log, 3.9
min) and on ebf4254f before the rebase (w2-membership-r1.log, 4.0 min), with the same course:

- The creator creates a room (v5; allowance 1,954, budget 32,482 with one holder). The joiner joins as an observer;
  the membership panel shows on the creator's page only.
- Checkpoint 1: the creator grants the joiner Writer through the panel. At checkpoint 2 the grant has latched and the
  creator's page has issued the share update by itself (budget 32,401 with two holders); the joiner's row reads "from
  checkpoint 3", and its message box is closed with that reason. At checkpoint 3 the joiner sends: the page reopens as
  a Writer and the first message is accepted in 203 ms (r1: 141 ms). It sends a large message in checkpoints 3 and 4
  too.
- Checkpoint 5: the creator revokes the joiner. From checkpoint 6 the share rows hold the creator only (budget back to
  32,482). The joiner's three messages stay while the creator fills the window (epochs 7-21) and leave only when space
  is needed (epochs 22-23), first and oldest first. The creator's messages all stay while any departed message
  remains, and the window stays within its budget. The revoked page's next install fails (residual 2).
- Every epoch, while the joiner follows, its projection equals the creator's. No page errors. The admin's page logged
  "Chat share update was refused; it is retried" twice while its room was between planes during an adoption ("v3 room
  live plane is unavailable"); the retry 3 s later was admitted.
- Seal took 109-296 ms in checkpoints 1-4 and 3.3-9.1 s from checkpoint 5, adoption 0.6-3.0 s. Track W's real-network
  runs of the v4 page show the same step (2.4-3.9 s from epoch 5), and so do Track X's runs below. The shipped page
  does not opt into the library's lull maintenance, so each seal carries the recovery pool's maintenance (decision
  row 54 schedules the lull every epoch under Track Z). It is not new in v5 (section 5.6).

**Track X's harness on the shipped Chat page** (playwright.track-x-shipped-app-long-room.config.ts, -g "shipped chat
page"; the joiner is the page's observer, so the creator is the only holder):

- 16 epochs x 2 messages, twice: 16/16 and 16/16 (logs/trackx-chat-h30-16a.log, 3.2 min; h30-16b, 1.8 min). The
  creator's moves reach the observer in 6-65 ms.
- 30 epochs x 8 messages (240 messages of about 176 bytes, more than the window holds; by the record arithmetic the
  window starts evicting at epoch 23, message 184): 30/30 (logs/trackx-chat-h30-overfill-30x8.log, 6.7 min), delivery
  3-125 ms.

### 5.4 Chromium, Track M's harness (room host, Writer recipient, product lull)

<evidence>/track-w2/latency/chromium/: v5 and v4 rooms of 80 epochs, started together, on the rebased tip (`tm2-*.log`,
tm2-steady.txt) and on ebf4254f (`tm1-*`). All four pass; the window is full from epoch 56. On the rebased tip, over
epochs 41-80, v5 against v4 (ms, median): seal 274 / 288, adoption 759 / 797, install 323 / 332, creator issue 395 /
433, creator lull 2,505 / 2,583, recipient lull 1,144 / 1,165; every slope over the full window is zero or negative
except v4's seal (+1.3 ms per epoch). On ebf4254f v5 was within 5% of v4 the other way (seal 324 / 302). Room rows
are identical and flat in both formats (creator 135, recipient 128); room bytes are 108 B larger in v5 (the state's
copies), and the state 36 B larger.

### 5.5 Canvas/Chat e2e

9/9 on the rebased tip (logs/e2e-canvas-chat-v5-page-30cb.log, 1.0 min). The shipped Chat e2e creates a v5 room, the
joiner opens read-only with its box closed, the oversize message is refused with its text kept, and a valid one is
accepted. An earlier run on ebf4254f under load 180 (e2e-canvas-chat-v5-page-1.log) timed out at 45 s in three tests,
one of them Canvas's two-peer test, which W2 does not touch; the Chat refusal test had reached its last steps.

### 5.6 The format's cost, paired

A probe (<evidence>/track-w2/trash/w2-bench-format.test.ts, not committed; `tests/bench-b-*.log`,
latency/bench-b-summary.txt) ran the same steady room (creator and two genesis Writers, four messages per epoch, 15
epochs, with the lull) in v4 and v5, alternating, twice. Pooled medians over epochs 4-15, v5 against v4: seal 810 /
768, adoption 2,418 / 2,226, install 679 / 668, creator issue 1,312 / 1,371 ms. The two pairs disagree in sign (pair
1: v5 faster everywhere; pair 2: v4 faster), so the format has no measurable cost; the load (60-170) dominates. A
first probe without the lull (`tests/bench-a-1-*.log`) showed both formats' seals climbing to 2.5-7.8 s from epoch 5;
that is the recovery pool's maintenance carried by the seal, the same in both formats.

## 6. What remains (residuals)

1. **A device that did not follow the previous checkpoint cannot become a Writer yet** (section 4). A fresh device,
   or one that was offline across a checkpoint, must follow one whole checkpoint receive-only first; the page then
   falls back and says so. The same constraint leaves a narrow race: a device reopened as a Writer whose first issue
   fails, and which then misses a checkpoint, fails its next install. Lifting it is a library change
   (packages/node: let predecessor recovery accept an empty own chain for a replica admitted as a Writer at that
   checkpoint, as `returningPredecessor` does for the admission epoch). Not in this track's scope.
2. **A revoked member's page stops following.** Its replica is no longer in the next checkpoint's ACL, and installing
   that checkpoint fails ("D110C_B_ACTIVATION_STALLED: preparation-rejected: creator historical issuance authority
   preparation failed"; real-network run, section 5.3). Everyone else is unaffected and its messages stay in their
   windows as the rule says. A page that reopens receive-only after a revoke would keep it reading; not built here.
3. **A displaced ACL operation by a non-creator admin is fatal, in every Chat format** (found in step 2:
   `validateDisplacementPolicy` in packages/node/src/v3-room.ts requires the displacement-policy keys to equal the
   batchable actions, and `acl` cannot be batchable). The shipped page's only admin is the creator, which seals, so
   its own ACL operations are never displaced. A library item, if other admins are ever added.
4. **More than 16 Writers.** Rows stop at 16; a 17th Writer sees "waiting for the admin's page to give you a share"
   until a holder leaves and the next share update adds it (author order).
5. **The per-checkpoint sending limit is A (1,954 bytes) for everyone**, also in a room of one or two people, where v4
   allowed the whole share. This is the cost the owner accepted with `N_max` = 16.
6. **Unchanged from Track W:** the library's 32,768-byte room-state cap (a larger window needs a library track).

## 7. Test changes

No RED, governance or contract test, frozen artifact, registry or vector was edited. Track W's tests (and its
catalogs, artifacts and vectors) are untouched: the rule they state, for v3 and v4 rooms, did not change.

W2's own tests changed after their RED commit (0a6a9f75) only here, in the product commit (7db273d4, whose message
lists them):

- **tests/track-w2-chat-shares-rule.test.ts:** the two size helpers (`sized`, `padding`) could not build some record
  sizes (where the text's length prefix grows a byte), so they now try a one-character longer id, and the smallest
  record they build moves from 130 to 140 bytes (also in the differential's random sizes). No assertion changed.
- **tests/track-w2-chat-shares-room.test.ts, test (b):** the RED reopened the joiner as a Writer in its admission
  checkpoint and expected its message there to be refused. The library refuses that replica at its next install
  (section 4), so the test now states the page's flow: the joiner follows receive-only, receives the share update,
  reopens as a Writer once its share is in force and speaks; it then stays a Writer through two quiet checkpoints and
  a restart and speaks again, with equal states. The refusal of a Writer before its share's checkpoint is still
  asserted in the rule test ("admission refuses a Writer without a share in the checkpoint's base, and a joiner before
  its first checkpoint").
- **tests/fixtures/chat-membership-shares/room.ts:** a `promote` reopen (creates the signing store on the first
  Writer open, as IndexedDB does in the browser).

Tests added after the product: tests/track-w2-shipped-chat-membership.pw.ts (with its config), Track M's `shares`
format (tests/fixtures/track-m-apps/; the default stays "window", and "window" and "lifetime" run exactly as before),
and tests/track-w2-chat-shares-native.test.ts.

## 8. Suites, against 30cb474e

Each set ran with a JSON report at base (30cb474e, the worktree detached there; W2 changes no package, so the dists
are the same) and at the tip (dcdda86d), and compare.py lists every test whose status differs (<evidence>/track-w2/
`tests/suite-b30-*.json`, `suite-h30-*.json`, bin/suite.sh, bin/compare.py).

| Set               | Base 30cb474e (passed / failed / skipped) | Tip            | Differences      |
| ----------------- | ----------------------------------------- | -------------- | ---------------- |
| chat (18 files)   | 116 / 5 / 19                              | 116 / 5 / 19   | 0                |
| native6 (6 files) | 35 / 15 / 0                               | 35 / 15 / 0    | 0                |
| trackx (5 files)  | 89 / 1 / 0                                | 89 / 1 / 0     | 0                |
| root (119 files)  | 870 / 904 / 98                            | 871 / 903 / 98 | 1 (load timeout) |
| w2 (3 files; new) | -                                         | 20 / 0 / 0     | new              |

The sets: chat = the Chat archive and window rule, the R9 contract and ledger, the 3f/3g/3h zone REDs, Track M's
long rooms, Canvas/Chat, and Track X's REDs; native6 = Track W's native Canvas/Chat set with the v3 catalog; trackx
= Track X's readiness-hold tests merged at 30cb474e; root = Track W's root set; w2 = W2's unit files.

- The one root difference: "Phase 4c-a ... proves peak verifier ownership on 64 MiB" timed out (30 s) in the base
  run under load and passed at the tip; alone at base it passes in 11 s (tests/rerun-b30-phase4c.log). It was the
  other way round once before the rebase (timeout at the tip, passes alone at both). Not related to this track.
- The failures shared by base and tip are the same tests: chat: phase-3f-b (4) and 3f-c (1) zone REDs; native6:
  R9 capacity, metadata and shipping room tests (as in Track W's base); trackx: packages/node
  creator-ordinary-readiness-producer "uses the genuine same-head pair only to select custody"; root: the
  repository's open REDs. r9-chat-artifact-contract skips without SHIPPING_CHAT_BUNDLE_DIR at both.
- Before the rebase, the same sets at ebf4254f against the tip on it: chat 0 differences, native6 0, root 2 load
  flakes (each passes alone at base and tip).

**Typecheck:** `pnpm -r typecheck` 0 errors at the tip (<evidence>/track-w2/logs/typecheck-head-30cb.log). The root
tests sit in no typecheck project; an ad hoc `--noEmit` check of W2's test files (<evidence>/track-w2/tsc/) shows only
path-mapping artifacts and type-only notes in the committed RED rule test, left as committed.
**Shadow guard:** `node scripts/check-shadowed-sources.mjs` exit 0 (<evidence>/track-w2/logs/shadowed-head-30cb.log).

## 9. Commits (on 30cb474e)

| Commit        | What                                                                                                |
| ------------- | --------------------------------------------------------------------------------------------------- |
| 898bcdd1      | test(track-w2): pin that a departed author gets no work admitted in a checkpoint whose ACL lacks it |
| 0a6a9f75      | test(track-w2): RED for Chat's membership-aware v5 format and its share updates                     |
| 7db273d4      | feat(chat): v5 format with membership-aware shares in the rolling window                            |
| bd04297b      | feat(chat): shipped page signs v5 rooms and lets the admin grant and revoke Writer                  |
| 1b9a3666      | refactor(chat): the v5 share update is a plain operation record type                                |
| 70e5f258      | test(track-m): measure Chat's v5 format (TRACK_M_APPS_CHAT_FORMAT=shares)                           |
| dcdda86d      | test(track-w2): a v5 Chat room runs 300 native epochs with joins, leaves and a crash                |
| (this commit) | docs(track-w2): RESULT.md and OPTIONS.md                                                            |

Before the rebase onto 30cb474e the same commits were 5abe5c3a, ca22f250, 078b923e, c13e5ab5, ee8313e5, a9354cca and
97a4123b on ebf4254f; the rebase was clean and changed no file of this track.
