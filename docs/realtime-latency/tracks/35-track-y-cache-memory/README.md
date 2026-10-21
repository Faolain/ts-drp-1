# Track Y: trim the library caches and size their ceilings

**Outcome:** Merged in 6d0b15ce (6bbd0aac..2ed095ac). Every cache is a pure speed-up. The transition memo now keeps a room's newest two epochs, and the owner lowered the trust-record verdicts (128), the ed25519 memo (2,048) and the closure digests (512) while keeping the hash memo at 32 MiB. A client's caches at their ceilings drop from about 64.5 MB to about 41.7 MB, memory levels off over 256 Grid rollovers, and latency is unchanged. See [RESULT.md](RESULT.md).

**Working documents in this folder:** [BRIEF.md](BRIEF.md), [MAP.md](MAP.md), [RESULT.md](RESULT.md)

### Brief (plan given to the agent) (2026-10-21 04:52 UTC)

You are Track Y in a multi-track latency and storage effort on ts-drp, a TypeScript local-first CRDT library. Your full brief is at <evidence>/track-y/BRIEF.md. Read all of it first and follow it exactly, including its hard rules, its order of work and its hand-back point at step 5.

In short: the library's in-memory caches (canonical hash memo, transition memo, trust-record verdicts, ed25519 memo, closure digests) settle at about 56 MB per client in a long room. The owner chose to (1) measure how much of each cache a steady game uses, (2) drop transition-memo entries for epochs the room has left (approved, once the measurement confirms they are dead), (3) propose ceilings for the other caches with their latency cost, for owner approval, and (4) prove memory levels off with a run longer than the 128-rollover harness limit.

Keep <evidence>/track-y/PROGRESS.md current as you go (<evidence> is the scratchpad path given in the brief), so you can resume after any interruption. At step 5, stop and send the coordinator your report with "Ceilings for owner review" in plain language. You will be resumed with SendMessage after the owner decides.

### Report returned by the agent

Track Y, step 5 hand-back. I've stopped here for the owner's decision on ceilings.

`<evidence>` is <evidence>.
- Progress notes: `<evidence>/track-y/PROGRESS.md`
- Map: `<evidence>/track-y/MAP.md`

#### Commits on `worktree-agent-a9be4231f2bd8f2ac` (base 760607d9, not pushed)
- **583ee9b6** test(track-y): cache probe for the five caches (measurement only).
- **60252f06** test(track-y): RED, the transition memo keeps a constant number of epochs per room.
- **5d306d90** test(track-y): the RED collector check takes its weak references in a synchronous frame.
  - A suspended async frame was keeping the last loop entry alive.
  - The test is still RED at base: 10 of 10 old entries survive.
- **d16f3aa4** perf(node): the transition memo keeps only a room's newest two epochs (the trim).

#### Map summary (MAP.md)
**All five caches are pure performance caches:**
- the key is the exact input bytes;
- a hit only skips recomputing a pure function of those bytes;
- evicting an entry only makes the original computation run again.

**None is persisted**, so a reopen starts empty and crash behaviour is unchanged.

**One caveat to know about:** hashMemo's exactness assumes domain strings contain no NUL. Every in-tree domain is a constant without NUL.

**Pins:**
- No tracked test, fixture, frozen artifact, registry, vector or spec pins any ceiling, key or bound, and no file hashes these sources.
- Three RED tests count `ed25519.verify` calls beneath the memo:
  - seam1-red (821/840/920/1316/1458);
  - 0i (521/547);
  - 0p2 (566/576).
- A smaller ed25519 ceiling could change those counts only if a test makes more distinct verifications than the ceiling between a first check and a counted repeat. I will check this in the step-8 per-test diff. If it happens, the amendment needs the owner, since these are RED tests.
- These failures are already present at base and are not mine:
  - seam1: 7;
  - 0i: 1;
  - 0p2: 1 (registry hash);
  - phase-4a-v3-live-blueprint-fold: 3.

**Measurement hook:**
- An esbuild plugin wraps each cache's `new Map()` declaration in a bundle only (`tests/fixtures/cache-probe/`). The build refuses if any declaration doesn't match exactly once.
- The library source is untouched, so shipped code has no flag, no branch and no cost.
- Enabled only by `STARTUP_CACHE_PROBE=1` (Grid), `TRACK_M_APPS_CACHE_PROBE=1` (Canvas/Chat browser) and `tests/fixtures/cache-probe/build-node.ts` (Node). All defaults and checks are unchanged.

