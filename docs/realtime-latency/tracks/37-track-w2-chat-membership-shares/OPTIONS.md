# Track W2, step 1: shares for late members, and the bytes of members who leave

Branch `track-w2-chat-membership-shares` at 3cd2d4e9. Nothing is built yet. Byte figures come from
`<evidence>/track-w2/bin/calc-shares.mjs` (canonical encoder from the worktree's dist, rows written at full integer
width as the v3 overbook rule does). They are approximate to within a few bytes; step 2 pins the exact values in tests.
"Checkpoint" means a room epoch (seal, then adoption). While people are talking, one comes every few seconds.

## 0. Answer

**Recommendation: "guarantee and borrow".** This combines options a, b and c, plus releasing the rows of members who
have left. Option d is left out.

1. **Sending allowance per checkpoint: one fixed amount `A` for every member.** It is set by a maximum number of
   members with a share, `N_max`. It never changes while the person stays a member. This takes the "reserve" idea
   from option b: the room is sized up front for `N_max` members.
2. **Guarantee: an equal split of the window among the current members who hold a share.** It is recomputed when
   membership changes (option a). It is always at least `A`, because shares stop at `N_max` holders.
3. **Borrowing: the window keeps any messages up to the room's budget.** When a new message does not fit, the oldest
   message of any author who holds more than their guarantee leaves (option c). A member who left has no guarantee,
   so their messages are the first to go once space is needed. Until then they stay readable.
4. **Membership reaches the state through one share update per membership change.** The admin's page issues it
   automatically after a grant or revoke takes effect. Its content is a pure, idempotent function of the
   checkpoint's latched ACL and the current rows, and every peer checks it exactly. An author who is no longer in
   the ACL loses their row. A new Writer gets a row and can send from the next checkpoint.

**Why this one.** It is the only combination I found that does all of the following:

- gives late joiners a share without evicting anything up front;
- clears departed members' bytes;
- keeps per-checkpoint admission independent of order (crash replay and every peer agree);
- never refuses re-sent (displaced) work, because the allowance never goes down;
- keeps "a message admitted between two checkpoints is in the next signed checkpoint";
- stays inside 32,768 bytes.

**What it costs: the sending limit per checkpoint drops for small rooms.** In version 4 it was the member's whole
share (32 KB alone, 16 KB with two people, 4 KB with eight). Now it is `A` for everyone. The owner chooses `N_max`:

| `N_max` (members with a share) | `A`: allowance per checkpoint and largest message | ≈ messages of 185 B per checkpoint | ≈ largest text (ASCII chars) |
| ------------------------------ | ------------------------------------------------- | ---------------------------------- | ---------------------------- |
| 8                              | 3,999 B                                           | 21                                 | 3,850                        |
| **16 (suggested)**             | **1,961 B**                                       | **10**                             | **1,800**                    |
| 32                             | 942 B                                             | 5                                  | 800                          |
| 64                             | 433 B                                             | 2                                  | 290                          |

What a member keeps in the shared window does not shrink. Alone, a member keeps the whole window, about 32.5 KB
(borrowing). With n active members, each keeps at least `32.5 KB / n` (the guarantee) and more when others are
quiet.

**No library change is needed.** The rule lives in `examples/chat`:

- the compiled reducer;
- the admission policy;
- `displacementPolicies` and `displacedOperationIdentity`, which are app hooks;
- the page.

**The owner needs to decide four things:**

1. `N_max` (table above).
2. Whether departed members' messages leave lazily (recommended) or at once.
3. Whether W2 includes the page flow that lets a joiner become a Writer. **Today's shipped page cannot do that at
   all** (section 1.4).
4. A new artifact `v5` next to `v4`, or replacing `v4` in place (recommended: `v5` next to it, with no migration).

