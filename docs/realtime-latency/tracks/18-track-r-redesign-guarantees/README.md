# Track R: maintenance redesign against the golden-path guarantees

**Outcome:** Stopped mid-work (interrupted). Produced the G1-G28 checklist, now kept at [specs/bounded-storage-lifecycle/golden-path-guarantees.md](../../../../specs/bounded-storage-lifecycle/golden-path-guarantees.md), and the step verdicts in STEPS.md; continued by Track R2.

**Working documents in this folder:** [STEPS.md](STEPS.md)

### Brief (plan given to the agent) (2026-10-19 16:55 UTC)

You are Track R. Explore and attempt the most viable alternatives from an already-completed root-cause study ("Track E") of why recovery-pool maintenance in this TypeScript repo (ts-drp, a real-time-game sync library) takes ~2.7 s per epoch. The goal is ms-range maintenance for real-time games WITHOUT losing any golden-path guarantee. The user's explicit instruction: "ensure we don't lose any of the 'guarantees' or objectives from our golden path in the rearchitecture."

#### Inputs (read these first)
- Track E findings: <evidence>/track-e/ROOT-CAUSE.md and ALTERNATIVES.md. Same directory also has patches/diag-counters.patch (reusable counters), patches/whatif-*.patch (test-only experiments), idbmodel/ (Chromium IDB models) and analysis scripts.
- Summary of Track E:
  - The cost is architectural, not a hotspot. A maintenance pass that retires nothing still costs 0.44–0.86 s.
  - Each epoch runs 4 passes. Each pass re-reads and re-authenticates everything (11k IDB requests; 98% of decodes are repeats) to make about 103 row writes.
  - The 4 passes do 4 hand-built two-phase commits across 6 IndexedDB databases.
  - A keep-alive pump holds read transactions open with about 26.8k dummy requests per epoch. Removing it naively broke lulls, because cached facts are bound to the held transaction.
  - Codec memoization gave no measurable gain. Do not pursue more codec caching.
  - Proposed order:
    1. Revision counters + Web Locks replacing the keep-alive pump.
    2. Carry verified facts across passes; a currency check would take ~0.3 ms vs ~52 ms.
    3. Merge the four stages into one pass; an experiment showed ~2.7 s → 0.9–1.1 s.
    4. Single-DB watermark retirement: epoch-grouped keys with a range delete, verify-on-arrival, incremental digests, a monotonic retired-through-epoch floor. Modelled at 2.5 ms per epoch.
- Golden-path guarantees, which you MUST enumerate and preserve:
  - specs/bounded-storage-lifecycle/README.md, especially the golden-path table around line 160 and the "One owner per decision" section.
  - specs/bounded-storage-lifecycle/requirements-to-evidence.md (long; search it).
  - specs/phase-6b-bounded-pruning/README.md.
  - specs/e3-e5-fabric-golden-path/README.md.
  - The golden-path sections of docs/production-hardening/production-hardening-tdd-plan-v2.md. It is huge; grep for golden/MMORPG/Discord/fail-closed/strict durability.
  - Typical guarantees include: boundedness that doesn't grow with room age; crash-atomicity and strict durability of retirement; authenticated recovery (genuine transitions, all admitted writers, offline/rebase work, crash recovery and next issuance); fail-closed loss semantics and the host freshness/custody threat model; a single retirement decision owner (no independent sweeper, and no treating epoch age/TTL/head observation/adopted:true as deletion proof); no resurrection of terminal sessions or deleted keys; cross-tab/cross-connection exclusion; backpressure before storage exhaustion; and the existing ingress ordering, including FIFO-queued ingress during deferrable lulls.

#### Setup
- You are in an isolated git worktree at commit 4c4f192c. Apply the integrated working-tree state: `git apply --binary <evidence>/track-r/base-current.patch` (47 files; it includes new files).
- You MAY create one local commit of that base on your worktree branch, so later diffs are easy. Do NOT commit your own changes.
- Run `pnpm install --offline --ignore-scripts`. The root package.json in the patch adds @ts-drp/canonical and @ts-drp/issuance-store links.
- The Grid bundle consumes canonical, storage and storage-browser from dist (rebuild with `pnpm --filter @ts-drp/<pkg> build`), and node, protocol-v3 and seal from src.
- Benchmark how-to:
  - Build: `STARTUP_ENTRY=r8-source-binding pnpm exec tsx tests/fixtures/startup-discovery/build.ts <outdir>`.
  - Run: `STARTUP_HEALTHY_GRID_ROLLOVERS=8 STARTUP_HEALTHY_GRID_POOL_LULL=1 STARTUP_EVIDENCE=<dir> STARTUP_ENTRY=r8-source-binding STARTUP_SOURCE_NATIVE_RESOURCES=1 STARTUP_ARTIFACTS=<outdir> pnpm exec playwright test --config tests/fixtures/startup-discovery/playwright.config.ts --project chromium -g "healthy native Grid integrates"`. Results are in report.json; Track E's scripts parse them.
  - The machine is heavily loaded (load 60–130). Use interleaved base/variant pairs and compare like with like.
- Root vitest needs `--exclude ".claude/**" --no-coverage`.
- NEVER use `rm -rf` or `unlink`; a hook blocks them. Use fresh directory names instead.
- Don't kill processes you didn't start.

#### What to do
1. Write a guarantee checklist (G1..Gn) from the specs, each item citing its source file and section.
2. For each redesign step in order (1 → 2 → 3, then prototype 4), implement it soundly, or show precisely why it can't be done without weakening a guarantee.
3. For each step, add focused tests proving the relevant guarantees still hold: crash/abort atomicity, fail-closed on stale/foreign state, cross-connection exclusion, monotonic floor, no resurrection, bounded growth, and so on. Never relax existing tests, pins or governance to make a change pass. If a structural pin must change, justify it explicitly.
4. Measure each step with paired benches. Report per-epoch creator lull maintenance time, seal/adoption/install time, and move p50 against base.
5. Step 4 (single-DB watermark) is a storage-format change. Prototype it behind the existing owner interfaces if feasible, with a migration/compatibility story. If it's too large to land soundly, deliver a design plus a working prototype and measurements instead of a half-integrated change. Steps 1–3 that land soundly are the priority deliverable.

#### Budget and output
- Keep to about 180 turns. Deliver incrementally: if only steps 1–2 land, report those.
- Don't write REPORT.md.
- Write your patch relative to the base: `git diff <base-commit> > <evidence>/track-r/patch.diff`. Include new files.
- Put notes and design docs under <evidence>/track-r/.
- Reply with:
  (a) the guarantee checklist and, per step, how each guarantee is preserved, with the test that proves it;
  (b) what landed vs what is design/prototype only;
  (c) the patch path;
  (d) test results: affected suites, before/after failure sets vs base;
  (e) bench numbers vs base;
  (f) risks and open questions.

### Report returned by the agent

_No final report: the run was interrupted or ended without one; see the outcome above and the working documents._
