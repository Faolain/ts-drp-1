Track U: settle Track M2's two open measurement questions before the room path can become the default. Repository: ts-drp, a TypeScript local-first CRDT meant to power real-time games, whose rooms must live for thousands of epochs. The user asked for this track.

THE TWO QUESTIONS (from docs/realtime-latency/tracks/28-track-m2-verified-fact-ledger/RESULT.md §8.1, §9 and §12 items 3 and 5)
1. Seal and adoption in LULL=1 mode. With the ledger, seal (x1.04, 1.06, 1.54) and adoption (x1.03, 1.09, 1.14) were slower in all three LULL=1 pairs. Concurrent mode showed no direction (seal 1.24, 0.79, 0.98; adoption 1.20, 0.71, 1.04). Neither path runs ledger code: the fork at a genuine handoff only moves a reference. M2's candidate cause: background IndexedDB work from the lull's deletes overlaps the next transition, now that the lull ends about 190 ms sooner. Load was 13-48 during those pairs.
2. The residual heap slope. In 100-rollover endurance runs (room database with retention, concurrent moves), forced-GC JS heap grew 0.356 MB per epoch (0.25 in the late half) once the harness kept only the named proof-event kinds (STARTUP_HEALTHY_GRID_PROOF_EVENT_KINDS, 2908fc79). Stage 1 had the same slope, so the ledger adds none, but nobody knows what grows. It still includes the harness's spans (13,726 in the creator realm at epoch 100) and its other records. Growth with room age that belongs to the library is a G1 violation in memory.