**One fact to pin first.** Step 2's first RED test checks a precondition for releasing rows: an author who is absent
from a checkpoint's latched ACL cannot have any operation admitted in that checkpoint, whether by an ordinary issue,
their own rebase, or a creator's settlement source. The code says this holds (section 1.5). If the test finds a
path, a departed member's row stays booked until the existing new-incarnation evidence appears (the v3 rule). Leaves
would then free bytes only after evidence. Joins still work.

## 1. Map: how membership reaches the Chat reducer today

### 1.1 What the reducer sees

The compiled reducer (`examples/chat/window-blueprint/blueprint.ts`) receives `state`, `operation` and
`executionContext.author`, and nothing else.

- **No member set and no current epoch.** The projection (`v3-chat-window.ts`, `project`) skips `acl` operations
  (`if (row.operation.action === "acl") continue;`).
- **The only membership data in the state is the capacity rows** `[author, ceilingBytes, allocationEpoch]`. Here
  `allocationEpoch` is the epoch of the allocation that created or released the row. It is the closest thing to a
  "join epoch", and nothing reads it at reduce time.
- **A `capacityAllocation` operation carries `epoch` and `aclDigest`.** The reducer checks only their shape. It
  installs the new capacity (the basis object id cannot change) and runs `fitShare` for every author, so a lower
  ceiling evicts that author's oldest messages.

### 1.2 What the admission policy sees

The policy is built once per checkpoint by `createOperationAdmissionPolicy` (v3-room.ts 526-540). It receives:

- `epoch`, `aclDigest`, `anchorDigest`;
- the checkpoint's authenticated base state, or the closed postimage when it validates a predecessor;
- `exactCanonicalLatchedAclBytes`, which is the member set and groups for the whole checkpoint;
- `authenticatedSettlementFrontiers` `[author, admissionEpoch, terminalThrough]`.

It sees each operation with `context.author`.

### 1.3 How a Writer is added or removed today

1. An admin issues `{action:"acl", kind:"grant"|"revoke", group:"writer", target}`. The library stages it, and it
   takes effect in the **next** checkpoint's latched ACL. Within a checkpoint the member set is fixed.
2. The Chat state does not change by itself. Capacity changes only through an admin's
   `{action:"capacityAllocation", capacity, epoch, aclDigest}`. The policy accepts that operation only under all of
   these conditions:
   - `epoch` and `aclDigest` are the current ones;
   - the author is an admin;
   - no uncommitted reservation exists;
   - `capacity` equals `reallocateShippingChatWindowCapacity(...)`. That is the v3 formula: existing rows are
     carried, a new writer gets `[author, 0, epoch]`, and only the **free** bytes are split among current writers.
     A row is "released" (its ceiling cut to its current charge) only with new-incarnation evidence
     (`frontier.admissionEpoch > allocationEpoch`).
3. The genesis split (`createShippingChatGenesisStateBytes`) books **all** 32,768 bytes among the genesis members.
   So a later writer gets `[author, 0, epoch]` plus nothing, and cannot send a single message.
4. A member who leaves keeps their full row forever without new-incarnation evidence: "Mere revocation, a high
   terminal sequence or local completion never releases unknown old-source reservations." Their messages stay in
   the window forever, because only an author's own new messages evict that author's old ones. Their row (about
   76 bytes) also stays. With churn, rows pile up: at about 430 lifetime members the allocation metadata alone
   exceeds 32 KiB, and the formula throws "no allocation metadata headroom".

### 1.4 The shipped page cannot enroll a late Writer

`examples/chat/src/index.ts` creates every room with a creator-only ACL (`groups: ["admin","finality","writer"]`).
A joiner computes `enrolledWriter` from the genesis invite ACL, opens `receiveOnly`, and sees "Connected as an
observer; this chat is read-only." The page also has no grant or revoke control and never issues
`capacityAllocation`.

So in the shipped product a late joiner cannot speak, whatever the share rule. Only tests and harnesses add Writers
after creation (tests/r9-chat-capacity-room-native.test.ts around 1480-1610, through admin ACL ops). Track M's
harness enrolls its Writer at genesis (tests/fixtures/track-m-apps/long-room-core.ts:359-365).

