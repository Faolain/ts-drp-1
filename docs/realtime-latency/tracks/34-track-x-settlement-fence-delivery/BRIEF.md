Track X: fix the delivery stall on the settlement profile. With real networking, a creator's moves stop reaching a Writer after a few successors. Repository: ts-drp, a TypeScript local-first CRDT meant to power real-time games, whose rooms must live for thousands of epochs.

WHAT TRACK V FOUND (docs/realtime-latency/tracks/32-track-v-settlement-for-grid-and-chat/RESULT.md, §3 and §3.7)
- Track V switched the shipped Grid example to `creator-trusted-settlement-v1` on its branch `worktree-agent-a84dc20beddb97044`. Commit 15bf2ed1 is the switch; d5a0015f, 5b55b6e9 and 27fe2688 are held with it. That branch is not merged.
- The reproduction is tests/track-v-grid-long-room.pw.ts with playwright.track-v-grid-long-room.config.ts, now on main (cedcc628). It serves the shipped Grid page as tests/phase-3a1b-d9346-v3-zone.pw.ts does: Vite dev server, network fixtures, two relays, real libp2p gossip and direct streams. It runs one creator and one Writer, 2 blocks each per epoch, then the creator seals, exports and adopts, and the Writer installs.
- Base (legacy profile) passes 16/16 epochs. On the settlement profile, 4 of 4 runs stop at epoch 5 on the creator's first block. With a 5 s pause after each install, it stops at epoch 4. Turning the IndexedDB census off changes nothing.
- What the Writer logs:
  - every epoch, `::v3-ingress not-authenticated` while the creator adopts. That is the creator's settlement author fence, published before the Writer has installed the successor;
  - then `::v3-ingress graph-rejected` when the creator's next block arrives. The block waits in pending ingress for the missing fence.
- In epochs 2-4 the block arrives 1.5-2 s after install, which fits the retained-history requests scheduled at install (packages/node/src/room-network.ts: delays 0, 0.5, 1.5, 3, 6, 10 and 15 s). In the stuck epoch it never arrives, and later creator blocks never reach the Writer at all. The Writer's blocks still reach the creator. The stuck point is 33-41 s of page time in every run.
- Legacy issues no fence, so it never sees this. The Node tests miss it because their delivery is idealised: each flush hands the Writer every published row in issue order after install.
- This breaks G3 (the golden path keeps playing). Shipped Canvas (Track T, merged in 2e272eb0) and shipped Chat (examples/chat) already sign the settlement profile and also send the fence at adoption. Track T's Chromium evidence used Track M's harness, not the shipped page's network. So they may stall on main today.