**Files touched:**
- **Measurement only:**
  - `tests/fixtures/cache-probe/{plugin,probe,node-long-room,build-node}.ts`
  - `tests/fixtures/startup-discovery/{build.ts, healthy-grid.ts, r8-source-binding.pw.ts}`
  - `tests/fixtures/track-m-apps/browser/{build.ts, entry.ts, long-room.pw.ts}`
- **Test:** `packages/node/tests/creator-transition-memo-epoch-retention-red.test.ts`
- **Library:** `packages/node/src/internal/creator-transition-advance.ts`: `TRANSITION_MEMO_EPOCHS`, `TransitionMemoEntry`, `transitionMemoKey`, and the insert in `inspectCreatorTransitionAdvanceExact`.
- I did not edit creator-adoption*, creator-close, v3-live, room-network or any example.

#### Hit-rate findings (base, all paths and roles)

| Run | hash | closure | ed25519 | trust | transition |
|---|---|---|---|---|---|
| Grid LULL=1, 64 epochs | 0.968 | 0.998 | 0.959 | 0.971 | 0.714 |
| Grid concurrent, 64 epochs | 0.965 | 0.998 | 0.961 | 0.971 | 0.714 |
| Canvas browser, 64 epochs | 0.981 | 0.999 | 0.986 | 0.983 | 0.815 |
| Chat browser, 56 epochs | 0.981 | 0.999 | 0.984 | 0.985 | 0.827 |
| Node Canvas, 128 epochs | 0.995 | 1.000 | 0.995 | 0.994 | 0.933 |
| Node Chat, 56 epochs | 0.994 | 1.000 | 0.994 | 0.994 | 0.937 |

- The Node runs had both roles in one process.
- **Node hosts:** Node clients use the same caches, held once per process and shared by every room and client in it.
- Every cache earns its keep, so I propose keeping all five and only lowering the ceilings.

**How old the hit entries are (epochs since insert, Grid LULL-64):**
- **Transition:** 88% are 0 epochs old, 97% at most 1, 100% at most 2. Nothing older is ever read.
- **Trust:** 100% at most 2.
- **Closure:** 88% at most 4; the oldest is 6.
- **Hash and ed25519:** 88% at most 4 and 95% at most 8. A tail of about 4% are constant entries re-read every epoch.

**What fills each cache today:**
- **Hash memo:** full (32 MiB of parts) by about epoch 16 on the creator and about epoch 48 on recipients. Most of what it holds is write-once retirement images and retention decisions that are never read again.
- **Transition memo:** grows 2 entries (about 88 KB) per epoch and reaches 16 MiB around epoch 190.
- **Trust verdicts:** +7 entries per epoch; reaches its 2M-character cap around epoch 106.
- **ed25519:** 16–66 inserts per epoch.
- **Closure:** 2 inserts per epoch.

#### The trim (d16f3aa4) and its proof so far
**What it does:**
- When a check is stored, entries of the same lineage (genesis anchor plus object of the current trust) more than 2 epochs older than the newest are dropped.
- The key, the hit path and every caller are unchanged.
- The 16 MiB byte cap stays as a backstop for processes holding many rooms.
- A dropped entry only means a later identical check runs the full predicate again. So it cannot change any verdict, admission, digest, ordering or stored byte, and no check is relaxed.

**Proof so far:**
- **RED test:** 4/4 green on the commit; 2 of the 4 fail at base.
- **Keep-2 is lossless:** model replays of every base run (Grid LULL and concurrent, Canvas, Chat, Node Canvas 128 and Node Chat 56) lose 0 hits. Keep-1 would lose 120–620 hits at about 2.3 ms each.
- **Real trim run** (Grid LULL, 32 epochs): at most 4 entries / 178 KB per realm, against 128 entries / 5.6 MB by epoch 64 at base. Same hit pattern.
- **Shadow mode:** every cache hit was re-checked against the uncached computation, in Node long rooms (Canvas 64 and Chat 48 epochs) for both trim and base. There were 0 mismatches over:
  - 3.76M hash hits;
  - 271K closure hits;
  - 96K ed25519 hits;
  - 123K trust hits;
  - 2,610 transition hits.
  Transition hits are identical to base: 2,610 for Canvas and 2,118 for Chat.