If W2 should change what a player sees, it needs a small page flow:

1. The creator grants or revokes Writer for a joiner.
2. The joiner's page reopens as a Writer once the grant is latched. `observer` is fixed when the session opens, and
   the library refuses a non-receive-only session for a non-member (creator-adoption.ts 2474-2484).
3. The admin's page issues the share update.

Item 3 belongs to W2 in any case. Items 1 and 2 are the owner's call (decision 3).

### 1.5 Checkpoints, displaced work, and who can still get operations admitted

- **The base of a successor checkpoint is exactly the sealed closed postimage.**
  `installSuccessorProjectionBase` checks this byte for byte (v3-room.ts 3186-3230). There is no application hook at
  the boundary, so any boundary effect has to be an operation.
- **A message issued but not in the checkpoint's seal is displaced.** The author's own session re-issues it in the
  next checkpoint it installs, through the same policy (`drainRebaseOutbox`, v3-room.ts 5493-5690, source
  `authenticated-historical`). **A policy refusal there is fatal to that session.** The refusal rejects the issue
  promise, `Promise.all(issued)` throws, and the `rebasePromise` catch sets `terminalFailure` and shuts the session
  down (v3-room.ts 5705-5725).
- **An offline author's whole backlog belongs to one checkpoint.** It was admitted locally under that checkpoint's
  cap and is re-issued wherever the author reconnects, possibly many checkpoints later.
- **A displaced operation whose action has no `displacementPolicies` entry is fatal for its author.** So is one
  whose `displacedOperationIdentity` throws. The library throws "displacement policy is unavailable" (v3-room.ts
  4829-4833, 5605-5606).
  - Chat lists only `message: "rebase"`, and its identity function requires `clientOperationId`.
  - So an admin's `capacityAllocation` that gets displaced would end the admin's session.
  - This is latent in v3 and v4 and unreachable from the shipped page. Any design that issues allocations from a
    page must declare `capacityAllocation: "expire"` and give it an identity.
- **Who can get an operation admitted into checkpoint E.**
  - New work: Writers of E's latched ACL (`authorizeLatchedApplicationWrite`, which needs the `writer` group).
  - A creator's settlement source (re-admitting another author's displaced row): the author must be a **member** of
    E's latched ACL (`resolveV3AuthorizedAuthor` on the target ACL, v3-live.ts 6340-6346, which uses
    `authorizeLatchedEnvelopeAuthor`).
  - An author's own rebase: a writer, or a member keeping "native old-source custody" (creator-adoption.ts
    2476-2484).
  - A member whose groups are all revoked (and who has no finality key) leaves the ACL entirely
    (latched-acl.ts 434).
  - **Conclusion from the code:** an author absent from E's latched ACL cannot get an operation admitted in E. An
    author who lost `writer` but kept another group still can, through settlement and custody. Step 2 pins this
    with a RED test before the rule relies on it.

## 2. Constraints any option must keep

- **C1. Admission is independent of order.**
  - Whether the policy accepts an operation may depend only on the checkpoint's fixed inputs (ACL, base state) and
    on the _set_ of the author's identities in the checkpoint. It must not depend on interleaving. Journal replay
    after a crash and the creator's validation of the closed postimage must accept exactly what was admitted.
  - Counterexample if a ceiling can drop within a checkpoint: a member has ceiling 300, the admin lowers it to 100,
    and the member sends a 150-byte message concurrently.
    - Allocation first: the message is refused.
    - Message first: the allocation evicts a message admitted in the same checkpoint.
  - Two peers, or a replay, that see the two orders disagree.
- **C2. A message admitted between two checkpoints is in the next signed checkpoint.** Track W's rule: devices that
  only install checkpoints, and their archives, see every admitted message.
