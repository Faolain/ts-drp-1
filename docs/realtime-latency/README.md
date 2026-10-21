# Real-time latency work (October 2026)

This folder records the work to bring ts-drp's transition and per-move latency from seconds into the range a
real-time game needs. It holds:

- every investigation track, with the plan (brief) each one was given;
- the follow-up instructions each track received;
- the report each track returned;
- each track's working documents;
- the decisions taken on each track, and why.

The safety bar for all of this work is the golden-path guarantee checklist,
[specs/bounded-storage-lifecycle/golden-path-guarantees.md](../../specs/bounded-storage-lifecycle/golden-path-guarantees.md)
(G1–G28). No track was allowed to trade one of those guarantees for speed.

## The problem

The healthy-native Grid benchmark (4 active clients, 64-member roster, creator-local) measured the final transition
at:

| Step | Before this work |
|---|---|
| Sealing | 8,031.5 ms |
| Creator adoption | 2,544.7 ms |
| Cumulative | 10,576.2 ms |

Every move also waited behind that work, so a game stalled for seconds at each epoch transition.

## Root causes, in short

- **Retirement ran inline.** From transition 4 on, the recovery pool is full (`maxRecoveryScopes` = 4). Every close
  retired one scope inline before it could persist the next. Recipients did the same turnover inside install.
- **Maintenance cost is architectural, not a hotspot** (Track E). Each maintained epoch:
  - runs four passes;
  - re-reads and re-authenticates the whole recovery state in each pass, about 11k IndexedDB requests with 98%
    repeated decodes;
  - does all that to make about 103 row writes;
  - runs four cross-database two-phase commits over six databases.

  Even a no-op pass costs 0.44–0.86 s, and caching did not help. Only a different storage design (single-database
  watermark retirement) reaches milliseconds, and it must still keep every guarantee.
- **Long rooms failed** (Track K). On recipients, one journal scope per epoch became permanently protected, so the
  journal refused at epoch 8. Separately, protected snapshot holes were sorted as text, so epoch 10 sorted before
  9.

## Where things stand

The numbers are from a 12-rollover Grid run with every lull enabled, presentation on, at commit 9f606ce8, on a
loaded machine (load average about 95).

| Measure | Now |
|---|---|
| Seal, t4–t11 | 260–350 ms |
| Creator adoption, t4–t11 | 490–590 ms |
| Recipient install, t4–t11 | 340–590 ms |
| Creator maintenance in the lull, per epoch | 2.1–2.8 s, off the transition path (Track M targets this) |
| Move visible to the mover / to peers during a lull, presentation on | 1–2 ms / 4–9 ms |
| Ordinary issue p50 (creator / recipient) | 85 ms / 42 ms |
| Remote accept p50 | 67 ms |
| Longest main-thread task: seal / adoption / lull | 17.7 / 38.2 / 23.1 ms |

Per-transition cost is flat from t4 to t11: the cost no longer grows with room age.

On the opt-in room path with retention (Tracks M, O and M2; 8-rollover Grid pairs, load 13–48), the steady lull
is 442 ms on the creator and 252 ms on each recipient. During it, a peer's move is admitted by the creator in 214 ms
p50, and a recipient's own move takes 78 ms p50 to issue.

## Decision log

Decisions 1–21 were taken on 2026-10-19 and the rest on 2026-10-20, all on branch
`codex/phase3a1b-p6-golden-path`. "User" marks a decision the
repository owner made. "Coordinator" marks a recommendation that was then carried out under that approval.