- **Storage:** every table's rows and bytes are identical at every epoch. So are lull kinds, retention outcomes and declines, and event kinds. Only the database-file-plus-WAL size differs, and two base runs differ in the same way, so that is checkpoint timing.
- **Transition tests, per test against base:** 472 of 474 are the same. The 2 that differ are load timeouts in opposite directions, and both also time out alone at base.
- **Cost of the trim:** the insert-time scan costs under 1 µs at the real memo size and 7 µs with a full 16 MiB memo. It only runs after a miss that already did a full ~2.3 ms check.
- **Paired latency** (healthy Grid, 8 rollovers, room database and retention, ABBA order), trim/base:
  - **Concurrent, 8 pairs:** seal 1.005, adoption 1.027, install 0.993, move issue 0.985, lulls 0.97.
  - **LULL=1, 14 pairs:** seal 1.018 (pooled medians 261.5 vs 260.3 ms), adoption 1.013, install 1.020, move issue 0.993, lulls 0.99–1.00, reopen 0.985.
  - **Same-build control:** two copies of the same base bundle, interleaved with the runs above, came out at 1.03–1.085 (seal 1.058, install 1.085).
  - Per transition, the LULL seal difference flips sign from one transition to the next, although the trim does the same work at every one.
  - Conclusion: the medians are unchanged within the measurement noise.

#### Ceilings for owner review
Each cache is only a speed-up. A smaller ceiling can only make some work run again: it never changes what is accepted, stored or computed. Figures are per client (one browser tab, or one Node process). Lost hits come from replaying every base run at the smaller ceiling.

**1. Transition memo** (already approved and done)
- Today: 16 MiB, full around epoch 190. Now: the newest 2 epochs per room, with the 16 MiB backstop kept.
- Saves about 18.6 MB (18.8 to 0.2 MB).
- Latency: none measured, typical or worst case.
- A player would notice nothing.

**2. Hash memo**
- Today: 32 MiB / 32,768 entries. Proposed: 8 MiB / 8,192 entries.
- Saves about 30 MB (40.6 to 10.2 MB).
- Typical cost: lost hits per run were 0 (Grid LULL), 17 (Grid concurrent, 0.2 ms over 64 epochs), 2 (Canvas), 0 (Chat) and 27 (Node Canvas, 0.3 ms over 128 epochs). That is effectively 0 ms per transition, and no worse than 0.1 ms in any one epoch.
- Worst case: a burst larger than 8 MiB, such as a long catch-up or history import, can push out entries that get reused. Re-hashing costs about 10 µs plus 7 µs per KiB, so at most about 140 ms in total to refill 8 MiB once, spread over later work. This was not observed in any run.
- Why 8 MiB: losses start between 4 and 2 MiB. At 2 MiB there are thousands of lost hits, up to about 2.4 ms per epoch.
- Alternative: 4 MiB / 4,096 saves about 35 MB. It loses 0–99 hits per run, at most about 1.3 ms over 64 epochs.
- A player would notice nothing.

**3. Trust-record verdicts**
- Today: 1,024 entries / 2,097,152 characters. Proposed: 128 entries / 262,144 characters.
- Saves about 1.9 MB (2.14 to 0.27 MB).
- Latency: none measured. The working set is at most 50 entries, and 32 entries is already lossless everywhere. A miss costs under 0.1 ms.
- A player would notice nothing.

**4. Ed25519 verify memo**
- Today: 4,096 entries. Proposed: 2,048 entries.
- Saves about 0.4 MB (0.81 to 0.39 MB).
- Latency: none measured; 2,048 is lossless in every run.
- Worst case: a constant signature is evicted roughly every 90–290 epochs and costs one re-verification, about 0.6 ms in a browser and up to 1.8 ms in a loaded Node process.
- Option: 1,024 saves 0.6 MB and loses 0–4 hits per run (up to 2.4 ms over 64 epochs).
- A player would notice nothing.

**5. Closure digests**
- Today: 4,096 entries. Proposed: 512 entries.
- Saves about 1.9 MB once full (2.18 to 0.27 MB). With the largest possible keys, the bound drops from 18.9 to 2.4 MB.
- Latency: none measured. The working set is at most 131 per client, and 259 in a Node process with both roles. A miss costs under 0.1 ms.
- Only fills after very long rooms, at about 2 entries per epoch.
- A player would notice nothing.