- **C3. Re-sent displaced work is never refused** (G2 "accepted work stays finishable", G3 "offline/rebase work").
  - A member's allowance per checkpoint may never fall below an allowance they had earlier in the same membership.
  - Counterexample for any rule that cuts a current member's allowance:
    1. A 2-member room gives each member 16,226 B per checkpoint.
    2. Member M sends 3 KB, then goes offline before the seal.
    3. 14 joins bring M's share down to 1,961 B.
    4. M reconnects 5 checkpoints later. The rebase re-issues 3 KB against a 1,961 B allowance. The policy refuses
       it, M's session ends, and the 3 KB M's device accepted never lands.
- **C4. Every state stays within Track Q's bound** {32,768 bytes, 16,384 items, depth 16}. Chat's own state check
  must hold under the same limits (`SHIPPING_CHAT_CAPACITY_STATE_LIMITS`).
- **C5. Releasing a departed member's row needs proof that none of their operations can still be admitted** (1.5).
- **C6. The reducer is pure.** It cannot read the ACL or the epoch, so anything that depends on membership enters
  through an operation the policy has checked exactly.

## 3. The options

### a. Rebalance on membership change

- **Rule.** At each membership change, the admin's share update sets every current Writer's ceiling to an equal
  split of the budget among the Writers of the latched ACL. Rows for authors absent from the ACL are dropped. Each
  lowered ceiling evicts that member's oldest messages. As in v4, the allowance per checkpoint equals the ceiling.
- **What a player sees.** A joiner can send from the next checkpoint. When someone joins, everyone's oldest
  messages beyond their new share leave the shared window at once. When someone leaves, their messages leave at
  once and the others' shares grow.
- **Worst case.**
  - At `N` Writers, shares are `(32,768 - 164 - 76N)/N`: 1,961 B at 16, 433 B at 64, 51 B at 256 (the latched-ACL
    limit), which is below one message.
  - A burst of 15 joins in a full window of one author evicts about 30 KB in one operation.
  - A burst of leaves evicts the leavers' messages at once.
- **Allowance per checkpoint.** It falls on every join. That is the C3 counterexample: **refused rebase, a lost
  session, lost work.** It also breaks C1 unless the decrease is latched to the next checkpoint, and latching does
  not fix C3 for offline members.
- **Determinism.** The reducer is deterministic. Admission is not safe (C1, C3).
- **Cost per checkpoint.** None while membership is stable. On a change: one admin operation, O(window + rows).
- **Verdict.** Not safe on its own. Recomputing the guarantee is useful only if it is no longer the sending
  allowance; that is what the recommendation does.

### b. Reserve

- **Rule.** The genesis split books only part of the budget. The window is cut into `N_max` equal slots of
  `s = (32,768 - overhead(N_max))/N_max`. Each genesis member gets a slot. A late Writer takes a free slot at the
  admin's share update. Allowance per checkpoint = ceiling = `s`, so it never falls (C3 holds) and never changes
  within a checkpoint (C1 holds).
- **What a player sees.**
  - Joiners can speak until the slots run out.
  - A solo creator keeps only `s` of history in the shared window (1,961 B, about 10 messages, at `N_max` = 16),
    against 32.5 KB in v4. That is a large step back for the common 1-3 person chat.
  - Departed members' slots stay booked under the v3 evidence rule. Released by the C5 rule, they return to the
    reserve.
- **Worst case.** After `N_max` members in the room's lifetime, with no release, nobody new can speak. A burst of
  joins beyond the free slots: the extra Writers get no share (in author-id order) and cannot speak.
- **Allowance per checkpoint.** `s`, fixed. Today it is the share.
- **Determinism.** Yes: fixed slots, and an idempotent update over the latched ACL.
- **Cost per checkpoint.** None while stable. One admin operation per change.
- **Verdict.** Safe, but wastes most of the window in small rooms. Its fixed allowance is the piece the
  recommendation keeps.

### c. Borrowing