| # | Decision | By | Why | Result |
|---|---|---|---|---|
| 1 | Root-cause the latency, with authority to re-architect. Eight read-only and prototype agents (phase 0). | User | Seconds-long transitions make the library unusable for games. | Findings below. |
| 2 | Land the phase-0 results: codec fast paths; hashDomain, Ed25519 and transition-verify memos; the opt-in `maintainRecoveryPool()` lull API; concurrent per-move admission reads. | User | Biggest measured wins that keep every check. | 4c4f192c |
| 3 | Spawn Tracks A–D: gameplay-safe maintenance, recipient install, per-move admission, retirement CPU. | User | Move maintenance off the gameplay-stalling path. | A, B, D landed in de70325e. C held (row 4). |
| 4 | Hold Track C. | Coordinator | Its held snapshot admission view blocks snapshot writers, which conflicts with concurrent admission (Track F). The gain was about 10 ms per move. | Not merged |
| 5 | Fix the repository typecheck: canonical root link and a separate typecheck tsconfig. | User | Typecheck had to be green before committing. | de70325e (0 errors) |
| 6 | Track E: find out why maintenance is slow, and prove the alternatives. | User | Tracks A–D moved the cost but couldn't shrink it. | It is architectural; watermark retirement was modelled at 2.5 ms. |
| 7 | Spawn Tracks F, G, H: peers' moves, the creator's own moves, long tasks. | User | Minimal latency per game move. | F, G and H below. |
| 8 | Don't merge Track F. | Coordinator | Sound, but maintenance per epoch grew from 3.8 s to 5.2–6.9 s, and the creator's `issue()` from 3.9 s to 5.1 s. | Not merged |
| 9 | Merge Track G, the opt-in presentation overlay. | User | Moves are visible in milliseconds while durable admission waits. The durable path is untouched. | 719e4732 |
| 10 | Rerun Track H with 3 interleaved pairs, and merge only if totals don't regress. | User | The single-pair result was noisy. | Long tasks −8 to −16 ms; totals within noise. Merged after test type fixes: 75aa8807. |
| 11 | Track R: prototype Track E's maintenance redesign (option 1). | User | Reach milliseconds without losing safety. | G1–G28 compiled. Web Locks plus revision counters and skip-fresh-read caching are unsound. Interrupted mid-work. |
| 12 | Track R2: after the typecheck commit, explore and build the most viable Track E alternatives without losing any golden-path guarantee. | User | Reach milliseconds safely. | Single-database watermark retirement is the only option for milliseconds. Prototype: retire p50 about 7 ms, verify-on-open 6–7 ms; on its branch. |
| 13 | Move stale compiled `.js` out of the source tree, and add a guard. | User | esbuild harnesses silently ran stale code. | 6bb9616d. Files archived outside git. |
| 14 | Import canonical by package name in two Playwright specs. | User (cleanup approval) | Fixed an order-dependent clean-checkout failure in storage-browser. | 6fc82c6e |
| 15 | Keep logs, but outside git. | User | Evidence must survive without bloating the repository. | Untracked `.logs` were moved to a local archive. Paths that tracked code imports were restored. |
| 16 | Track K: fix the epoch-8 recipient refusal. | User | Rooms must live for thousands of epochs (G1). | 742a517e, 86dc4004, 9f606ce8 |
| 17 | Track R3: write spec slices S1–S6, then build the watermark design for production. The new path becomes the default only after three-engine and SIGKILL evidence. | User | The only path to millisecond maintenance. It changes durable formats, so the spec comes first. | 84fd4c8f..68b4168e, merged after verification. Specs 14 and 14a–14f; stage 1a of 14a (one room database, one retirement session per install) is opt-in and the default path is unchanged. It is correct but saves only 3–9%, because every per-pass re-proof remains, so the default was not flipped. It also fixed two of Track L's residuals on the shared path. |
| 18 | Track L: fix two bugs on the current path. After a lull and a reopen, recipients admit no moves; and the lull's history repair races a persisted close. | User | Play stops after a restart. Both bugs predate this work. | dcab6d12..88467723. A reopened recipient discharges its completed-retirement halt by re-running the original reconstruction. An orderly close cancels the retained republish it is serving. The Grid runs the final recipient lull again. |
| 19 | Keep these records in the repository. | User | Decisions and plans should live with the code. | This folder |
| 20 | Track M: build slice 14b (retirement decided from a ledger of verified facts) and 14e (bounds and charges) on R3's room path. Every decision must match the existing planner, proven by a differential test. | User | Stage 1a kept the per-pass re-proofs that dominate the lull; 14b is the lever for milliseconds. Target: creator lull ≤ 100 ms p50. | Held on its branch (a301cbe0..07849f85), see row 22. Stage 1 cut the creator lull 2441 → 623 ms and the recipient lull 1253 → 466 ms; the target needs stage 2. No decision deleted anything the existing planner keeps. |
| 21 | Track N: stop each recipient's issuance store growing 3 issued and 3 outbox rows per epoch, and make the Grid's proof-event budget scale with rollovers. | User | Unbounded growth with room age violates G1. R3 found it; it predates this work. | 60161b4a..7464f875, merged after verification. A Writer recipient never closes, so its cleanup always stopped at the cold-material guard before the issuance drain. It now drains its own classified, published, settled prefix through the existing authenticated pruner when its completed retirement decisions match, with no generation effect. Recipients stay flat at 13 rows from epoch 5 through 16 on both paths. |
| 22 | Hold Track M: fix its crash bug first, then merge. | User | Its 14f case 8 breaks G3 and G14 on the opt-in path on all three engines: a SIGKILL between a creator boundary's two decisions leaves the signing control without a summary source, and maintenance then halts. The main branch must not carry a known guarantee break. | Track M stayed on its branch until Track O's fix; both merged in 8c61863e (row 24). |
| 23 | Start Tracks O, M2, P and Q in parallel. | User | O: the case 8 fix. M2: 14b stage 2, the in-memory ledger that removes the ~282 ms cold acquisition per boundary. P and Q fix two problems Track M found on every path: Canvas issuance grows one row per move with an O(outbox) issue cost (829 ms → 6.7 s per move by epoch 16), and the shipped Canvas and Chat creators never run their lull, so retirement runs inline at seal (about 2.7 s). | O merged with M (row 24). P merged (row 27). Q held (row 25). M2 merged (row 29). |
| 24 | Accept Track O's 14b/14e amendment, and merge Tracks M and O together. | User | O's fix makes each boundary one decision, with one epoch's signing evidence and summaries as one unit, in a fixed unit order. A crash or refusal between continuations then resumes from a fresh acquisition (G3, G14). Track M's suggested fix left a second split point open. | Merge 8c61863e, after verification on O's head: typecheck 0, 13 room test files passing, the proof-accounting test file identical to the main branch, and 14f case 8 passing with a real SIGKILL. |
| 25 | Hold Track Q. | Coordinator | Its Canvas and Chat resource bounds work (seal 0.07–0.14x of before), but running the lull exposes a pre-existing bug. A persisted reopen right after the creator's first maintained lull is refused with `floor-stale` (a stored signing-summary resume-basis digest differs on resume, CRD:19350). R3's 4-rollover room test now reaches it and fails. The Grid hits the same bug when reopened at epoch 4. | Unheld after Track S merged (row 33); merged in 46eb7821 (row 38). |
| 26 | Track S: fix the reopen right after the first maintained lull, on the shared path; Track Q then rebases onto it. | User | The bug predates this work and also affects the Grid; it blocks Track Q. | Merged in 19caa468 (row 33). |
| 27 | Merge Track P's per-move fix, and keep its storage assertion red until the user decides how Canvas issuance is retired. | Coordinator | Each hot successor wrapped its source's issuance facade in one more facade, so one recovery read went through s - 1 facades at epoch s. A successor now wraps its source's native store, the same structure a reopen builds. Creator outbox page reads per move went from 54 at epoch 8 and 103 at epoch 15 to a constant 10; the Writer recipient's went to a constant 2. | Merge a3f3f6b0 (8ed37d08..47a936fe), after verification on the merged tree: typecheck 0, Track M and O's room tests passing (38 of 38), and Tracks K, L, N and R3's native tests passing. Track P's per-test suite diff against its base shows no new failures. |
| 28 | Canvas issuance: give the shipped apps the settlement profile (R-A), for shipped Canvas, the Grid example and the v3-chat demo. Do not write a deletion rule for the legacy profile (R-B). Track T makes the switch. | User | Track P found a spec gap: every issuance deleter requires a settlement profile, so `creator-trusted-v1` keeps every row it issues. At 20 moves per epoch a Canvas creator was refused in epoch 17. The library has no users yet, so changing the shipped profile breaks no one. R-A reuses the reviewed settlement retirement; R-B would need a new spec slice, conformance tests on both native owners and three-engine SIGKILL evidence. The latency bench already runs the settlement profile, so its flat Grid storage did not cover the shipped Grid example. | Canvas switched by Track T (row 32). The Grid example and the v3-chat demo are pinned by existing tests and move in Track V (row 34). Track P's test is the acceptance test; Track T changed only where its profile comes from. The legacy profile keeps its behaviour and is documented as growing. |
| 29 | Merge Track M2, the verified-fact ledger (14b stage 2), on the opt-in room path. | Coordinator | Steady lull against Track O's head (3 interleaved pairs per mode): creator 632.5 → 441.6 ms, recipient 490.6 → 251.9 ms. Its decisions equal stage 1's in every shadow and applied-twin comparison, and the 14f native cases pass on three engines with ledger-decided boundaries killed. Nothing changes on the default path. | Merge e0494c5a (111889d6..262f5fa5), after verification on the merged tree: typecheck 0, the ledger, Track M, Track O and Tracks K, L, N and R3's tests passing, Track P's storage assertion still red by design, and the pinned source test failing exactly as at base. The ≤ 100 ms target is not met; readiness capture (~160 ms) needs its own slice. |
| 30 | Track U: settle Track M2's two open measurement questions. Are seal and adoption slower with the ledger in LULL=1 mode? What is the residual heap growth in 100-rollover runs? | User | With the ledger, LULL=1 seal (×1.04–1.54) and adoption (×1.03–1.14) were slower in all three pairs, though neither path runs ledger code. Concurrent mode showed no direction. The heap still grows 0.36 MB per epoch on both stage 1 and the ledger once the harness drops most of its proof events; nobody knows what grows. Both must be answered before the room path can become the default. | Answered; merged in d60a08af (row 40). |
| 31 | Count the settlement author fence in Track P's issuance check: under the settlement profile each Writer's issue counter rises by its moves plus one fence per successor. | User | Track P's check assumed one row per move, which holds only for the legacy profile. The check stays an exact equality, and the fence count is derived from the profile, so the legacy measurement still expects the moves alone. No other assertion, bound or epoch count changed. | ff0a8b66. Track P's storage test passes on shipped Canvas. |
| 32 | Merge Track T: shipped Canvas signs `creator-trusted-settlement-v1`, with the version-3 ACL that profile requires. | Coordinator | Canvas issuance is flat at 13 rows per peer from epoch 6 through 17 and a reopen (legacy grew 4 rows per epoch), and every store is flat from epoch 8 to 100 in Chromium. At 20 moves per epoch, where the legacy profile was refused in epoch 17, it ran 30 epochs without a refusal. Seal no longer grows with room age (legacy +60–69 ms per epoch). Adoption is a flat 150–280 ms slower, because settled issuance is pruned there. No library code changed. | Merge 2e272eb0 (ac17c698..dacb9870), after verification on main: typecheck 0, the Canvas, ledger and genesis-roots tests passing. |
| 33 | Merge Track S, and unhold Track Q. | Coordinator | The creator's first maintained lull replayed its finished signing summary, whose stored resume basis then went stale as the epoch's lawful moves landed, so a persisted reopen was refused `floor-stale`. One removed condition in `classifyClosedSigningSummaries`: a finished summary is never replayed, and the same pass makes a fresh decision. The `floor-stale` check is unchanged. | Merge 19caa468 (5a7491f8..40d50ea3), after verification of main + Tracks T and S together: typecheck 0, Track S's six tests and every room, ledger and long-room test passing, the pinned source test failing exactly as at base. Track Q is rebasing onto it. |
| 34 | Track V: amend the tests that pin the Grid example's and the v3-chat demo's genesis bytes, changing only the profile name and the ACL version in a separate commit, then switch both apps to the settlement profile. | User | Completes row 28 for all shipped apps. The pins describe the products' current genesis, not a guarantee. If the contract needs more than those two values, Track V stops and reports. | Stopped; see row 36. |
| 35 | Track W: shipped Chat keeps a rolling window of recent messages in its shared state, and each device keeps a local archive of what it has seen. Late joiners see only the window. | User | Shipped Chat keeps every message in its replicated state against a lifetime 32 KiB budget, so it refuses new messages near epoch 57 at 4 messages per epoch. Raising the cap would make every transition heavier with room age (G1) and still hit a wall. A window keeps the state and transitions flat; the archive keeps each player's history. The window and archive sizes are reviewed limits (G21) for the owner. | In progress |
| 36 | Hold Track V's Grid switch on its branch, and put its Chromium reproduction and RESULT.md on main. | Coordinator | On Node the switch keeps the shipped Grid's issuance flat (13 rows per peer through 16 epochs and a reopen; legacy reached 33). In Chromium with real networking, the creator's settlement fence reaches the Writer before install and is rejected; after a few successors (epoch 4-5, 33-41 s in) the creator's moves never reach the Writer again, in every run. Legacy passes 16/16. That breaks G3. v3-chat was not switched: its contract oracle is applied to the v3-chat product and to a legacy direct room in the same test, and every way around that is outside the approval. | Held on branch `worktree-agent-a84dc20beddb97044` (d5a0015f..27fe2688). On main: cedcc628 (harness), 5ed93b67 (RESULT.md). |
| 37 | Track X: find and fix the settlement fence delivery stall in the library. First check whether shipped Canvas and Chat, which already sign the settlement profile, stall the same way on main with real networking. | Coordinator | Track T's and Track Q's Chromium evidence used a harness without the shipped page's networking, so main may carry the same G3 break for Canvas and Chat. Fix first, then merge Track V's switch. | In progress |
| 38 | Approve Track Q's ordinary resource bounds, and merge Track Q. | User (bounds), Coordinator (merge) | Canvas: the exact encoded size of its widest reachable state (2,944 bytes, 817 items, depth 3 at 10×10). Chat: its existing 32 KiB retained-state limits, unchanged. Both come from limits the apps already enforce (G21) and cover every reachable state (G22). With them, the creator lull runs, and seal falls to 0.09–0.12× of base in Chromium (about 0.2 s); adoption is 190–255 ms slower; seal plus adoption is 0.32–0.42× of base. | Merge 46eb7821 (ff22665c..30937f29), after verification on main: typecheck 0; Track Q's bound and lull tests, the 4-rollover room test, Tracks P, S, N, L, K, M2 and O's tests, and the 6-epoch Canvas/Chat long rooms with a reopen all passing. |
| 39 | Keep shipped Canvas on the settlement profile on main and fix forward, although it stalls with real networking. | User | Track X's first step: with real networking in Chromium, shipped Canvas and shipped Chat on main each stall at epoch 5 on the creator's first move, with Track V's signature. Canvas on the legacy profile (b2c3d8f1) passes 16/16 twice. Chat has signed the settlement profile since before this work, so it stays exposed either way. Neither page rolls a room over by itself. Switching Canvas back would bring back its storage growth and turn Track P's and Track Q's Canvas tests red. | Known G3 break on main for settlement rooms that roll over with real networking, until Track X's fix lands. Track X also checks whether Chat's stall predates this work (3c5bb123) and bisects if not. |
| 40 | Merge Track U (measurement only). | Coordinator | Seal and adoption are not slower with the ledger: over 21 LULL=1 pairs the median ratios are 0.98 for seal and 1.03 for adoption, and main-thread CPU is 0.99 for both. Idle gaps of 500 ms and 2 s before seal change nothing, so M2's overlap hypothesis is rejected. The residual 0.36 MB per epoch is the harness's records (0.16), the canonical hash memo filling to its ceiling (about 0.1), and a steady 0.08 that heap snapshots attribute to bounded library caches still filling (transition memo, trust-record verdicts, ed25519 and closure-digest memos), V8 optimized code and the harness. Every library grower has a constant ceiling, so G1 holds. | Merge d60a08af (6f1db125..0711a8fb), after verification on main: typecheck 0, the harness-reading tests as on main, and 4-rollover Grid runs passing with the room database and retention in LULL=1 and concurrent modes. The concurrent case, which failed at persisted reopen before Track S, now passes. |
| 41 | Track Y: measure how much of each library cache a steady game uses, drop transition-memo entries for epochs the room has left, propose the other caches' ceilings with their latency cost, and show memory levelling off past 128 rollovers. | User | At their ceilings the caches hold about 56 MB per client (row 40). Old-epoch transition entries are probably dead weight, so dropping them is approved once measurement confirms it. Lower ceilings for the hash memo, trust-record verdicts, ed25519 memo and closure digests trade memory against latency, so they come back to the owner as proposals. The owner approved a run beyond the Grid harness's 128-rollover limit through a new opt-in that leaves the existing check unchanged. | In progress |
| 42 | Track W's limits: a shared window of 64 KiB per room (Track W proposed 32 KiB), split equally at creation, with each member's own oldest message leaving first, at most one share sent per checkpoint and the largest message one share; a device archive of 2,000 messages or 1 MiB per room per device, oldest first. | User | 64 KiB doubles the shared history every peer sees. Every transition carries and hashes the larger state, so Track W measures that cost against 32 KiB. Track Q's resource bound for the new format must be re-derived from the larger window and approved again (G21, G22). The archive is device-local application data, outside room storage (G1). | In progress (Track W) |
| 43 | A follow-up track (W2) gives members added after creation a share of the window, and releases a departed member's bytes. | User | Today's design divides the whole budget among the members at creation, so a later member cannot send. That predates Track W, which keeps it. | After Track W merges |
| 44 | Track Y's ceilings: keep the canonical hash memo at 32 MiB and 32,768 entries; lower the trust-record verdicts to 128 entries and 262,144 characters, the ed25519 verify memo to 2,048 entries and the closure digests to 512 entries. | User | Each cache is a pure speed-up: its key is the exact input bytes, and an eviction only makes the work run again (Track Y's map, with shadow-mode checks finding 0 mismatches). None of the three lowered caches lost a hit in any measured run. Keeping the hash memo full avoids any re-hashing cost, including on Node hosts serving several rooms. With the transition-memo trim (row 41), a client's caches at their ceilings go from about 64.5 MB to about 42 MB. | In progress (Track Y) |
| 45 | Track X continues: on the settlement profile, the creator's startup readiness preparation must not wait for a subscriber, so the first placement after a join takes the warm path. Then Track V's held Grid switch merges with d9346 unchanged. | User | Track X found that the startup barrier publishes accepted rows before it prepares readiness, and publishing waits for a subscriber, so the first placement after a join waits up to about 1.5 s. Amending the d9346 assertion would have accepted that wait. | In progress (Track X) |
| 46 | Track Z: new rooms use the room database with retention, and the lull where the app supports it, by default. Existing rooms keep the host they were created on, with no migration. First attribute the shipped pages' seal, adoption and install, and show what the flip buys, before building it. | User | With real networking, the shipped pages' creator seal takes 3–9 s (Track X), and the bench's default mode seals in about 3.4 s against about 0.26 s on the opt-in path. The shipped examples never opt in. No migration follows row 28 (R-A): the library has no users yet. | After Track X merges |
| 47 | Merge Track Y: the transition memo keeps a room's newest two epochs, and the owner's three lowered ceilings (row 44). | Coordinator | Every cache is a pure speed-up: the key is the exact input bytes, a hit compares every byte, and eviction only makes the work run again; shadow-mode checks found 0 mismatches over about 4.2M hits. Transition-memo hits are only ever on the current or previous epoch, so keeping two loses none. A client's caches at their ceilings drop from about 64.5 MB to about 41.7 MB. Over 256 Grid rollovers all memory grows 0.013 MB per epoch late (base 0.202), and at e250 each client holds about 18.7 MB less. Paired latency is unchanged within the same-build control. The three RED tests that count signature checks give the same counts. | Merge 6d0b15ce (6bbd0aac..2ed095ac), after verification on main: typecheck 0, the new RED and the canonical, storage, room and Canvas/Chat tests passing, the three signature-count RED tests failing exactly as at base, Grid runs passing in LULL=1, concurrent (room database and retention) and default modes, Track M's browser long room and the Canvas/Chat e2e passing. |
| 48 | Merge Track X's fix: a recipient that holds an authenticated vertex with a missing dependency asks the creator for retained history (at most once a second per room, and once after each install); the issuance census accepts a migrated Writer's inherited plan; a direct send that never completes cannot hold a room (10 s deadline). Track X's startup-readiness RED stays on its branch with that work. | Coordinator | Root cause: the creator's settlement fence is gossiped at adoption, reaches a recipient before its install and is dropped, and nothing asked for it again; only the retained-request ticks scheduled at open repaired it, so the stall followed the tick count and always hit epoch 5. Shipped Canvas and Chat on main stalled there, and Chat already did at 3c5bb123. The census refused the plan the room itself writes for a migrated Writer, so the joiner could never open its zone (d9346 line 908). With the fix, the creator's first move of each epoch reaches the recipient in 6–203 ms (before: 1.9–3.9 s, then never). | Merge cf6d306f (f2d301d5 merged, then 65505659..cf6d306f picked: the fixture half of 9b6b5f3f and 270c7068..e26cd812), after verification on main with Track Y: typecheck 0; Track X's four RED files passing, the fence RED 3 more times; every room and Canvas/Chat test passing; Grid bench in LULL=1 and concurrent; Chat and Canvas over real networking 16/16; Canvas/Chat e2e 9/9; Grid with Track V's switch 16/16 in the earlier check. A Canvas run in that earlier check hung at the creator's epoch-3 seal. That is a seal deadlock on IndexedDB that predates the fix (base 2 of 30 under a request storm); Track X is fixing it next (row 49). |
| 49 | Track X fixes the seal deadlock by staging the snapshot before `close()` takes its promotion or recovery source, aborting the stage if the source cannot be taken. If that breaks a proof or a pinned order, it stops and reports, with releasing and retaking the source as the fallback. | Coordinator | `close()` takes the source first, which holds the live journal's native read reservation (a readonly IndexedDB transaction that blocks every writer), then stages the snapshot, which waits for earlier tasks in the live plane's queue. An ingress task already dequeued appends to the journal, and that write waits for the readonly view: stage, queue, append and view wait on each other, with no timeout. Any creator ingress append in that window closes the cycle: a peer's retained rows, or a Writer's move. Staging first drains the queue while no view is held, and later ingress returns early. | In progress (Track X) |