**Total once every cache is full:** about 64.5 MB today, about 11.3 MB with this proposal, or about 6.2 MB with the 4 MiB hash memo.

**Worst cases common to all of them:**
- **Cold reopen:** unchanged, because every cache starts empty either way.
- **First transition after a long lull:** unchanged. The caches age only by new entries, never by time.

**One decision point for the owner: Node hosts with many rooms.**
- In Node, the ceiling is per process. storage-node's room host shares one set of caches across every room it serves.
- Measured per-room working sets:
  - hash: about 2–4 MiB;
  - trust: about 30 entries;
  - ed25519: a few hundred entries;
  - closure: about 130 entries.
- At the proposed ceilings, one process keeps full hit rates for about 2–4 rooms that are active at the same time. Beyond that, expect roughly 0.2–2.5 ms extra per transition per room.
- This is speed only, never correctness, and I did not measure a multi-room host.
- If many active rooms per Node process matter, keep the hash memo at 16 MiB. That saves about 20 MB instead of 30.

#### After the decision (steps 6–9)
- Apply each approved ceiling in its own commit, rebuilding dist.
- Add the endurance opt-in `STARTUP_HEALTHY_GRID_ENDURANCE_MAX`, leaving the existing checks unchanged.
- Run 256+ epoch memory proofs for Grid, Canvas/Chat and Node; Chat tops out around epoch 57 at 2 moves.
- Repeat the paired latency runs and the per-test suite diffs, then `pnpm -r typecheck`, the shadowed-sources check, and RESULT.md.
- I left no processes running.

### Follow-up instruction — Owner ceiling decisions: keep hash memo, approve three (2026-10-21 13:33 UTC)

Coordinator here. The owner decided the ceilings on 2026-10-21:

- Hash memo: KEEP 32 MiB / 32,768 entries. No change. Don't commit any hash-memo ceiling change.
- Trust-record verdicts: 128 entries / 262,144 characters. APPROVED.
- ed25519 verify memo: 2,048 entries. APPROVED.
- Closure digests: 512 entries. APPROVED.
- The transition-memo trim (d16f3aa4) stays, as already approved.

Continue with steps 6 to 9 of your brief:
- Apply each approved ceiling in its own commit, and rebuild dist.
- Add the endurance opt-in (`STARTUP_HEALTHY_GRID_ENDURANCE_MAX`), leaving every existing check unchanged.
- Run 256+ epoch memory proofs: Grid, plus Canvas, Chat and Node at whatever length their harnesses allow. Show the plateau with the hash memo at 32 MiB; it fills early, so the late slope should be flat.
- Repeat the paired latency runs.
- Diff the suites per test. Watch the three RED tests that count `ed25519.verify` calls (seam1-red, 0i, 0p2). If any count changes at 2,048, stop and report; don't amend them.
- Typecheck and the shadow guard, then RESULT.md in docs/realtime-latency/tracks/35-track-y-cache-memory/.

State the final per-client total in RESULT.md. With the hash memo kept, it should be about 41–42 MB at the ceilings, against about 64.5 MB before.

Main may move while you work:
- Track X's library fix (packages/node: v3-live.ts, room-network.ts, v3-room.ts; packages/issuance-store retirement.ts) will land soon.
- Track W (examples/chat, and the Track M harness under tests/fixtures/track-m-apps/) will land later. It edits tests/fixtures/track-m-apps/browser/long-room.pw.ts and entry.ts, as you did, so expect a conflict there.

Before your final proof, check `git log` on codex/phase3a1b-p6-golden-path, rebase onto it if it has moved, rebuild the dists, and rerun typecheck and your RED and transition tests. Hard rules are as in your brief.

### Report returned by the agent (2026-10-21 17:53 UTC)

Track Y is finished. Branch `worktree-agent-a9be4231f2bd8f2ac` is rebased onto codex/phase3a1b-p6-golden-path af342318, and that branch had not moved when I checked again at 13:53. Nothing was pushed. Every commit ends with the brief's exact line, "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>". RESULT.md is committed at `docs/realtime-latency/tracks/35-track-y-cache-memory/RESULT.md`. Local paths in it are written as `<evidence>/…`, and evidence = `<evidence>`.

