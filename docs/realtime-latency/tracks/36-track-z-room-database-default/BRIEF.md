Track Z: make the fast storage path the default for new rooms, so the shipped apps stop paying multi-second seals. Repository: ts-drp, a TypeScript local-first CRDT meant to power real-time games, whose rooms must live for thousands of epochs. The owner chose this on 2026-10-21.

WHY
- With real networking in Chromium (Track X, docs/realtime-latency/tracks/34-track-x-settlement-fence-delivery/RESULT.md §5.2), the shipped Canvas, Chat and Grid pages' creator seal takes 3–9 s from epoch 5 on.
- The latency bench in its default mode gives a seal of about 3.4 s and an install of about 2.0–2.2 s (Track X §5.3).
- On the opt-in path (the room database, room retention and the creator lull), the bench seals in about 0.26 s (Track Y's paired runs; Tracks M, O, M2, Q and S built that path).
- The shipped examples don't opt in. Nothing in examples/canvas, examples/chat or examples/grid creates the room-database host (Track R3 §9: `createBrowserV3RoomDatabaseStorageHost()` is opt-in).
- The goal of the whole effort is millisecond transitions for real-time games, so the shipped default must be the fast path.

THE OWNER'S CHOICE
- New rooms use the room database with retention, and the lull where the app supports it.
- Existing rooms keep the host they were created on, with no migration. This follows the precedent of decision row 28 (R-A): the library has no users yet.
- Finish the remaining prerequisites before flipping.

WHAT IS KNOWN TO REMAIN (docs/realtime-latency/README.md open items "Retention path" and "Before the room database can become the default"; Track R3 RESULT §9–10; Track M and Track O RESULT)
- 14c: per-owner floor fences exist in storage (opt-in `retirementFences: true`) but are not wired into the node. Write the fence as step A and check it on open.
- 14d: migration of existing rooms. The owner chose no migration. Until 14d exists, the room host refuses an existing six-database room (a07e3206), so host selection must route an existing room to the host it was created on. 14f case 9 belongs to 14d; record it as not applicable.
- 14f: cases 5–8 pass on three engines after Track O, and case 11 (the browser long room) passes. Re-confirm at the flip's head.
- The 512-write cap: a committee of more than about 85 signers makes one signing unit exceed it, and that boundary falls back to the existing path. Review this, and say what a large room sees.
- Re-measure the recipient lull's issue latency (102 → 122 ms p50 in Track M's pairs) and the heap in a fresh process.
- Node tests that evaluate original CRD and v3-live.ts source text: a default flip may change that text. Those tests are class (ii) pins, owned by the owner. List them, with the exact amendment needed, and do not edit them.
- Room-path risks (Track R3 §10): the session holds one read-write transaction over every room store, about 106–116 ms at p50 and up to about 380 ms per install, and the recipient install's p90 is wider. Web Locks are absent on Node. The room owners and the session registry must come from one module instance.