- **Rule.** Ceilings become guarantees. The window holds any messages up to the budget. When a message does not
  fit, the oldest message among authors above their guarantee leaves. The allowance per checkpoint stays the
  guarantee.
- **What a player sees.** Quiet members' unused bytes extend everyone else's history; it fills the window. Nothing
  changes for joiners: v4's genesis split books every guarantee, so a late Writer still gets 0. A departed member
  keeps a full guarantee (v3 rule), so their last messages are protected forever.
- **Worst case.** The same as v4 for joiners and leavers. A full window where everyone is active behaves exactly
  like v4.
- **Allowance per checkpoint.** Unchanged. C1-C3 hold: a member's messages from the current checkpoint are at most
  their guarantee, so reclaim never reaches them (proof in section 4).
- **Determinism.** Yes. The reducer picks "oldest message of an author over guarantee" from the state alone.
- **Cost per checkpoint.** None. Per message O(window), the same as v4's `fitShare`.
- **Verdict.** Improves how fully the window is used, but alone it solves neither problem.

### d. Age horizon

- **Rule.**
  - The reducer cannot see epochs (C6), and a message cannot carry its epoch: a displaced message is re-issued
    unchanged in a later checkpoint, so the policy would refuse it, which is fatal (C3). `transformDisplacedOperation`
    is context-free and cannot rewrite the epoch.
  - The only library-free form is a **tick**. The creator's page issues `{action:"tick", epoch}` once per
    checkpoint, which the policy checks against `input.epoch`, with displacement "expire".
  - The reducer keeps `state.tick` and stamps each message with it when the message is applied, so the stamp is in
    the state, not in the operation.
  - A tick for epoch e evicts messages stamped at or before `e - N`.
- **What a player sees.** Messages older than N checkpoints leave the shared history even in an idle room, where
  nobody needs the space. Checkpoints come with activity, so N does not map to a fixed time. Departed members'
  messages are gone after N checkpoints.
- **Worst case.** It does not give a joiner a share: v4's genesis booking still holds all bytes. It needs b or c for
  that.
- **Allowance per checkpoint.** Unchanged. C2 holds for N ≥ 2: a message admitted in E is stamped E-1 or later.
- **Determinism.** Yes: stamps come from the state, and ticks are checked exactly. Crash replay gives the same
  result.
- **Cost per checkpoint.** **One extra creator-issued operation every checkpoint, for the life of the room.** That
  means a signature, a vertex, journal and census rows on every peer, and a creator issue (377 ms p50 in Track W's
  native run under load). Plus about 5 B per message for the stamp, and O(window) per tick.
- **Guarantees.** It is in tension with Track W's G7 statement: "no sweeper, TTL or count-based deletion of
  protocol data". A horizon is a TTL in the reducer. It is application state, not storage retirement, but the owner
  should know.
- **Verdict.** Not recommended. It costs something every checkpoint, deletes history nobody needed deleted, and
  does not solve joins. Borrowing already clears departed bytes when the space is actually needed. It could be
  added later on top of the recommendation if a time-based expiry is wanted.

## 4. The recommended rule, exactly

**State.** Version 5 (a new artifact, section 5):

```
{ version: 5, messages: [...oldest first...],
  capacity: { version: 2, basisObjectId, allowanceBytes: A, allocations: [[author, guaranteeBytes, sinceEpoch], ...] } }
```

- `A` is fixed at genesis from `N_max` and never changes in the room.
- Rows are sorted by author.
- There are at most `N_max` rows in all. Members who lost `writer` but are still in the ACL (custodians, 1.5) keep
  their row, and it counts toward `N_max`, so every guarantee stays at least `A`.
- `sinceEpoch` is the epoch of the share update that created the row. It is the "join epoch", useful for the page.

**Budget.** `M = 32,768 - bytes(empty state with these rows at full integer width) - 2`. This is the same
overbooking arithmetic as v3 and v4.

