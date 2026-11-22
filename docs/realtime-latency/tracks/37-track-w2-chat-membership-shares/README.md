# Track W2: Chat shares for members who join after creation, and departed members' bytes

**Outcome:** Merged as a fast-forward to 4595492f (898bcdd1..4595492f, on 30cb474e; row 63). New shipped Chat rooms sign a v5 format: up to 16 members with a share are each guaranteed an equal split of the 32 KiB window and may borrow what others leave unused, a departed member's messages leave first when space is needed, and each may add 1,954 bytes per checkpoint. The admin can make a joiner a Writer from the page. v3 and v4 rooms are unchanged, and the library is unchanged. See [RESULT.md](RESULT.md) and [OPTIONS.md](OPTIONS.md).

**Working documents in this folder:** [BRIEF.md](BRIEF.md), [RESULT.md](RESULT.md), [OPTIONS.md](OPTIONS.md)

### Follow-up instruction — Track W merged; start Track W2 options step (2026-10-21 21:56 UTC)

Track W is merged: main fast-forwarded to 82952f37, and the docs commit 3cd2d4e9 adds decision rows 50-52 and folder 33. Thank you.

Next, Track W2 (decision row 43): shares for Chat members who join after creation, and the bytes of members who leave. Your brief is <evidence>/track-w2/BRIEF.md; read it in full. Base: codex/phase3a1b-p6-golden-path at 3cd2d4e9. In your worktree, run `git switch -c track-w2-chat-membership-shares codex/phase3a1b-p6-golden-path` and check `git log -1`. Step 1 is options only: map how membership changes reach the reducer, design the options in the brief (rebalance, reserve, borrowing, an age horizon, or a combination) with a recommendation, write OPTIONS.md and PROGRESS.md under <evidence>/track-w2/, then stop and hand back a short report. Keep the Node 22.15.0 PATH pin and the per-port checks (including 4174, 50000 and 50002).

### Report returned by the agent

Track W2 step 1 is done and I've stopped here. Nothing is built or committed: branch track-w2-chat-membership-shares is clean at 3cd2d4e9, nothing was run, and no processes were left behind.

**Recommendation: "guarantee and borrow"**, a combination of options a, b and c plus dropping the rows of members who leave. I don't recommend d.
1. **Sending allowance:** every member can send a fixed `A` bytes per checkpoint (room epoch). `A` is set by a maximum number of members with a share, `N_max`, and it never goes down.
2. **Guarantee:** an equal split of the 32 KiB window among current members with a share, recomputed when membership changes. It is always at least `A`.
3. **Borrowing:** the window keeps any messages up to the budget. When a new one doesn't fit, the oldest message of someone holding more than their guarantee leaves. Departed members have no guarantee, so their messages go first, but only once the space is needed.
4. **Membership:** after each grant or revoke takes effect, the admin's page issues one share update. Its content is fixed by the checkpoint's member list and the current share list, every peer checks it exactly, and duplicates do nothing. It drops the shares of anyone no longer in the room. A joiner can send from the checkpoint after it.

**Why this and not plain rebalancing (a).** Rebalancing makes the per-checkpoint limit fall when people join. A member who sent near their old limit and went offline gets their unsealed messages refused when they come back. That refusal ends their session and their work never lands, which breaks G2 and G3. The recommended rule:
- never lowers anyone's allowance, so returning work always fits;
- doesn't depend on message order, so crash replay and every peer agree;
- keeps "a message accepted between checkpoints is in the next signed checkpoint";
- stays within 32,768 bytes.

The other options:
- **b (reserve) alone** leaves a solo creator only about 2 KB of shared history.
- **c (borrowing) alone** gives late joiners nothing.
- **d (age horizon)** needs an extra creator operation every checkpoint for the life of the room. It deletes history even in idle rooms, doesn't give joiners a share, and is effectively a TTL, which conflicts with Track W's G7 statement.

**Cost.** The per-checkpoint sending limit (and the largest message) becomes `A` for everyone, where version 4 gave a member their whole share: 32 KB alone, 16 KB with two people. Shared history doesn't shrink: alone, a member keeps about 32.5 KB through borrowing. There's one admin operation in the checkpoint after each membership change and no extra cost while membership is stable.