ORDER OF WORK
1. ATTRIBUTE FIRST, AND HAND BACK. Before building anything, show what the flip buys on the shipped pages.
   - Use Track X's real-network harness (tests/track-x-shipped-app-long-room.pw.ts with playwright.track-x-shipped-app-long-room.config.ts) for Canvas and Chat, and Track V's (tests/track-v-grid-long-room.pw.ts) for Grid.
   - Break the shipped pages' seal, adoption and install into phases: which host, whether the lull runs and when, what work runs inside seal, and the settlement profile's adoption pruning.
   - Then run the same pages on a scratch branch that opts them into the room database with retention, plus the lull where the app supports it. Report the per-phase difference over 16 epochs, 2 runs each.
   - Answer: does the flip bring each shipped page's seal, adoption and install close to the bench's opt-in figures? If not, what else stands in the way (for example, the page never runs a lull, or work inside seal that the bench's lull mode moves)?
   - Write the answer at the top of <evidence>/track-z/PROGRESS.md, commit any measurement-only harness options, then STOP and hand back a short report. The coordinator decides the scope of the flip with the owner and resumes you with SendMessage.
2. Map (after the go-ahead): write <evidence>/track-z/MAP.md.
   - Each prerequisite above: its status at your base, with citations, and what it needs.
   - Every test, fixture, frozen artifact, registry, vector or spec that pins the default host, the six-database layout as the default, or the source text the flip changes. Classify each as (i) unaffected, (ii) a RED, governance or contract test, frozen artifact, registry or vector (never edit; list the amendment for the owner), or (iii) code to change.
   - Where the default lives: the library's host factory, or each example's choice. Prefer the library, so that every app gets it. Argue the choice.
3. RED tests first, committed before the product change:
   - a new room created with default options uses the room database with retention;
   - an existing six-database room reopens on its own host, unchanged, and is never refused or modified;
   - the 14c fence is written as step A and checked on open, including a crash between them;
   - nothing changes for Node SQLite hosts unless you argue it should.
4. Implement with the smallest change: wire 14c, host selection by what the room was created on, and the default for new rooms.
5. Proof:
   - the RED tests green;
   - 14f on Chromium, Firefox and WebKit at your head, case 11 included;
   - each shipped page with real networking, 16/16 epochs over at least 2 runs, with per-phase seal, adoption and install against step 1's default-host numbers;
   - the bench at 8 rollovers in its default mode, now on the new default, against base, and on the explicit opt-in, unchanged;
   - storage flat over a long room (Track M's browser harness, 100 epochs);
   - an existing six-database room created at base, reopened at head, works.
6. Suites: compare per test against base (node; root room and native tests, including Tracks K, L, N, P, M, O, M2, S, T, Q, W and X's; storage, storage-browser and storage-node; the startup-discovery observers; Canvas and Chat e2e; d9346). `pnpm -r typecheck` must report 0 errors. Run `node scripts/check-shadowed-sources.mjs`.
7. Commit your RESULT.md into docs/realtime-latency/tracks/36-track-z-room-database-default/, with local paths written as <evidence>/…. Keep <evidence>/track-z/PROGRESS.md current.

BASE
- Start at codex/phase3a1b-p6-golden-path HEAD, which the coordinator names in your prompt. Check `git log -1`. If it differs, run `git switch -C <your-branch> codex/phase3a1b-p6-golden-path` (`git reset --hard` is blocked).

READ FIRST
- docs/realtime-latency/README.md (decision log, open items); specs/bounded-storage-lifecycle/golden-path-guarantees.md (G1-G28); specs/bounded-storage-lifecycle/slices/14*.md.
- The RESULT.md of Tracks R3 (folder 20), M (23), O (25), M2 (28), Q (27), S (29), U (31) and X (34).
- Memory notes with the bench recipe and pitfalls: <memory>/grid-latency-benchmark.md and stale-compiled-shadowing.md.

PARALLEL WORK (list every file and function you touch)
- Track X is continuing in the library. First the IndexedDB seal deadlock: `close()` in packages/node/src/creator-close.ts will stage the snapshot before taking its source (decision row 49). Then the settlement startup order in packages/node/src/v3-room.ts (`rebasePromise`) and network/node.ts. Don't edit creator-close.ts. Keep any v3-room.ts edits minimal and separate, and report any overlap before making it. The deadlock affects any IndexedDB host, so if you see a creator seal hang in your runs, record it as that known issue (see Track X's RESULT.md §9) rather than investigating it.
- Track W owns examples/chat. Track V's held Grid switch owns examples/grid and examples/v3-chat, and will merge after Track X. Do measurement-only opt-ins in the examples only on a scratch branch. If the default must be set in an example rather than the library, stop and report first.
- Track Y is changing cache ceilings in packages/canonical, packages/protocol-v3, packages/storage/src/values.ts and packages/node/src/internal/creator-transition-advance.ts. Don't edit those.

HARD RULES
- Never weaken G1-G28.
- Never edit existing RED or governance tests, frozen artifacts, registries or vectors to make something pass.
- If a change cannot keep a guarantee, stop, record the counterexample and hand back.
- Run prettier on new files.
- Never run `tsc -p` without `--noEmit`.
- A hook blocks `rm -rf`, `unlink`, `git checkout <ref> -- <path>` and `git reset --hard`. Move unwanted files into <evidence>/track-z/trash/. Never delete logs.
- Commit only on your own worktree branch. Never push. Never touch the main checkout, except to copy the untracked bench inputs .logs/bounded-storage-lifecycle/r8-warm-capacity-01/ into your worktree (never commit them).
- End every commit message with exactly: Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
- Do not edit docs/realtime-latency/README.md; the coordinator maintains it.
- Builds: the browser pages and harnesses read canonical, storage, storage-node, storage-browser, issuance-store, node and compaction from dist. Rebuild them in your worktree after any change, building protocol-v3 before compaction.
- Run vitest from the repository root with `--exclude ".claude/**" --no-coverage`.
- Node: every measurement in this effort used Node v22.15.0 and pnpm 10.24.0. The machine's fnm default moved to v22.23.4, which has no pnpm. Put `export PATH="<fnm>/node-versions/v22.15.0/installation/bin:$PATH"` first in every script and shell. Never change the fnm default or install anything globally, and never pair runs across Node versions.
- The Chromium harnesses (Track X's shipped-app harness, the Canvas/Chat e2e, Track V's Grid harness) use fixed ports 4175, 4180, 4181, 51000 and 51002, shared with other tracks. Before each such run, check the ports are free (`lsof -nP -iTCP:4180 -sTCP:LISTEN`) and wait if they aren't. If a run fails with "is already used", rerun it.
- The machine is heavily loaded: use paired runs, compare per test against base, and rerun timeouts alone. Never kill processes you did not start. If a run you started leaves workers behind, record that in PROGRESS.md.

<evidence> = <evidence>

FINAL REPORT (after step 7)
- The commit list.
- Step 1's attribution.
- MAP.md summary, and pins with their amendments.
- The flip: where the default lives, host selection for existing rooms, 14c wiring, and why each is safe against the guarantees it touches.
- Shipped-page latency before and after, per phase, per app; the bench; storage.
- 14f results per engine.
- Per-test suite diff against base; typecheck result.
- What remains, and the risks.