**Headline:** per client, the caches at their ceilings drop from about **64.5 MB to about 41.7 MB**. The trim saves about 18.6 MB and the three lowered ceilings about 4.2 MB. The hash memo, kept at 32 MiB, is about 40.6 MB of what remains.

**Commits (oldest first)**
- 6bbd0aac: cache probe, measurement only. A bundle-only esbuild rewrite of each cache's `new Map()`; the library sources are untouched.
- 333a7744: RED test `packages/node/tests/creator-transition-memo-epoch-retention-red.test.ts`.
- b74b7807: fix to that RED test; its collector check now takes weak references in a synchronous frame.
- a3891f11: **the trim.** The transition memo keeps a room's newest 2 epochs. The 16 MiB ceiling stays as a backstop.
- 5c49dd8e: trust-record verdicts capped at 128 records / 262,144 characters.
- 8f77597e: ed25519 verify memo capped at 2,048 entries.
- 0702f6c5: closure digests capped at 512 entries.
- 88b29074: `STARTUP_HEALTHY_GRID_ENDURANCE_MAX` opt-in, integer 129–1024. With it unset, both rollover checks behave as before for every value.
- 00efcc53: residency-only probe, measurement only.
- 864cc983: the Node long-room runner records memory after a forced GC, measurement only.
- 2ed095ac: RESULT.md.
- The hash memo was not changed, per the owner's decision.

**Map summary (pure-cache argument and pins)**
- All five caches are module-level Maps.
- Each key is the exact input bytes, and each value is a pure function of them: a SHA-256 digest, the strict transition predicate's verdict, a decode verdict, a strict Ed25519 verdict, or a closure digest.
- The hash and transition memos also compare every byte on a hit. Inputs they cannot key exactly skip the memo and run the original computation.
- Evicting an entry only means the computation runs again.
- Nothing is persisted: a reopen starts with all five empty, and a crash leaves nothing to recover.
- No tracked test, artifact, registry, vector or spec pins a ceiling.
- The only behavioural pins are the three RED tests that count `ed25519.verify` calls (seam1-red, 0i, 0p2). **Their counts did not change at 2,048, so no amendment is needed.** Their 9 failures (7 / 1 / 1) exist at base with identical messages.

**Hit rates at base**
- Over 64 epochs: hash 0.97–0.995, closure about 1.0, ed25519 0.96–0.995, trust 0.97–0.994, transition 0.71–0.94. Every cache earns its place.
- Transition-memo hits are only ever on the current or previous epoch.
- Trust-verdict hits are on records at most 2 epochs old.
- Closure-digest hits are at most 6 epochs old.

**Why the trim is safe**
- Checks (G3/G5/G26): no check is relaxed. A dropped entry only means the full predicate runs again, and a hit still needs byte equality.
- Memory (G1): the memo holds a constant 4 entries, about 0.18 MB per client, instead of growing to 16 MiB.
- Storage and crashes (G5/G15): nothing is persisted. Every table's rows and bytes were identical to base at every epoch.
- Bounded work (G21): the insert-time scan is bounded and costs under 1 µs at real size, 7 µs with a full memo.
- No game-specific carve-outs (G27): the window is per lineage, from fields every room has.
- Shadow mode, where every cache hit is re-checked against the uncached computation: 0 mismatches over about 4.2M hits.
- Keep-2 lost no hits in any run. In the 256-epoch head runs, its hits equal an unbounded memo's (Grid 6,958, Canvas 5,626).

**Memory over 256+ epochs** (new opt-in; the existing 128 check is unchanged)
- **Grid**, 4 clients:
  - JS heap after GC: 105.6 MB at e128 and 107.3 MB at e256, against 115.8 MB at e256 for base.
  - Late slope: 0.012–0.016 MB/epoch, against 0.035 for base.
  - All memory, ArrayBuffers included, from e150 to e250: +0.013 MB/epoch, against +0.202 for base. ArrayBuffer data is flat.
  - At e250 the renderer holds 74.6 MB less than base, about 18.7 MB per client.
  - Every cache is at its ceiling or steady state, and storage is flat.
- **Canvas**, browser, 256 epochs:
  - Late slope 0.012 MB/epoch (creator) and 0.005 (recipient), against 0.023 and 0.018 at base.
  - 3.9–4.1 MB less JS heap at e256.