BASE
- Your worktree should start at codex/phase3a1b-p6-golden-path HEAD 5ed93b67 (main, which has Track V's harness). Check `git log -1`. If it differs, run `git switch -C <your-branch> codex/phase3a1b-p6-golden-path` (`git reset --hard` is blocked).
- To reproduce on the Grid, apply Track V's switch on a scratch branch (cherry-pick 15bf2ed1). Keep your fix commits on your own branch, separate from Track V's commits. Track V's switch merges later, on top of your fix.

READ FIRST
- Track V's RESULT.md (all of it), and <evidence>/track-v/ (MAP.md, PROGRESS.md, logs/chromium-*, data/chromium-c1-head-trace).
- docs/realtime-latency/README.md (decision log, open items); specs/bounded-storage-lifecycle/golden-path-guarantees.md (G1-G28).
- packages/node/src/room-network.ts (retained-history requests); the v3 ingress and pending-ingress code in packages/node/src (search for "graph-rejected", "not-authenticated", "pending ingress"); the settlement fence's issue at adoption (`cleanupCreatorSettlementSuccessor` and the author fence in v3-live.ts / creator-adoption.ts).
- Memory notes with the bench recipe and pitfalls: <memory>/grid-latency-benchmark.md and stale-compiled-shadowing.md.

ORDER OF WORK
1. FIRST, AND HAND BACK: is shipped Canvas or shipped Chat broken on main?
   - Build the same real-network Chromium harness for the shipped Canvas page and the shipped Chat page (examples/canvas, examples/chat), on Track V's pattern. Run 16 successors with a creator and one Writer.
   - Run main (5ed93b67) and, for Canvas, also b2c3d8f1, which is main before Track T switched Canvas to settlement.
   - Write the answer at the top of <evidence>/track-x/PROGRESS.md, with logs.
   - Then STOP and hand back a short report: does each app stall, at which epoch, with the same signature? The coordinator decides whether to revert Canvas's switch on main while you fix, and will resume you with SendMessage. Commit the harnesses (measurement only) before handing back.
2. Root cause, with code citations and traces. Explain:
   - why a fence that arrives before install is not held and admitted once the successor is installed;
   - why the retained repair recovers it in epochs 2-4 but never in the stuck epoch;
   - why every later creator operation is then lost rather than delayed (pending-ingress bound? a closed relayed stream? the repair schedule exhausted? a dependency that is never re-requested?);
   - why the stuck point is always 33-41 s of page time;
   - why the latency bench (tests/fixtures/startup-discovery, settlement profile, real networking, 100 rollovers passing) does not hit it. Track V §6.1 lists how the bench differs from the shipped Grid.
3. A RED test first, at node level where possible: a delivery order that publishes the fence before the recipient installs, then the creator's next operations, over several successors. Use Track M2's or Track S's fixtures as patterns. Commit it before the fix. Keep Track V's Chromium harness as the end-to-end check.
4. Fix in the library with the smallest change that keeps G1-G28:
   - nothing is admitted without full authentication;
   - anything held while it waits for its epoch or dependency is bounded and counted (G21, G22);
   - a missing dependency is re-requested when needed, rather than on a fixed schedule that can run out;
   - a recipient never ends up permanently deaf to the creator.
   If the fix needs a design decision or a spec change, stop and report the options.
5. Proof:
   - the RED test green;
   - Track V's Chromium harness with Track V's Grid switch on top, 16/16 epochs over at least 3 runs, plus the 5 s pause variant;
   - your Canvas and Chat real-network harnesses, 16/16 on main with your fix;
   - the latency bench's 8-rollover run unchanged against base (per-move and transition medians);
   - storage flat.
6. Track V's d9346 failures (§3.7), once delivery works, with Track V's switch on top:
   - an ordinary placement now builds a finishing resource program (line 474). Say whether it is a lawful settlement cost, and so an assertion change that needs the owner's approval, or a defect;
   - a migrated joiner throws `DurableIssuanceError: issuance retirement plan has no lineage` (line 908). Root-cause it, and fix it if it is a library defect.
7. Suites: compare per test against base (node; the root room and native tests, including Tracks K, L, N, P, M, O, M2, S and T's; storage-node retirement; Canvas and Chat e2e). `pnpm -r typecheck` must report 0 errors. Run `node scripts/check-shadowed-sources.mjs`.
8. Commit your RESULT.md into docs/realtime-latency/tracks/34-track-x-settlement-fence-delivery/, with local paths written as <evidence>/…. Keep <evidence>/track-x/PROGRESS.md current.

PARALLEL WORK (list every file and function you touch)
- Track Q is rebasing Canvas and Chat resource bounds (packages/node/src/applications/canvas.ts, examples/chat). Track W is changing shipped Chat's state to a rolling window (examples/chat). Don't edit examples/chat or canvas.ts. Harnesses go under tests/.
- Track U may add measurement-only options to tests/fixtures/startup-discovery. Don't edit those files.
- Don't touch examples/grid or examples/v3-chat outside a scratch branch; Track V's switch owns them.

HARD RULES
- Never weaken G1-G28.
- Never edit existing RED or governance tests, frozen artifacts, registries or vectors to make something pass.
- If a fix cannot keep a guarantee, stop, record the counterexample and hand back.
- Run prettier on new files.
- Never run `tsc -p` without `--noEmit`.
- A hook blocks `rm -rf`, `unlink`, `git checkout <ref> -- <path>` and `git reset --hard`. Move unwanted files into <evidence>/track-x/trash/. Never delete logs.
- Commit only on your own worktree branch. Never push. Never touch the main checkout, except to copy the untracked bench inputs .logs/bounded-storage-lifecycle/r8-warm-capacity-01/ into your worktree (never commit them).
- End every commit message with exactly: Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
- Do not edit docs/realtime-latency/README.md; the coordinator maintains it.
- Builds: the browser pages and harnesses read canonical, storage, storage-node, storage-browser and compaction from dist. Rebuild them in your worktree, building protocol-v3 before compaction.
- Run vitest from the repository root with `--exclude ".claude/**" --no-coverage`.
- The machine is heavily loaded: compare per test against base, and rerun timeouts alone. Never kill processes you did not start. If a run you started leaves workers behind, record that in PROGRESS.md.

<evidence> = <evidence>

FINAL REPORT (after the fix)
- The commit list.
- The step-1 answer for Canvas and Chat.
- The root cause, with code citations, and why the bench misses it.
- The fix, and why it is safe, against each guarantee it touches.
- Chromium results: Grid with Track V's switch, Canvas and Chat, runs and epochs.
- The d9346 findings: a lawful cost needing owner approval, or a fixed defect.
- Per-test suite diff against base; typecheck result.
- What remains, and the risks.
