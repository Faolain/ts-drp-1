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
| 23 | Start Tracks O, M2, P and Q in parallel. | User | O: the case 8 fix. M2: 14b stage 2, the in-memory ledger that removes the ~282 ms cold acquisition per boundary. P and Q fix two problems Track M found on every path: Canvas issuance grows one row per move with an O(outbox) issue cost (829 ms → 6.7 s per move by epoch 16), and the shipped Canvas and Chat creators never run their lull, so retirement runs inline at seal (about 2.7 s). | O merged with M (row 24). P merged (row 27). Q held (row 25). M2 in progress. |
| 24 | Accept Track O's 14b/14e amendment, and merge Tracks M and O together. | User | O's fix makes each boundary one decision, with one epoch's signing evidence and summaries as one unit, in a fixed unit order. A crash or refusal between continuations then resumes from a fresh acquisition (G3, G14). Track M's suggested fix left a second split point open. | Merge 8c61863e, after verification on O's head: typecheck 0, 13 room test files passing, the proof-accounting test file identical to the main branch, and 14f case 8 passing with a real SIGKILL. |
| 25 | Hold Track Q. | Coordinator | Its Canvas and Chat resource bounds work (seal 0.07–0.14x of before), but running the lull exposes a pre-existing bug. A persisted reopen right after the creator's first maintained lull is refused with `floor-stale` (a stored signing-summary resume-basis digest differs on resume, CRD:19350). R3's 4-rollover room test now reaches it and fails. The Grid hits the same bug when reopened at epoch 4. | Not merged until the bug is fixed |
| 26 | Track S: fix the reopen right after the first maintained lull, on the shared path; Track Q then rebases onto it. | User | The bug predates this work and also affects the Grid; it blocks Track Q. | In progress |
| 27 | Merge Track P's per-move fix, and keep its storage assertion red until the user decides how Canvas issuance is retired. | Coordinator | Each hot successor wrapped its source's issuance facade in one more facade, so one recovery read went through s - 1 facades at epoch s. A successor now wraps its source's native store, the same structure a reopen builds. Creator outbox page reads per move went from 54 at epoch 8 and 103 at epoch 15 to a constant 10; the Writer recipient's went to a constant 2. | Merge a3f3f6b0 (8ed37d08..47a936fe), after verification on the merged tree: typecheck 0, Track M and O's room tests passing (38 of 38), and Tracks K, L, N and R3's native tests passing. Track P's per-test suite diff against its base shows no new failures. |
| 28 | Canvas issuance: give the shipped apps the settlement profile (R-A), for shipped Canvas, the Grid example and the v3-chat demo. Do not write a deletion rule for the legacy profile (R-B). Track T makes the switch. | User | Track P found a spec gap: every issuance deleter requires a settlement profile, so `creator-trusted-v1` keeps every row it issues. At 20 moves per epoch a Canvas creator was refused in epoch 17. The library has no users yet, so changing the shipped profile breaks no one. R-A reuses the reviewed settlement retirement; R-B would need a new spec slice, conformance tests on both native owners and three-engine SIGKILL evidence. The latency bench already runs the settlement profile, so its flat Grid storage did not cover the shipped Grid example. | In progress. Track P's test is the acceptance test; Track T may change only where its profile comes from, not its assertions. The legacy profile keeps its behaviour and is documented as growing. |

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
| 27 | Track Q: Canvas and Chat lull | Held (row 25) |
| 28 | Track M2: verified-fact ledger (14b stage 2) | In progress |
| 29 | Track S: reopen right after the first maintained lull | In progress |
| 30 | Track T: the settlement profile for the shipped apps | In progress |

Folders 27 to 30 land with their branches.

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

- **Retention path (Tracks M and O, merged opt-in):** the creator lull is about 4x shorter. The ≤ 100 ms target needs
  stage 2 (Track M2, in progress). Before the room database with retention can become the default:
  - stage 2;
  - wire 14c's per-owner floor fences into the node, and build 14d migration;
  - review the 512-write cap; a committee of more than about 85 signers makes one signing unit exceed it, and that
    boundary falls back to the existing path;
  - re-measure recipient-lull issue latency (102 → 122 ms p50 in Track M's pairs) and the heap in a fresh process;
  - the owners of the node tests that evaluate original CRD and v3-live.ts source text must review them, because a
    default flip changes that text.
- **Reopen right after the first maintained lull (blocks Track Q; predates this work):** a persisted reopen after
  the creator's first maintained lull is refused with `floor-stale`, because the stored signing-summary
  resume-basis digest differs on resume (CRD:19350-19351, via `installClosedRetirementSourceInRoom`). It fails
  closed, but the room stops. Reopening after two or more maintained lulls works. Track G recorded the symptom.
  Track S is fixing it.
- **Canvas and Chat, on every path (Tracks P, Q and T):**
  - Per-move work no longer compounds with room age (Track P). It is still linear in the rows an owner keeps.
  - The `creator-trusted-v1` profile has no issuance deleter, so an app on it keeps every row it issues. Shipped
    Canvas, the Grid example and the v3-chat demo all run it today. Track T moves them to
    `creator-trusted-settlement-v1` (row 28); the legacy profile keeps growing by design.
  - The shipped Canvas and Chat creators supply no `readOrdinaryApplicationResourceBound`, so their lull never
    runs and retirement stays inline at seal (Track Q, held).
  - Chat storage is flat.
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