BASE AND TREES
- Your worktree should start at codex/phase3a1b-p6-golden-path HEAD e0494c5a (Track M2 merged). Check `git log -1`. If it differs, run `git switch -C <your-branch> codex/phase3a1b-p6-golden-path` (`git reset --hard` is blocked).
- For question 1, the pair is stage 1 = 093a367f (main just before Track M2's merge; it has Tracks M, O and P) against the ledger = e0494c5a. Track P is in both, so the pair differs only by M2. Build each bundle from an exported tree (`git archive`) checked blob for blob, as M2 did (<evidence>/track-m2/bin/verifybuild.py).
- Track P (a3f3f6b0) landed after M2's runs. It removed a chain of facades and contexts, one per epoch, that stayed reachable in hot state, but only for Canvas: Grid, Chat and receive-only owners never saw it. Re-measure on the current tree before attributing anything.

READ FIRST
- docs/realtime-latency/README.md (decision log, open items, "Reproducing the benchmark").
- tracks/28 RESULT.md §8, §9, §12; Track M's tracks/23 RESULT.md §12 (endurance; bin/endurance.py).
- specs/bounded-storage-lifecycle/golden-path-guarantees.md (G1-G28).
- M2's evidence: <evidence>/track-m2/ (grid/, bin/grid.sh, bin/endurance.py, bin/endure_ledger.py, bin/verifybuild.py, grid/pairs-ab1.txt, grid/bench-ab1-table.txt).
- Memory notes with the bench recipe and pitfalls: <memory>/grid-latency-benchmark.md and stale-compiled-shadowing.md.

ORDER OF WORK
Question 1 (seal and adoption in LULL=1):
1. Run at least 6 interleaved ABBA pairs in LULL=1 (8 rollovers, room database with retention), plus 3 in concurrent mode as a control. Record the load average at the start and end of every run, and skip or flag runs where it moves a lot. The machine is shared and loaded (load 13-95), so prefer measures that load disturbs less:
   - per-span CPU and main-thread task time for seal and adoption, from the task trace, alongside wall time;
   - IndexedDB transaction counts and durations that overlap each seal and adoption;
   - the gap between the end of a lull and the start of the next seal, on each tree.
2. Test M2's hypothesis directly: add a measurement-only harness option for a fixed idle gap between the lull's end and the next seal (for example 500 ms and 2 s), and rerun the pairs. If the difference disappears with the gap, the cause is overlap rather than slower code.
3. If any difference survives, profile it (V8 CPU profiles of seal and adoption on both trees; the summary scripts in <evidence>/track-e and track-h are a model). Find the cause with code citations.
4. Conclude one of:
   - noise (no difference with enough pairs);
   - overlap (the lull's background work runs into the next transition). Say what a game would see, and whether the library should settle the lull's IndexedDB work before it reports the lull done. Propose that change, and land it only if it keeps G1-G28 and is measured;
   - a real regression with a product cause: write a RED test first, then fix with the smallest change that keeps G1-G28.

Question 2 (the residual heap slope):
5. Re-measure the slope on e0494c5a with a 100-rollover endurance run: room database with retention, concurrent moves, STARTUP_HEALTHY_GRID_PROOF_EVENT_KINDS as M2 used it. Add a measurement-only harness option that also stops retaining spans and other per-epoch harness records (count them instead), and run again. Whatever slope remains belongs to the library or the browser.
6. Attribute the remainder with heap snapshots at two late checkpoints (for example epochs 50 and 90) on the creator and one recipient page. Use the Chrome DevTools Protocol through Playwright (HeapProfiler.takeHeapSnapshot after HeapProfiler.collectGarbage). Diff retained size and count by constructor and by retainer path. Name what grows, per epoch, with the code that allocates it and the code that keeps it alive.
7. Also measure, if each takes reasonable time:
   - the default six-database path (no room database), to tell whether the growth is on the room path or common;
   - Canvas and Chat on Track M's harness, tests/fixtures/track-m-apps/browser/, for 32+ epochs (the user wants Canvas and Chat covered, not only the Grid). Note that shipped Canvas currently runs the legacy profile, whose issuance grows by design, and Track T is moving it to the settlement profile. Separate issuance-row growth from other heap growth.
8. For each grower, classify it as the harness, the browser, or the library. For library growth: root-cause it, write a RED test first (a node-level test across many epochs; checking that per-epoch objects such as deactivated plane registrations, contexts and facades become unreachable, for example with WeakRef plus forced GC under `--expose-gc`, is more robust than heap size), then fix with the smallest change that keeps G1-G28. If a fix needs a design decision or a spec change, stop and report it with the options.

Both questions:
9. Suites: compare per test against base (node; the root room and native tests, including Tracks K, L, N, P, M, O and M2's; storage-node retirement). `pnpm -r typecheck` must report 0 errors. Run `node scripts/check-shadowed-sources.mjs`.
10. Commit your RESULT.md into docs/realtime-latency/tracks/31-track-u-lull-seal-and-heap/, with local paths written as <evidence>/…. Keep <evidence>/track-u/PROGRESS.md current.

PARALLEL WORK (keep product changes out of these areas, and list every file and function you touch)
- Track S edits packages/node/src/internal/creator-closed-rollback-data.ts (`classifyClosedSigningSummaries`) for a reopen right after the creator's first maintained lull.
- Track T moves shipped Canvas, the Grid example and the v3-chat demo to `creator-trusted-settlement-v1`, and may widen node types (packages/node/src/v3-room.ts:336).
- Track Q (held) edits packages/node/src/applications/canvas.ts and examples/chat.
- Harness changes must be measurement only, off by default, and in their own commits. M2 already edited tests/fixtures/startup-discovery/critical-observer.ts, healthy-grid.ts and r8-source-binding.pw.ts; build on its option rather than adding a parallel one.

HARD RULES
- Never weaken G1-G28.
- Never edit existing RED or governance tests, frozen artifacts, registries or vectors to make something pass.
- If a fix cannot keep a guarantee, stop, record the counterexample and hand back.
- Run prettier on new files.
- Never run `tsc -p` without `--noEmit`.
- A hook blocks `rm -rf`, `unlink`, `git checkout <ref> -- <path>` and `git reset --hard`. Move unwanted files into <evidence>/track-u/trash/. Never delete logs.
- Commit only on your own worktree branch. Never push. Never touch the main checkout, except to copy the untracked bench inputs .logs/bounded-storage-lifecycle/r8-warm-capacity-01/ into your worktree (never commit them).
- End every commit message with exactly: Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
- Do not edit docs/realtime-latency/README.md; the coordinator maintains it.
- Builds: the Grid bundle and the browser harnesses read canonical, storage, storage-node, storage-browser and compaction from dist. Rebuild them in your worktree, and in each exported tree, building protocol-v3 before compaction. Stale dists produce errors like "roomRetentionControlDigest is not a function".
- Grid bundle: `STARTUP_ENTRY=r8-source-binding pnpm exec tsx tests/fixtures/startup-discovery/build.ts <new-outdir>`.
- Run vitest from the repository root with `--exclude ".claude/**" --no-coverage`.
- Never kill processes you did not start. Other tracks run benches on this machine at the same time; record load, interleave, and rerun outliers.

<evidence> = <evidence>

FINAL REPORT
- The commit list.
- Question 1: pairs per mode with load; wall and CPU medians for seal and adoption per tree; the idle-gap result; the conclusion (noise, overlap or regression) with evidence; any change landed and its measurement.
- Question 2: the slope on the current tree, with and without harness records; the heap-snapshot diff (top growers per epoch, with allocating and retaining code); harness, browser or library for each; the default path and Canvas/Chat results; any fix with its RED test and its measurement.
- The guarantee argument for any product change.
- Per-test suite diff against base; typecheck result.
- What remains, and the risks.