- **Chat**, browser, 56 epochs (the app's limit):
  - Late slope 0.010 and 0.081 MB/epoch, against 0.029 and 0.101 at base.
  - The recipient's hash memo is still filling at e56, so no Chat plateau is observed yet.
- **Node long room**, Canvas, 256 epochs:
  - The caches are flat from e32.
  - Heap plus ArrayBuffers at e256: 104.2 MB, against 122.7 MB at base.
  - Heap snapshots attribute the remaining slope to the harness's own records and V8 optimized code. No library cache grows past its bound.
- **Lost hits measured at the new ceilings** (head, full probe):
  - Trust and closure lost nothing anywhere.
  - ed25519 re-verified 4 more signatures over 256 Grid epochs than at 4,096, about 2 ms in total. This comes from FIFO eviction of signatures re-read every epoch.
  - The hash memo is 30 hits short of unbounded in 7.2M; that is the kept ceiling.

**Paired latency, head/base**
- Setup: 7 interleaved pairs per mode, 8 rollovers, room database with retention.
- LULL=1: seal 0.959, adoption 0.958, install 0.996, per-move issue 1.005, lulls 0.97–0.99, reopen 0.966.
- Concurrent: 0.929–0.974 on every path.
- A same-build control (base against a copy of base) gave 1.03–1.085, so none of this is a real change.
- The trim alone, over 14 pairs, also gave 0.99–1.02.

**Suites, per test against base** (every difference was rerun alone on both trees)
- RED ed25519-count tests: identical on both trees.
- Observers: 54/54 on both.
- canonical / protocol-v3 / storage: 303/1 on both, the same test.
- storage-node retirement: 3 child-process timeouts in opposite directions; alone, all pass on both.
- node: +4 (the new RED test). 2 network tests failed at head and 3 proof-accounting tests timed out at base; alone, all pass on both.
- Root (129 files): 3 head timeouts and 15 head skips from one 10 s beforeAll timeout. Alone, the two trees match: all pass except 2 p2-a-lint tests that fail on both with the same message.
- Transition tests at the rebased head: 4 proof-accounting 10 s timeouts; alone, they pass on head and on base.
- **Canvas and Chat e2e: 9/9 on head and 9/9 on base.**
- Files that fail to load are the same on both trees.
- **`pnpm -r typecheck`: 0 errors. `node scripts/check-shadowed-sources.mjs`: exit 0.**
- The e2e had to wait for Track X's 24-run Canvas loop. Its vite servers held the fixed ports 4180/4181, and the e2e tests also reset the shared fixture registry. I did not touch Track X's processes; my waiter (`bin/e2e_when_free2.sh`) ran the e2e only after their loop ended.
- None of my processes or servers is left running, and all my background tasks are stopped.

**What remains, and the risks**
1. **Hash memo.** It is now most of the cache memory: 35–37 MB per client realm. 8 MiB would save about 30 MB per client and lose a few hundred lull hits per 256 epochs (about 4.5 ms). That is for the owner if a memory budget ever needs it.
2. **Busy Node hosts are unmeasured.** In Node, one set of caches is shared by every room in the process. The worst cost of a miss is 0.6 ms (ed25519).
3. **ed25519 eviction is FIFO.** Switching to LRU would avoid the 4 re-verifications; I left it unchanged because the cost is about 2 ms per 256 epochs.
4. **Small non-cache growth remains**, never followed past 256 epochs:
   - Grid: about 13 KB/epoch for 4 clients, from V8 code, strings and the harness's long-task observer entries.
   - Node: the harness's own records and V8 code.
5. **Chat's plateau is not yet observed in the browser.** It needs Track W's rolling window.
6. **Expected conflict with Track W.** Track W edits `tests/fixtures/track-m-apps/browser/entry.ts` and `long-room.pw.ts`, which carry my measurement-only probe hunks; those hunks are self-contained.
7. **Track X has not landed yet.** Its files don't overlap mine, so a rebase should be clean. I did not edit creator-adoption*, creator-close, v3-live, room-network, v3-room, issuance-store, any example, any RED or governance test, or `docs/realtime-latency/README.md`.
8. **The machine was heavily loaded** (load average 40–300). All latency claims rest on paired runs and the same-build control.

Working notes are in `<evidence>/track-y/PROGRESS.md`; the cache map is `MAP.md` and the measurements are under `grid/`, `apps/`, `node/`, `heap/` and `tests/` in the same folder.