## Commits

| Commit | Subject |
|---|---|
| 4c4f192c | perf: cut transition and per-move latency for real-time play |
| de70325e | perf: move recovery-pool turnover off the gameplay path; fix repo typecheck |
| 6bb9616d | test: refuse to run when compiled output shadows a TypeScript source |
| 6fc82c6e | test(storage-browser): import canonical by package name in two Playwright specs |
| 719e4732 | feat(node): opt-in speculative move presentation for real-time play |
| 75aa8807 | perf: shorten the longest main-thread tasks in seal, adoption and lull |
| 742a517e | fix: bound recipient journal retention and snapshot hole order past epoch 8 |
| 86dc4004 | test: keep the final recipient lull skipped in the Grid bench, with the real reason |
| 9f606ce8 | refactor: keep the public role-reconciliation wrapper signature unchanged |
| 1c6a8259 | docs: record the real-time latency tracks, their plans and decisions |
| dcab6d12 | test: RED recipient lull reopen admission and orderly-close repair |
| dd70af0c | test: RED orderly close refusing a retained send through its revoked transport |
| f9828cd0 | fix: an orderly close cancels the retained publication it is serving |
| 2cb1a9fc | fix: a reopened recipient discharges its completed-retirement halt |
| 504e4035 | test: run the final recipient lull in the Grid bench again |
| 9379fc48 | fix: skip the post-resume retained request once the room is closing |
| 88467723 | docs: record Track L's reopen and close fixes, evidence and guarantee argument |
| 4bb6bc7d | docs: record Track L's merge in the real-time latency decision log |
| 84fd4c8f | test: prototype single-database epoch retirement with crash, replay and poison tests |
| d3cc655d | docs: specify single-database watermark retirement as slices 14a-14f |
| 4f0d5e60 | test: RED for per-owner retirement fences in the host floor (slice 14c) |
| 0d6258e3 | feat: add opt-in per-owner retirement fences to the host floor (slice 14c) |
| 9080246e | test: RED for the room database format and owner room mode (slice 14a) |
| 04f7b009 | test: use a valid storage object id in the 14a held-view RED |
| b087617b | feat: add the version-7 room database and owner room mode (slice 14a) |
| 166c0d9c | test: RED for the room retirement session (slice 14a executor) |
| 372e465c | feat: add the room retirement session (slice 14a executor) |
| 2fee9234 | test: RED for owner retirement inside one room session (slice 14a) |
| 0c4e0309 | feat: run each owner's retirement inside one room session (slice 14a) |
| c0729b23 | test: RED for room session acquisition bound to a named owner (slice 14a) |
| 59d23366 | feat: bind room session acquisition to a named owner (slice 14a) |
| 2ff759bb | test: RED for a recipient reopen after four rollovers (UNPROVEN_ABSENCE) |
| a2a77ebd | fix: a reopen's retirement request accepts the previous certificate's receipt |
| 4ffb9574 | test: RED for room-database retirement in the node (slice 14a) |
| 6e9a7899 | feat: run each node retirement install in one room session (slice 14a) |
| 3bc4edfc | fix: a recipient reopen resumes its own unfinished retirement intent |
| 981bb354 | test: opt-in room database for the healthy native Grid |
| 6c18b0c2 | test: native evidence for the room retirement session (slice 14f cases 1-4) |
| 0eb4d0a6 | test: RED for the room host refusing an existing six-database room |
| a07e3206 | fix: the room host refuses an existing six-database room before changing it |
| cd9d2d88 | docs: record slice 14 status and native evidence (Track R3) |
| 8955d40d | style: format the Track R2 prototype files with prettier |
| 68b4168e | docs: record the Track R3 result |
| 9ae59c2e | docs: record Track R3's merge and queue Tracks M and N |
| 60161b4a | test: RED for a Writer recipient's local issuance growing with room age |
| 94cef38a | fix: let a Writer recipient drain its own classified settled issuance |
| eca9b1c2 | test: a recipient with retired issuance keeps issuing across lulls and reopen |
| 8d00935d | test(grid): scale the proof-event observer budget with configured rollovers |
| af83570a | fix: a cold recipient drains only published issuance rows |
| 7464f875 | docs: record the Track N result |
| 5c6b949d | docs: record Track N's merge in the real-time latency decision log |
| a301cbe0 | test(track-m): RED for verified retention decisions (14b) and their bounds (14e) |
| 51d007eb | feat(track-m): verified retention decisions on the opt-in room path (14b stage 1, 14e) |
| de1d64cc | test(track-m): settlement-room differential, including Track N's cold recipient drain |
| 9514ff21 | test(grid): allow endurance runs of up to 128 rollovers (measurement only) |
| 55dbf18a | fix(track-m): keep retention formats off the pinned storage root and the AHE owner's governed IDB calls |
| 05b5d706 | test(grid): scale delivery and proof-event telemetry for endurance runs (measurement only) |
| 8fd92c99 | test(track-m): slice 14f native evidence harness for the retention path |
| da3704ac | test(track-m): Canvas and Chat long-room measurement harness (measurement only) |
| 8a09ceb8 | fix(track-m): keep the original resume, acquisition and classifier code that existing tests run |
| 07849f85 | docs(track-m): record the Track M result (14b stage 1 and 14e on the room path) |
| c6eff8e7 | test(track-o): RED for crash and refusal between the transactions of one retention boundary |
| 96bc9b3c | docs(14b): one epoch's signing work is one unit; signing before its journal prefix |
| 31a274fd | fix(track-o): one retention decision per boundary; one epoch's signing work is one unit |
| a99d8abe | test(track-o): 14f death cases at any continuation, with an optional one-unit cap |
| bc193d75 | fix(track-o): keep the source-text name census of CRD unchanged (unitEpochs) |
| a66a0dea | test(track-o): stale and budget refusals at every split point of a boundary |
| 099db6ce | docs(track-o): record the Track O result (retention crash and refusal resume, 14f case 8) |
| c67c66b7 | docs: record holding Track M and starting Tracks O, M2, P and Q |
| 8c61863e | Merge Tracks M and O: verified retention decisions on the opt-in room path |
| d7f8c39b | docs: record merging Tracks M and O, and holding Track Q |
| 7d51b24b | docs: record starting Track S for the first-lull reopen bug |
| 8ed37d08 | test: a Canvas room's issuance must not grow or compound with room age (RED) |
| 28e34f80 | fix: a successor filters its source's original issuance store, not its facade |
| 47a936fe | docs: record the Track P result |
| a3f3f6b0 | Merge Track P: a successor filters its source's native issuance store |
| 093a367f | docs: record merging Track P and starting Track T for the shipped apps' profile |
| 111889d6 | test(track-m2): RED for the 14b stage-2 verified-fact ledger on the room retention path |
| 3794be41 | feat(track-m2): 14b stage 2, the verified-fact ledger on the room retention path |
| 42f21f29 | test(track-m2): correct three RED premises and the applied-twins oracle |
| 1582ef8c | test(track-m2): the ledger on Track O's split points, and on Canvas |
| 84f50751 | fix(track-m2): drop the ledger before a refused pass reports (14f case 2) |
| f30bad5a | test(track-m): keep the decision's source in the 14f evidence (measurement only) |
| 2908fc79 | test(grid): retain only named proof-event kinds for endurance heap (measurement only) |
| 262f5fa5 | docs(track-m2): result of the verified-fact ledger (slice 14b stage 2) |
| e0494c5a | Merge Track M2: the verified-fact ledger on the opt-in room retention path |
| b2c3d8f1 | docs: record merging Track M2 and starting Track U |
| ac17c698 | Canvas: sign creator-trusted-settlement-v1 into new rooms |
| b9dada54 | Track P's Canvas long-room test follows the shipped profile |
| ea34d5a6 | docs: the legacy creator-trusted-v1 profile keeps every issued row |
| dacb9870 | docs: record the Track T result |
| 2e272eb0 | Merge Track T: shipped Canvas signs the settlement profile into new rooms |
| ff0a8b66 | test: count the settlement author fence in Track P's issuance check |
| 5a7491f8 | test(track-s): RED for a reopen right after the creator's first maintained lull |
| ef57d107 | fix(track-s): never replay a terminal SAME-P signing summary, so a reopen after the first maintained lull plays on |
| 40d50ea3 | docs(track-s): record the Track S result (reopen right after the first maintained lull) |
| 19caa468 | Merge Track S: a reopen right after the first maintained lull plays on |
| 6066c539 | docs: record merging Tracks T and S, and starting Track V |
| dccb8cd4 | docs: record starting Track W for long-running Chat rooms |
| cedcc628 | test: measure the shipped Grid page as a long zone in Chromium (Track V) |
| 5ed93b67 | docs: record the Track V result (Grid stopped at the browser proof) |
| ff22665c | test(track-q): RED for the Canvas and Chat creator lull |
| 17eb3afa | feat(track-q): Canvas and Chat supply their ordinary resource bound |
| 494a1454 | test(track-q): deliver lull-time moves inside the creator lull; browser harness |
| 08e416e6 | test(track-q): record every proof-event kind per long-room window |
| fafa66c4 | docs(track-q): record the Canvas and Chat creator lull result |
| 74801275 | test(track-q): Canvas long rooms use the shipped settlement profile; reopen on every host |
| f4919f12 | test(track-q): browser long room can alternate prebuilt bundles |
| 30937f29 | docs(track-q): RESULT.md for the branch rebased onto 19caa468 |
| 46eb7821 | Merge Track Q: Canvas and Chat run their creator lull |
| 6b9e27cc | docs: record Track V's stop, starting Track X, and merging Track Q |
| 725f291b | docs: record the settlement stall on main and the owner's fix-forward decision |
| 6f1db125 | test(grid): a fixed idle gap before each seal (measurement only) |
| c5175a0d | test(grid): count the harness's other per-epoch records instead of keeping them (measurement only) |
| 9986a215 | test(grid): heap snapshots at named checkpoints (measurement only) |
| acc6a2a2 | test(grid): extra categories for the whole-run task trace (measurement only) |
| 470392f2 | test(track-m-apps): per-epoch heap and heap snapshots in the browser long room (measurement only) |
| 0711a8fb | docs(track-u): result of the lull seal/adoption and endurance heap questions |
| d60a08af | Merge Track U: lull-mode seal and adoption, and the residual heap slope |
| 97fff267 | docs: record merging Track U |
| 760607d9 | docs: record starting Track Y for the library cache memory budget |
| af342318 | docs: record the owner's decisions on Chat's window, cache ceilings, startup order and the default path |
| 6bbd0aac | test(track-y): cache probe for the library's five in-memory caches (measurement only) |
| 333a7744 | test(track-y): RED, the transition memo keeps a constant number of epochs per room |
| b74b7807 | test(track-y): RED collector check takes its weak references in a synchronous frame |
| a3891f11 | perf(node): the transition memo keeps only a room's newest two epochs |
| 5c49dd8e | perf(protocol-v3): trust-record verdict memo holds 128 records / 262,144 key characters |
| 8f77597e | perf(protocol-v3): ed25519 verify memo holds 2,048 entries |
| 0702f6c5 | perf(storage): closure digest memo holds 512 entries |
| 88b29074 | test(track-y): explicit STARTUP_HEALTHY_GRID_ENDURANCE_MAX opt-in for Grid endurance runs past 128 rollovers |
| 00efcc53 | test(track-y): residency-only cache probe for endurance runs (measurement only) |
| 864cc983 | test(track-y): Node long-room probe runner records the heap after a forced GC (measurement only) |
| 2ed095ac | docs(track-y): result of trimming the library caches and sizing their ceilings |
| 6d0b15ce | Merge Track Y: trim the transition memo and lower three cache ceilings |
| 369420d0 | docs: record merging Track Y |
| 4122ab83 | test: measure the shipped Canvas and Chat pages as long rooms in Chromium |
| 7cbbcaef | test: RED for the settlement fence that reaches a recipient before its install |
| d48b57cd | test: RED for a lost creator move that the creator's next move needs |
| 24699ced | fix: a recipient asks the creator again for a dependency it is missing |
| 3e806aff | test: RED for a migrated Writer's settlement plan the census refuses |
| f4c3c5c2 | fix: the issuance census classifies a migrated Writer's inherited plan |
| f2d301d5 | docs: record the Track X result |
| e94f9d5b | Merge Track X: a recipient re-requests a missing dependency; the census accepts a migrated Writer's inherited plan |
| 65505659 | test: the Track X fixture can gossip through the genuine network publication |
| eeddd65a | test: RED for a direct send that never completes |
| 38625ca8 | test: hang diagnostics for the Track X shipped-app harness |
| f4548274 | fix: a direct send that never completes cannot hold a room |
| e58e9c9a | test: IndexedDB/lock probe and a history-request storm for the Track X harness |
| 3371c81e | docs: record the Canvas harness hang |
| cf6d306f | test: let pending history requests finish before the lost-move RED loses its move |

