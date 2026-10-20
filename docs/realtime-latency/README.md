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
| Creator maintenance in the lull, per epoch | 2.1–2.8 s, off the transition path (Track R3 targets this) |
| Move visible to the mover / to peers during a lull, presentation on | 1–2 ms / 4–9 ms |
| Ordinary issue p50 (creator / recipient) | 85 ms / 42 ms |
| Remote accept p50 | 67 ms |
| Longest main-thread task: seal / adoption / lull | 17.7 / 38.2 / 23.1 ms |

Per-transition cost is flat from t4 to t11: the cost no longer grows with room age.

## Decision log

All decisions were taken on 2026-10-19 on branch `codex/phase3a1b-p6-golden-path`. "User" marks a decision the
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
| 17 | Track R3: write spec slices S1–S6, then build the watermark design for production. The new path becomes the default only after three-engine and SIGKILL evidence. | User | The only path to millisecond maintenance. It changes durable formats, so the spec comes first. | In progress |
| 18 | Track L: fix two bugs on the current path. After a lull and a reopen, recipients admit no moves; and the lull's history repair races a persisted close. | User | Play stops after a restart. Both bugs predate this work. | dcab6d12..88467723. A reopened recipient discharges its completed-retirement halt by re-running the original reconstruction. An orderly close cancels the retained republish it is serving. The Grid runs the final recipient lull again. |
| 19 | Keep these records in the repository. | User | Decisions and plans should live with the code. | This folder |

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
| [20](tracks/20-track-r2-r3-watermark-retirement/README.md) | Tracks R2 and R3: single-database watermark retirement | Prototype; R3 in progress |
| [21](tracks/21-track-k-epoch8-retention/README.md) | Track K: epoch-8 recipient refusal | 742a517e–9f606ce8 |
| [22](tracks/22-track-l-reopen-and-close/README.md) | Track L: reopen admission and close race | dcab6d12..88467723 |

The record for an in-progress track (R3) holds only its plan. Its specs, tests and results land with its branch.

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

- **Track R3:** single-database watermark retirement, spec slices S1–S6 and then production code. This is the only
  path found to millisecond maintenance.
- **Left open by Track L** (details in its [RESULT.md](tracks/22-track-l-reopen-and-close/RESULT.md)):
  - A recipient reopened after only 4 epochs is refused with `RECOVERY_CERTIFICATE_UNPROVEN_ABSENCE`. It fails
    closed; 5 and 8 epochs pass. Cause: `acquireCreatorSnapshotRetirementReconstructionRequest` passes no
    `previousCertificate`. This is in R3's area.
  - A recipient reopened with an active (unfinished) retirement intent stays halted, as before. A receive-only
    peer has no way to resume an intent.
  - Moves that arrive during the ~0.5 s reopen discharge are dropped, then re-fetched through retained history,
    so they arrive one round trip late.
  - A close during a reopened room's startup transition is recorded as a terminal failure.
- **Recipient install total:** +42 ms mean in Track H's pairs, within noise. Re-measure if it persists.
- **Not repaired:** rooms that already leaked journal scopes before Track K stay fail-closed until an explicit
  migration.