**Decisions for the owner:**
1. **`N_max`:** 8 gives about 4.0 KB per checkpoint, 16 about 1.96 KB (about 10 messages, longest about 1,800 characters; my suggestion), 32 about 940 B, 64 about 430 B.
2. **Departed members' messages:** leave only when space is needed (suggested), or at once.
3. **Page flow:** whether W2 adds a way to make a joiner a Writer. **Today's shipped Chat page opens every joiner read-only and has no grant control, so no late joiner can speak whatever the share rule is.**
4. **Format:** a new `v5` artifact beside `v4` (suggested: no migration and Track W's tests untouched), or replace `v4` in place.

**Changes:**
- **Artifact digest:** changes (new `v3-shipping-chat.v5`); v4 rooms keep v4.
- **Blueprint:** a new v5 reducer, and the window rule stays in the compiled reducer.
- **Track Q's bound:** values and basis unchanged.
- **Archive:** unchanged.
- **Library:** no change needed. Two Chat-side settings are required: share updates must be set to expire if they miss a checkpoint, and they need an identity.

**Found while mapping:**
- If an admin's share update today misses a checkpoint, the admin's own session ends, because Chat declares no policy or identity for that operation. Nothing on the shipped page issues one, so it isn't reachable there.
- In version 3 and 4, a departed member's row (about 76 B) stays forever. With enough churn (about 430 members over a room's life) the rows alone fill 32 KiB.

**Step 2 starts with one test.** The design assumes someone no longer in a checkpoint's member list cannot have any work accepted in it. The code says so: new messages need the writer group, and settlement needs membership. If the test shows otherwise, departed members' shares stay booked until the existing evidence rule releases them; joining still works.

Note for later runs: Track W's port-wait script doesn't check 4174 yet, so I'll add it before reusing that script.

Files are in <evidence>/track-w2:
- OPTIONS.md
- PROGRESS.md
- bin/calc-shares.mjs

### Follow-up instruction — Owner's W2 choices; go ahead with step 2 (2026-10-21 23:36 UTC)

The owner has chosen for W2. Go ahead with steps 2-5 of the brief.

- Rule: your "guarantee and borrow".
- N_max = 16: A is about 1.96 KB per checkpoint, and the largest message is A.
- Departed members' messages leave only when space is needed, oldest first, and before anyone else's surplus.
- Format: a new v3-shipping-chat.v5 artifact beside v4. New rooms sign v5; v3 and v4 rooms keep their formats, with no migration. Track W's tests stay untouched.
- Add a grant control to the shipped Chat page, so the room's admin can make a joiner a Writer (and revoke it). Late joiners can then speak, and the rule is proven end to end. Keep it minimal, use the library's existing grant/revoke operations, and make no library change. If the page flow needs a library change, stop and report.

Start with the test you named: someone not in a checkpoint's member list cannot have any work accepted in that checkpoint. If it shows otherwise, follow your fallback (departed shares stay booked until the evidence rule releases them) and record it.

Include the Chat-side settings you found: the share update must expire if it misses a checkpoint, and it needs an identity, so a missed update cannot end the admin's session. Add a RED for that case.