The commit messages hold the detailed explanation and the measurements for each change.

## Tracks

Each folder under [tracks/](tracks/) has a README with the brief, the follow-up instructions and the report, plus
that track's working documents.

| Folder | Track | Outcome |
|---|---|---|
| [01](tracks/01-phase0-maintenance-pass-map/README.md) | Phase 0: map the close-time maintenance passes | Read-only map |
| [02](tracks/02-phase0-adoption-fence-map/README.md) | Phase 0: map the creator adoption fence path | Read-only map |
| [03](tracks/03-phase0-off-critical-path-design/README.md) | Phase 0: design moving maintenance off the close path | Design |
| [04](tracks/04-phase0-prior-art/README.md) | Phase 0: prior art for non-stalling epochs | Research |
| [05](tracks/05-phase0-recipient-install-root-cause/README.md) | Phase 0: root-cause recipient install latency | Analysis; led to Track B |
| [06](tracks/06-phase0-retirement-redesign-prototype/README.md) | Phase 0: non-blocking retirement (lull API) | 4c4f192c |
| [07](tracks/07-phase0-per-pass-cpu/README.md) | Phase 0: per-pass re-authentication CPU | 4c4f192c |
| [08](tracks/08-phase0-per-move-admission/README.md) | Phase 0: per-move admission latency | 4c4f192c |
| [10](tracks/10-track-a-gameplay-safe-maintenance/README.md) | Track A: gameplay-safe maintenance | de70325e |
| [11](tracks/11-track-b-recipient-install/README.md) | Track B: recipient install off the critical path | de70325e |
| [12](tracks/12-track-c-per-move-admission/README.md) | Track C: amortize per-move admission | Held |
| [13](tracks/13-track-d-retirement-cpu/README.md) | Track D: retirement maintenance CPU | de70325e |
| [14](tracks/14-track-e-maintenance-root-cause/README.md) | Track E: maintenance root cause and alternatives | Analysis |
| [15](tracks/15-track-f-concurrent-admission/README.md) | Track F: admit moves during maintenance | Not merged |
| [16](tracks/16-track-g-presentation-overlay/README.md) | Track G: optimistic move presentation | 719e4732 |
| [17](tracks/17-track-h-long-tasks/README.md) | Track H and the H2 rerun: main-thread long tasks | 75aa8807 |
| [18](tracks/18-track-r-redesign-guarantees/README.md) | Track R: redesign against the guarantees | G1–G28 and verdicts |
| [19](tracks/19-typecheck-fixes/README.md) | Repository typecheck fixes | de70325e |
| [20](tracks/20-track-r2-r3-watermark-retirement/README.md) | Tracks R2 and R3: single-database watermark retirement | 84fd4c8f..68b4168e, opt-in; latency goal not met |
| [21](tracks/21-track-k-epoch8-retention/README.md) | Track K: epoch-8 recipient refusal | 742a517e–9f606ce8 |
| [22](tracks/22-track-l-reopen-and-close/README.md) | Track L: reopen admission and close race | dcab6d12..88467723 |
| [23](tracks/23-track-m-verified-fact-retirement/README.md) | Track M: verified-fact retirement (slices 14b and 14e) | a301cbe0..07849f85, merged in 8c61863e |
| [24](tracks/24-track-n-recipient-issuance-growth/README.md) | Track N: recipient issuance growth | 60161b4a..7464f875 |
| [25](tracks/25-track-o-retention-crash-resume/README.md) | Track O: crash resume on the retention path (14f case 8) | c6eff8e7..099db6ce, merged in 8c61863e |
| [26](tracks/26-track-p-canvas-issuance-growth/README.md) | Track P: Canvas issuance growth and O(outbox) issue cost | 8ed37d08..47a936fe, merged in a3f3f6b0; storage growth left to Track T (row 28) |
| [27](tracks/27-track-q-canvas-chat-lull/README.md) | Track Q: Canvas and Chat lull | ff22665c..30937f29, merged in 46eb7821 |
| [28](tracks/28-track-m2-verified-fact-ledger/README.md) | Track M2: verified-fact ledger (14b stage 2) | 111889d6..262f5fa5, merged in e0494c5a |
| [29](tracks/29-track-s-first-lull-reopen/README.md) | Track S: reopen right after the first maintained lull | 5a7491f8..40d50ea3, merged in 19caa468 |
| [30](tracks/30-track-t-settlement-for-shipped-apps/README.md) | Track T: the settlement profile for the shipped apps | ac17c698..dacb9870, merged in 2e272eb0; Canvas only |
| [31](tracks/31-track-u-lull-seal-and-heap/README.md) | Track U: lull-mode seal and adoption, and the residual heap slope | 6f1db125..0711a8fb, merged in d60a08af |
| [32](tracks/32-track-v-settlement-for-grid-and-chat/README.md) | Track V: the settlement profile for the Grid example and the v3-chat demo | Stopped: Grid switch held (row 36); harness and RESULT.md on main |
| 33 | Track W: a rolling window and a local archive for shipped Chat | In progress |
| [34](tracks/34-track-x-settlement-fence-delivery/README.md) | Track X: the settlement fence delivery stall | 4122ab83..e26cd812 merged in cf6d306f; the seal deadlock and the startup order continue |
| [35](tracks/35-track-y-cache-memory/README.md) | Track Y: trim the library caches and size their ceilings | 6bbd0aac..2ed095ac, merged in 6d0b15ce |
| 36 | Track Z: the room database by default for new rooms | In progress |