**Share update** (`capacityAllocation`, issued by an admin; the shipped page's creator issues it automatically when
a checkpoint installs with rows that differ from the formula). The policy accepts it iff:

- `epoch` and `aclDigest` are the current ones;
- the author is an admin;
- `capacity` equals `shares(ACL_E, rows)`, where:
  1. it keeps every existing row whose author is still in `ACL_E` (Writer or custodian);
  2. it adds a row for each `ACL_E` Writer without one, in author order, while there are fewer than `N_max` rows;
  3. it drops rows whose author is absent from `ACL_E`;
  4. it gives every row the guarantee `floor(M/n)`, with the remainder going to the first rows in author order.

`shares` reads no messages, so the old "no uncommitted reservation" rule is no longer needed. And
`shares(ACL_E, shares(ACL_E, r)) = shares(ACL_E, r)`. So within a checkpoint, every update has the same content
whatever it was computed from. Duplicates are no-ops, and order cannot matter (C1). Displacement:
`capacityAllocation: "expire"` with identity `capacity:<epoch>:<aclDigest>`. The page re-issues an update in the
next checkpoint if it is still needed.

**Reducer: message by author a.**

1. As v4: an exact retry moves to newest, and the same identity with different content is refused.
2. The record must be at most a's guarantee, and a must hold a row.
3. Append the message.
4. While the total charge exceeds `M`, remove the oldest message (in window order) whose author's charge exceeds
   that author's guarantee. An author without a row has guarantee 0.

**Reducer: share update.** Install the rows, then apply step 4 (the budget may have shrunk by up to 76 B per new
row). Nothing else is evicted when guarantees fall: reclaim happens only when space is needed.

**Admission: messages by a in checkpoint E.**

- Accept iff a holds a row **in E's base state** and the bytes of a's distinct identities in E (pending or
  committed, exact retries included, as in v4) are at most `A`.
- Base rows and `A` are fixed for the checkpoint, so acceptance depends only on the set (C1).
- A joiner's first message waits for the checkpoint after the share update. Their messages therefore never depend
  on a displaced, expired update in the same checkpoint. If they did, the update would expire, the message would be
  re-sent without a row, and the refusal would be fatal.

**Why C2 holds.** a's messages from E total at most `A`, and `A` ≤ every guarantee (`floor(M/n) ≥ A` for
`n ≤ N_max`). Suppose step 4 picks author b because b's charge is above b's guarantee. Then b's charge is above b's
total for E. So b has a message from before E, and that message comes before b's messages from E in window order.
An exact retry moves to newest, and it counts in E's total. So the oldest of b's messages is never from E.

**Why step 4 always ends.** If every author were within their guarantee, the total would be at most the sum of the
guarantees, which is at most `M`. So while the total exceeds `M`, some author is over their guarantee.

**Why C3 holds.** `A` never changes. A member keeps their row as long as they are in the ACL, and an author outside
the ACL cannot have work admitted (1.5). So a rebase that fit under `A` in one checkpoint fits under `A` in any later
one.

**C4.** Every state has total charge at most `M` and at most `N_max` rows, so it is within 32,768 bytes. A full window is a few thousand items at depth 4.

**C5.** Rows are released only for authors absent from the ACL. Step 2's RED test pins the precondition.

**Worst cases.**

- **`N_max` members, all active.** Every guarantee is 1,961 B (at `N_max` = 16); the window holds about 31.4 KB of
  messages plus rows, at most 32,768 B. A Writer beyond `N_max` gets no row. The page says the room's speaking
  places are full.
- **A full window held by the creator, then 15 joins in one checkpoint.** One update. About 1.1 KB of the creator's
  oldest messages leave for the new rows. Then each new message from anyone pushes out the creator's oldest, since
  the creator is now above a 1,961 B guarantee.
- **15 leave at once.** One update drops 15 rows. Their messages stay until space is needed, then leave first,
  oldest first.
- **Admission per checkpoint for the whole room.** At most `n·A ≤ M`.