Proof as in the brief, plus a real-network run in which a late joiner is granted Writer mid-room and sends, and a member is revoked and their bytes are reclaimed when space is needed. Base: main has moved to ebf4254f (Track X's seal deadlock fix, in packages/node only), so rebase onto it first: `git switch -C track-w2-chat-membership-shares codex/phase3a1b-p6-golden-path`, since nothing is committed yet. Rebuild the dists. Add 4174 to your port-wait script.

### Follow-up instruction — Main moved to 30cb474e (library only) (2026-10-22 03:30 UTC)

FYI: main has moved to 30cb474e. Track X's startup order and readiness ingress hold are now in packages/node (v3-room.ts, v3-live.ts, creator-close.ts); nothing changed under examples/chat. Before your final proofs, merge or rebase onto it and rebuild the dists, then compare suites against 30cb474e.

### Report returned by the agent (2026-10-22 05:22 UTC)

Track W2 is finished: steps 2-5 are done on branch track-w2-chat-membership-shares, rebased onto 30cb474e. The dists were rebuilt there, and every final proof was rerun on the rebased branch. Nothing was pushed, and the worktree is clean on the branch. No library change was needed. No RED, governance or contract test, frozen artifact, registry or vector was edited, and Track W's tests are untouched. docs/realtime-latency/README.md is unchanged.

**Commits (on 30cb474e)**
- 898bcdd1 test(track-w2): pin that a departed author gets no work admitted in a checkpoint whose ACL lacks it. This is the check you asked for first ("C5"); it passes on base.
- 0a6a9f75 test(track-w2): RED for Chat's membership-aware v5 format and its share updates (17 tests, failing on base).
- 7db273d4 feat(chat): v5 format with membership-aware shares in the rolling window.
- bd04297b feat(chat): shipped page signs v5 rooms and lets the admin grant and revoke Writer (page and real-network spec).
- 1b9a3666 refactor(chat): the v5 share update is a plain operation record type (no runtime change).
- 70e5f258 test(track-m): measure Chat's v5 format (`TRACK_M_APPS_CHAT_FORMAT=shares`; the default stays "window").
- dcdda86d test(track-w2): a v5 Chat room runs 300 native epochs with joins, leaves and a crash.
- 4595492f docs(track-w2): RESULT.md and OPTIONS.md in docs/realtime-latency/tracks/37-track-w2-chat-membership-shares/.

**The rule, and why it is deterministic and bounded**
- **State:** the v5 state is `{version 5, messages, capacity}` with at most 16 share rows `[author, guarantee, sinceEpoch]`.
- **Budget:** W(n) = 32,768 − 2 − the encoded size of an empty state with n rows at their widest. With the shipped basis W(1) = 32,483 and W(16) = 31,268.
- **Allowance:** A = floor(W(16)/16) = 1,954 bytes. Each holder may add at most A per checkpoint, and A is also the largest message.
- **Guarantee:** an equal split of W(n) among the rows, so every guarantee is at least A.
- **Reclaim, in the compiled reducer:** while the window is over budget, the oldest message whose author has no row (a departed member) leaves first. Otherwise the oldest message of a holder above its guarantee leaves.
- **Share update:** one admin operation in the checkpoint after a membership change, carrying that checkpoint's epoch and ACL digest. Its rows are a pure, idempotent formula of the current rows and the latched ACL, so every copy is identical. It is not charged to anyone's allowance.
- **A missed share update expires instead of being rebased** (`{capacityAllocation: "expire", message: "rebase"}`, identity `capacity:<epoch>:<aclDigest>`), so it cannot end the admin's session. Room test (a) is the RED you asked for, and it passes.
- **Deterministic:** admission depends only on the checkpoint's base rows and the author's own running total, never on order. Nothing admitted in a checkpoint can leave before that checkpoint is sealed, with joins and leaves in any order.
- **C5 held:** someone outside a checkpoint's ACL gets nothing admitted in it, so the fallback was not needed.
- **Bounded:** every state fits in 32,768 bytes, and Track Q's resource bound is stated for v5.
- **Evidence:** a differential test checks the compiled reducer against an independent model over 30 random rooms.

**What a player sees**
- **Everyone** sees their own author ID.
- **The admin** gets a Make Writer / Revoke Writer panel built on the library's existing ACL grant and revoke. The page then issues the share update by itself, and retries 3 s after a refusal.
- **A joiner** follows read-only, and the message box gives the reason it is closed: not a Writer, waiting for a share, or "you can send from checkpoint N".
- **When the joiner's share is in force,** the first Send reopens the device as a Writer and the message is accepted in 141-203 ms on real networking.
- **A revoked member's** messages stay until the window needs the space. They then leave first, oldest first.
- **v3 and v4 rooms** keep their rule and format; nothing migrates.

**Digest change**
- New rooms sign v5: artifact digest e500af00…cae3a, blueprint digest f9aba9c0…847349. A new room's genesis, state and checkpoint digests therefore differ from a v4 room's.
- The v5 state digest also covers the share rows and the fixed allowance and budget.
- v3 and v4 are unchanged byte for byte.

**Over 300 epochs with joins and leaves (native SQLite, 4/4 pass, run twice: once on ebf4254f, once on 30cb474e)**
- **Schedule:** joiners granted at epochs 21 and 181 speak at 23 and 183. Members revoked at 101 and 251. Every peer reopens mid-epoch at 151.
- **Every epoch:** every peer's digest equals the creator's and an independent model's, and the mid-epoch reopen replays to the same state.
- **Departed members:** each revoked member had 33 messages in the window. They all left first, over 11 and 12 epochs. Both runs did this at exactly the same epochs.
- **State:** at most 32,746 bytes.
- **Storage:** the creator's stores stay at 134-142 rows and 199-207 KB, slope −3.9 B per epoch. A joiner's stores step up once when it becomes a Writer, then stay flat.
- **Latency medians, epochs 71-300, on 30cb474e (ms):** seal 314, adoption 865, install 240, creator lull 3,058, other lulls 1,342.
  - Slopes on this run are positive (seal +2 ms per epoch), and all of it comes from epochs 246-300, while the machine's load was climbing from 14 at the start to a 15-minute average of 110-122.
  - The ebf4254f run had the same room and schedule with falling load. Its slopes are zero or negative and its last segment was its fastest (seal 287, adoption 785, install 222).
  - State and storage are flat in both runs, so the rise follows the machine's load, not the room.
- **Real networking (shipped page, Chromium, on 30cb474e):**
  - The membership spec passed: a late joiner is granted Writer and sends at checkpoint 3. After the revoke, its messages stayed while the window filled (epochs 7-21) and were reclaimed first at epochs 22-23.
  - Track X's harness: 16/16 twice, and 30/30 with 240 messages, more than the window holds.
  - From checkpoint 5 the seal steps up to 3.3-9.1 s. The page doesn't run the library's per-epoch recovery-pool maintenance (the lull), so each seal carries it. Track W's v4 page shows the same step, so it is not new in v5; decision row 54 (Track Z) addresses it.
- **Format cost:** Track M's 80-epoch Chromium pair shows v5 at or below v4 (seal 274 vs 288 ms). A paired native benchmark showed no measurable cost either way. Canvas/Chat e2e passed 9/9.

**Per-test suite diff against 30cb474e**
| Set | Base (passed/failed/skipped) | Branch | Differences |
| --- | --- | --- | --- |
| chat | 116/5/19 | 116/5/19 | 0 |
| native6 | 35/15/0 | 35/15/0 | 0 |
| Track X | 89/1/0 | 89/1/0 | 0 |
| root | 870/904/98 | 871/903/98 | 1 |
| W2 unit tests | (not at base) | 20/0/0 | new |

The one root difference is the phase-4c 64 MiB test: it timed out at base under load and passes on the branch. Run alone at base it passes in 11 s. The failures shared by base and the branch are the same tests in each set.

**Typecheck:** `pnpm -r typecheck` gives 0 errors, and the shadow guard exits 0.

**Test changes after the RED commit** (all W2's own, listed in RESULT.md):
- The rule test's size helpers now start at 140 bytes instead of 130; no assertion changed.
- Room test (b) now follows the page's flow because of a library constraint: the joiner reads until its share is in force, then reopens as a Writer and sends. The refusal of a Writer before its share starts is still asserted in the rule test.
- The test fixture gained a `promote` reopen option.

**What remains**
1. A device must have followed the previous checkpoint before it can become a Writer. Lifting that is a packages/node change to predecessor recovery in v3-live.ts.
2. A revoked member's page stops following: its next install fails with D110C_B_ACTIVATION_STALLED.
3. A displaced ACL operation from an admin other than the creator is fatal in every Chat format. This comes from `validateDisplacementPolicy` in the library; the shipped page's only admin is the creator, so it doesn't arise today.
4. A 17th Writer waits until a holder leaves.
5. Everyone's per-checkpoint sending limit is A (1,954 bytes), the cost of N_max = 16.
6. The 32 KiB room-state cap is unchanged from Track W.

Evidence is under <evidence>/track-w2/; PROGRESS.md there is up to date.