Folders 33 and 36 land with their branches.

## Reading the records

The briefs and reports were written for agents working on one machine, so they cite local paths. Those are
rewritten as placeholders:

| Placeholder | Meaning |
|---|---|
| `<evidence>/` | The working directory holding the benchmark runs, traces, test reports, patches and scripts the reports cite. It is not in git. A copy is kept outside the repository at `ts-drp-1-archive/2026-10-19/scratchpad/`, next to the repository. |
| `<archive>/` | `ts-drp-1-archive/2026-10-19/`, the local archive of moved logs, stale compiled files and old worktrees. |
| `<repo>` | The repository root. |
| `<worktree agent-…>/` | An agent's git worktree, a copy of the repository on that agent's branch. |
| `<session>/` | The coordinating session's transcript directory. |

Benchmark numbers come from a heavily loaded development machine (load average 30–250). Claims were made only from
interleaved base/variant pairs, never from single runs.

### Reproducing the benchmark

```sh
STARTUP_ENTRY=r8-source-binding pnpm exec tsx tests/fixtures/startup-discovery/build.ts <new-outdir>
STARTUP_HEALTHY_GRID_ROLLOVERS=8 STARTUP_HEALTHY_GRID_POOL_LULL=1 STARTUP_EVIDENCE=<dir> \
  STARTUP_ENTRY=r8-source-binding STARTUP_SOURCE_NATIVE_RESOURCES=1 STARTUP_ARTIFACTS=<new-outdir> \
  pnpm exec playwright test --config tests/fixtures/startup-discovery/playwright.config.ts \
  --project chromium -g "healthy native Grid integrates"
```