**Cost per checkpoint.**

- **Membership stable:** zero extra operations. The reducer is O(window) per message, like v4's `fitShare`.
- **Membership changing:** one admin operation in the checkpoint after the change, O(window + rows).
- **On the creator's page:** one O(rows) comparison when each checkpoint installs.

**What a player sees.**

- **On join:** "You can write from the next checkpoint". In practice the grant latches at one checkpoint and the row
  at the next, a few seconds while the room is active. Nobody's history vanishes at the join. Older messages from
  the most active members leave earlier as the room fills.
- **On leave:** the member's last messages stay readable until the room needs the space, and then they go first.
  They remain in every device's archive that saw them.
- **Sending:** "about 10 messages (1.9 KB) per checkpoint, the longest about 1,800 characters" at `N_max` = 16. A
  refused send keeps its text, as today.

## 5. What changes

- **Artifact digest.** The reducer rule changes, so this is a new artifact `v3-shipping-chat.v5` with a new
  blueprint digest and catalog entry. New rooms sign v5 (G25: the signed blueprint digest is the format).
  - v4 rooms keep v4. No migration: there are no users, and v5 refuses to inherit a v4 state as v4 refuses v3.
  - Keeping v4 in the catalog for joining costs nothing, and it leaves Track W's v4 tests unchanged. Track W's
    tests change only if the owner prefers to replace v4 in place, and RESULT.md would list each change.
  - The only references to the v4 artifact id are Track W's own code and tests: chat-catalogs.ts,
    v3-chat-application.ts, v3-chat-window.ts, blueprint.json, tests/chat-rolling-window-rule.test.ts.
- **Blueprint.** A v5 reducer. `causalJoin`, `acl`, `migrationRecord` and `migrationActivation` stay as in v4, and
  the window rule stays in the compiled reducer. New in v5:
  - `captureCapacity` version 2 with `allowanceBytes`;
  - guarantee lookup;
  - the message reducer's reclaim step;
  - the share-update reducer's fit-to-budget step.
- **Track Q's resource bound.** The values {32,768, 16,384, 16} and the basis are unchanged: every v5 state passes
  Chat's capture under `SHIPPING_CHAT_CAPACITY_STATE_LIMITS`, the reducer never exceeds `M`, and the policy captures
  every joined state before admitting. The reader returns the same limits for v5 states. Track Q's catalog-entry
  check (`resourceBoundBases`, examples/chat) gains the v5 entry. Nothing in Track Q needs re-approval.
- **The archive.** Its format and bound do not change. With borrowing, small rooms keep more history in the shared
  window. Departed members' messages reach the archive as before.
- **Library.** None. `displacementPolicies.capacityAllocation = "expire"` and the identity for allocations are app
  hooks. If step 2's RED test shows that a non-member can still be admitted, I stop and report before relying on
  it.
- **Page** (examples/chat; Track V owns examples/grid and examples/v3-chat only):
  - the creator's automatic share update;
  - send status text for the allowance;
  - if the owner says yes (decision 3), grant/revoke controls and reopening as a Writer.

## 6. Plan after the go-ahead (for reference)

**RED tests first.** Each fails on v4 or is missing in v4:

- the C5 precondition: a non-member's operation is not admitted in E (ordinary, own rebase, settlement source);
- the C3 rebase example: an offline member's backlog re-fits after a burst of joins;
- reclaim never touches the current checkpoint (seeded randomized rule test, as Track W's 40 rounds);
- the share update is idempotent and independent of order;
- a joiner speaks from the checkpoint after the update;
- a departed member's messages go first under pressure;
- a displaced update expires without ending the admin's session;
- the bound over a 300-checkpoint run with joins and leaves.

**Then implement and prove**, as the brief says: native 300-checkpoint run with joins and leaves, Track X's harness,
Track M's harness, e2e, suites against base, typecheck, shadow guard, RESULT.md.
