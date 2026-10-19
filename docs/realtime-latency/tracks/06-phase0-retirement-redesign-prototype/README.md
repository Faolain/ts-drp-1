# Phase 0: prototype non-blocking retirement (lull API)

**Outcome:** Landed in 4c4f192c as the opt-in `V3RoomSession.maintainRecoveryPool()` lull API.

**Working documents in this folder:** [DESIGN.md](DESIGN.md)

### Brief (plan given to the agent) (2026-10-19 07:36 UTC)

You are a fork working in an ISOLATED git worktree (your cwd). Goal: protocol/architecture redesign so bounded-recovery retirement no longer stalls gameplay at epoch transitions, consistent with prior art (watermark-triggered background retirement with an inline hard-cap backstop — RocksDB soft/hard stall, CometBFT retain-height + background pruner, Go GC pacer headroom; verify-once / trust-own-writes). The user explicitly asked for this.

SETUP (your worktree is at HEAD and lacks the main tree's uncommitted work):
1. Sync the main working tree state into your worktree: `git -C <repo> diff HEAD --binary > /tmp-free path in scratchpad` then `git apply` it in your worktree; also copy untracked files that matter: packages/protocol-v3/src/internal/ed25519-verify.ts, packages/canonical/tests/reference/codec-v1.ts, packages/canonical/tests/codec-differential.test.ts (use `git -C <main> ls-files --others --exclude-standard packages/ tests/` and copy only source/test files you need; do NOT copy stale compiled src/*.js / *.d.ts artifacts). Scratchpad for temp files: <evidence>/agent-redesign/ . Never use rm -rf (a hook blocks it).
2. `pnpm install --frozen-lockfile --offline` (fall back to without --offline) in the worktree, then `pnpm --filter @ts-drp/canonical build` (and other packages' builds only if tests need dist).
Do NOT modify files in the main tree <repo> (other agents and I are editing it).

WORK:
A. Write a concise design (≤1200 words, markdown in scratchpad/agent-redesign/DESIGN.md) for non-blocking retirement in this codebase: (1) low-watermark trigger (e.g. recoveryScopes >= max-1 or generation pressure) so retirement runs at a moment that is NOT the close/adopt critical path, with the existing close-time inline maintenance kept as the hard-cap backstop; (2) where it can run safely given the readiness boundary constraints you already know (prepareOrdinaryReadiness creator-close.ts ~4632-4728, runCreatorOrdinaryReadinessMaintenance v3-live.ts ~11262, quiescence requirements v3-live.ts ~11290-11303, maintenanceJobs gating creator-close.ts ~3403) — including an explicit room/creator API (e.g. maintainRecoveryPool()) a game can call in a lull, and an optional idle auto-trigger; (3) the close-side resume-trigger fix so a completed early turnover does not force reconstruction at close (process-local token equal to the exact control read after completion; durable resume unchanged after crash); (4) the same for recipients (creator-adoption.ts ~975-1030 prepareReceivedRecoveryTurnover runs inline in install when recoveryScopes >= max: move to a post-install lull with the inline path as backstop); (5) longer-term protocol options: durable "retire <= N" record at close + time-sliced pruner (yielding between native transactions), per-epoch stores for bulk delete, Worker-hosted maintenance, trust-own-writes replacing re-hash currency proofs — with the security/proof-accounting implications of each (ordinary issuance quotes size prospective maintenance via composeProspectiveCreatorMaintenancePrefixesForSizing; that must remain sound).
B. PROTOTYPE the smallest safe slice (A+B+C from the earlier analysis: pool-pressure predicate at readiness behind an explicit opt-in API/trigger, close resume-token fix, inline backstop unchanged), plus unit tests. Run the relevant unit tests with `pnpm exec vitest run <files> --coverage.enabled=false` from the worktree root (zsh: use ${=VAR} for word splitting). Pre-existing failures to ignore are listed in <evidence>/fails-base.txt.
C. If the prototype works, measure it with the Playwright healthy Grid benchmark adapted to call the new API in a lull between rollovers ONLY if that can be done without editing assertions' meaning (tests/fixtures/startup-discovery/healthy-grid.ts / r8-source-binding.pw.ts); otherwise skip measurement and say so. Use the build+run pattern from scratchpad/bench.sh but with your worktree as cwd and NEW unique names prefixed `rd-` (never reuse names). Note: other benchmarks may run concurrently on this machine, so timings are noisy — compare relative to your own baseline run made the same way.
REPORT (≤900 words): design summary, exactly what you changed (files/functions), test results (vs pre-existing failures), measured effect if any, risks, and the patch location: produce `git diff` of your worktree vs the synced baseline as a file scratchpad/agent-redesign/prototype.patch (diff only your own changes, i.e. commit the synced baseline first in your worktree as a local commit 'sync baseline' and diff against it; do not push).

### Report returned by the agent (2026-10-19 08:41 UTC)

I prototyped early retirement off the seal path, in an isolated worktree. On the Grid benchmark, seal at t4–t7 drops from **3.6–5.4 s to 0.50–0.79 s** when the app triggers the work in an idle gap. The design is written up, and the patch is committed locally against the "sync baseline" and not pushed.

**What was built**
- **Opt-in API, `V3RoomSession.maintainRecoveryPool()`.** It runs the same retirement the close would run, at a quiet moment the app chooses. It returns `maintained`, `not-needed` or `deferred` (busy or unsupported).
  - It only acts when the pool is full or generation pressure is close to the limit.
  - New local issues wait for it. If the room becomes busy before the work starts, it backs off without halting anything.
- **Close-side fix.** After an early retirement, the next seal no longer repeats the same pass. It skips only when the stored retirement record is byte-identical to the one the early pass produced, in the same epoch. Any other state still reruns the original logic, and the seal's inline retirement is unchanged as the hard-cap backstop.
- **Reopen bug found by the benchmark and fixed.** Closing and reopening the room after an early retirement left it unable to accept operations at startup ("readiness owner is unavailable"). Startup now runs the original recovery whenever recovery is pending, at epoch 3 or later. This also covers a crash between a close's retirement and its seal, which had the same gap.
- **Benchmark hook.** `STARTUP_HEALTHY_GRID_POOL_LULL=1` makes the creator call the API once after each rollover. It adds no transitions, operations or snapshots, so every assertion means the same thing; with the variable unset the benchmark is unchanged.

**Tests**
- 9 new unit tests (5 for the pool policy, 4 in the readiness tests), all passing. The node typecheck shows no errors in `src/`.
- I ran the affected node suite (19 files) on both the baseline commit and the prototype. The deterministic failures are identical. Every difference between runs is a 10-second test timeout under machine load. One example timed out 2 of 3 times run alone on the baseline and 1 of 3 on the prototype.
- `creator-ordinary-readiness-producer` has one failure ("genuine same-head pair") that isn't in `fails-base.txt`, but it fails the same way on the baseline. That list was captured before the synced state.

**Measured effect** (8 rollovers, Chromium; each pair from the same build, run back to back while another agent was loading the machine)

| | No lull | With lull |
|---|---|---|
| Seal t4..t7, run pair 1 (ms) | 3593 / 3682 / 3683 / 4164 | **504 / 495 / 620 / 511** |
| Seal t4..t7, run pair 2 (ms) | 4259 / 5130 / 4545 / 5368 | **610 / 789 / 584 / 601** |
| Retirement work in the lull | — | 3.0–3.8 s (pair 1); 3.9–5.5 s (pair 2) |
| Creator adoption (ms) | 804–1182 (pair 1); 1075–1273 (pair 2) | 750–902 (pair 1); 917–1036 (pair 2) |
| Recipient install, t3+ | 1.5–2.4 s | 1.3–2.6 s (unchanged) |
| Creator reopen at epoch 8 (ms) | 780 (pair 1); 846 (pair 2) | 1387 (pair 1); 1891 (pair 2) |
| Ordinary issue | unchanged | unchanged |

The retirement work is moved, not removed. The 0.5–0.8 s left in the seal is mostly work other than retirement; seal at t3, before any retirement starts, is already 0.4–0.6 s in both arms.

**Risks**
1. **Remote messages arriving mid-maintenance halt the room.** If a peer's operation arrives after the work has started, the existing rule halts the room until a recovery pass clears it. That makes the API safe only in coordinated lulls, such as creator-driven round ends or loading screens. Before any automatic idle trigger, late arrivals should be queued instead of halting.
2. **Recipients are not done.** Install still costs 1.3–2.6 s and is now the largest rollover stall. DESIGN.md explains why recipients need no skip token, but they do need their own maintenance boundary.
3. **Reopen costs more.** A reopen that falls between a lull and the next seal pays the recovery pass at startup (+0.6–1.05 s). A seal after a crash or reopen does one full pass, as it does today.
4. **Error handling.** Failures after the work starts are returned to the caller; they don't put the room into a terminal-failure state.
5. **The skip-the-repeat-pass record is in memory only.** A crash simply falls back to the current behaviour.

**Commits** (branch `worktree-agent-ad628dcf3dbf6bd44`, not pushed): `b2be662c`, `7c2fe2b2`, `89a45aa0`, on top of `1993e7e4` (sync baseline). The two gitignored benchmark inputs from the main tree's `.logs` were copied into the worktree as untracked files and are not in the patch. The main tree was not modified.

DESIGN.md (1,199 words) covers the trigger, where retirement can safely run, the close-side fix, the recipient plan, and longer-term options with their proof-accounting implications. The longer-term options are a durable "retired up to epoch N" record with a time-sliced pruner, per-epoch stores, Worker-hosted maintenance, and verify-once caching.

Files are in `<evidence>/agent-redesign/`:
- DESIGN.md
- prototype.patch