Notes:

- The bundle reads `canonical`, `storage`, `storage-browser` and `compaction` from `dist`. Rebuild them after source
  changes, and build `protocol-v3` before `compaction`.
- The build imports untracked evidence under `.logs/bounded-storage-lifecycle/r8-warm-capacity-01/`.
- Rollover counts: 4, 5, or anything from 8 to 32.
- Optional settings:
  - `STARTUP_HEALTHY_GRID_POOL_LULL=concurrent` runs the lull concurrently with play;
  - `STARTUP_HEALTHY_GRID_PRESENTATION=1` turns on the presentation overlay;
  - `STARTUP_HEALTHY_GRID_TASK_TRACE=window` records main-thread long tasks.

## Open items

- **Retention path (Tracks M, O and M2, merged opt-in):** the steady creator lull is 442 ms and the recipient's
  252 ms, against 2,441 ms and 1,253 ms without retention in Track M's pairs. The ≤ 100 ms target is not met. The creator lull
  is now mostly readiness capture (~160 ms) and the planner's read pass (~125 ms); readiness capture needs its own
  slice, and cutting the read pass (facts recorded at arrival, or one read shared with step B) is a new design
  decision. Before the room database with retention can become the default:
  - seal-time retention still runs stage 1, so creators without an ordinary resource bound (shipped Canvas and
    Chat until Track Q lands) get no gain at seal;
  - wire 14c's per-owner floor fences into the node, and build 14d migration;
  - review the 512-write cap; a committee of more than about 85 signers makes one signing unit exceed it, and that
    boundary falls back to the existing path;
  - re-measure recipient-lull issue latency (102 → 122 ms p50 in Track M's pairs) and the heap in a fresh process;
  - the owners of the node tests that evaluate original CRD and v3-live.ts source text must review them, because a
    default flip changes that text.
- **Library cache memory (Tracks U and Y):** settled by Track Y (rows 44 and 47). At their ceilings a client's caches
  hold about 41.7 MB, most of it the canonical hash memo the owner kept at 32 MiB (about 40.6 MB); 8 MiB would save
  about 30 MB for a few ms per 256 epochs, if a memory budget ever needs it. Node hosts share one set of caches per
  process across rooms, which is unmeasured with many active rooms. Chat's browser plateau needs Track W's window.
- **Left open by Track S** (details in its [RESULT.md](tracks/29-track-s-first-lull-reopen/RESULT.md)): the first
  maintained boundary now writes one classification-only decision instead of a no-op replay (+35 to +63 ms in that
  lull in single runs). No SIGKILL case covers a crash inside that install, and the Grid reopen runs were Chromium
  only.
- **Canvas and Chat, on every path (Tracks P, Q and T):**
  - Per-move work no longer compounds with room age (Track P). It is still linear in the rows an owner keeps.
  - The `creator-trusted-v1` profile has no issuance deleter, so an app on it keeps every row it issues; it is
    documented as such. Shipped Canvas now signs `creator-trusted-settlement-v1` (Track T). The Grid example and
    the v3-chat demo still run the legacy profile until Track V lands.
  - Existing Canvas rooms keep the profile their genesis signed; there is no migration (G25).
  - On the settlement profile, Canvas adoption is a flat 150–280 ms slower, because settled issuance is pruned
    there.
  - With Track Q, the shipped Canvas and Chat creators run their lull. Adoption is 190–255 ms slower in Chromium,
    because the cold ordinary-source capture moved there; removing that would change shared room code
    (`prepareOrdinaryReadiness`). The first seal after a persisted reopen still runs one retirement selection,
    because the lull's early-turnover token is kept in memory only (the Grid too).
  - Track M's application harness (`TRACK_M_APPS=1`) fails Chat on the room and room-retention hosts at epoch 3's
    seal ("creator recovery role transfer source failed: internal-invariant"), on base too. Not yet investigated.
  - Chat storage is flat, but shipped Chat's own 32 KiB retained-state cap (`SHIPPING_CHAT_RETAINED_BYTES`)
    rejects new messages near epoch 57 at 4 messages per epoch, by design and the same at base. Track W replaces
    it with a rolling window plus a local archive (row 35).
  - The RED fixture `startupShippedCanvas` (tests/fixtures/startup-discovery/shipped.ts) still builds a legacy
    invite labelled "shipped"; it passes, but the label is stale.
- **Settlement profile with real networking (Tracks V and X):** fixed by Track X (row 48); shipped Canvas and Chat
  and the Grid with Track V's switch run 16/16 in Chromium with real networking. Left open, with Track X:
  - a seal deadlock on IndexedDB that predates the fix: the creator's `close()` holds the journal's read
    reservation while it waits for the live plane's queue, and a queued journal append waits for that read. It hung
    2 of 30 base runs under a history-request storm, and once in a normal Canvas run. Track X is fixing it (row 49);
  - the startup order (row 45), then Track V's Grid switch;
  - recipients re-request only from the creator, and there is no periodic retry: if an answer is lost and the creator
    sends nothing new, a held move waits for the creator's next move or the next install;
  - the private-WeakMap count in phase-3a1-ac-live-persistence-red (already failing) rose from 18 to 19
    (`v3MissingDependencyRequests`, which must outlive a session's successor planes).
- **Left open by Track V** (details in its [RESULT.md](tracks/32-track-v-settlement-for-grid-and-chat/RESULT.md)):
  - v3-chat needs an owner decision: its contract oracle `isD110cBSuccessorAuthority` also checks a legacy direct
    room in the same test, so switching it means parameterising the oracle, switching those rooms, or accepting
    either profile.
  - With the Grid switch, tests/phase-3a1b-d9346-v3-zone.pw.ts fails: an ordinary placement now builds a finishing
    resource program (perhaps a lawful settlement cost, needing owner approval), and a migrated joiner throws
    "issuance retirement plan has no lineage". Track X fixed the second (a library defect, f4c3c5c2); the first is
    the startup order (row 45).
  - Pre-existing: on the legacy profile the shipped Grid creator cannot reopen after any rollover, because `join()`
    (examples/grid/src/v3-zone.ts:1160-1166) gives it the bootstrap roster instead of the genesis roster.
  - Pre-existing, both profiles: a Node-host Writer reopen right after epoch 2 fails with "unable to open database
    file" in `openNodeSealVoteStore`.
  - The latency bench is not the shipped Grid: it lacks `authorShareMultiplier: 4` and the outcome-commit admission
    policy, uses a 64-member roster, runs lulls and does not open the ephemeral plane. Its Chromium numbers describe
    the bench composition only.
- **Left open by Track N** (details in its [RESULT.md](tracks/24-track-n-recipient-issuance-growth/RESULT.md)):
  - The issuance store's 1,024-row bound limits any Writer, the creator included, to roughly 100 moves per
    epoch. Raising it is a reviewed-limit decision (G21); nothing was changed.
  - A recipient that leaked rows before the fix drains its backlog on its next install if it is still below the
    bound. One already past the bound is untested and may need an authenticated repair.
  - A creator whose material is cold now drains the same way, under the same restrictions. No test or run covers
    that case.
  - The node tests run on the SQLite host; only the Grid covers the room path.
  - The recipient drain depends on the completed AHE and issuance retirement decisions matching. If Track M's
    ledger changes how either is recorded, the drain keeps everything and the growth returns on that path.
- **Before the room database can become the default** (Track R3's [RESULT.md](tracks/20-track-r2-r3-watermark-retirement/RESULT.md) §9–10):
  - 14b and 14e (Track M);
  - wire 14c's per-owner floor fences into the node;
  - 14d, migration of existing rooms; until then the room host refuses an existing six-database room;
  - 14f: SIGKILL cases 5–9 and the browser long room (case 11).
- **Room-path risks:** the retirement session holds one read-write transaction over every room store for about
  106–116 ms at p50 and up to about 380 ms per install, and the recipient install's p90 is wider on the room path.
- **Left open by Track L** (details in its [RESULT.md](tracks/22-track-l-reopen-and-close/RESULT.md)):
  - Fixed by Track R3 on the shared path: the four-epoch reopen refusal (`RECOVERY_CERTIFICATE_UNPROVEN_ABSENCE`,
    a2a77ebd) and the permanent halt on an unfinished retirement intent at reopen (3bc4edfc).
  - Moves that arrive during the ~0.5 s reopen discharge are dropped, then re-fetched through retained history,
    so they arrive one round trip late.
  - A close during a reopened room's startup transition is recorded as a terminal failure.
- **Recipient install total:** +42 ms mean in Track H's pairs, within noise. Re-measure if it persists.
- **Not repaired:** rooms that already leaked journal scopes before Track K stay fail-closed until an explicit
  migration.
