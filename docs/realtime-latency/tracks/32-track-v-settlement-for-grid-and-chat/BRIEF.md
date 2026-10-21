Track V: move the Grid example and the v3-chat demo to the settlement profile, so their issuance stops growing with room age. Repository: ts-drp, a TypeScript local-first CRDT meant to power real-time games, whose rooms must live for thousands of epochs.

THE USER'S DECISIONS (2026-10-20)
- "R-A for all shipped apps": shipped apps sign `creator-trusted-settlement-v1`, so the reviewed settlement retirement bounds their issuance. The legacy `creator-trusted-v1` profile has no issuance deleter and keeps every row it issues.
- Track T switched shipped Canvas (docs/realtime-latency/tracks/30-track-t-settlement-for-shipped-apps/RESULT.md). It stopped for the Grid example and the v3-chat demo, because existing tests pin the exact genesis bytes they sign.
- The user then approved: "Amend pins, switch both". In a separate commit, change only the profile name and the ACL version in those pinning tests. Then switch both apps and prove storage and latency stay flat, as for Canvas. If the contract needs more than those two values, stop and report.

THE PINS (Track T's map: <evidence>/track-t/MAP.md; verify each line at your base)
- tests/phase-3-exit-genesis-roots-red.test.ts:
  - v3-chat: the expected latched ACL, `version: 1` (`expectedChatAcl`, around lines 206-248);
  - both apps: `expectProductInput` asserts `profileId: "creator-trusted-v1"` (around lines 271-278);
  - the Grid zone: the expected latched ACL, version 1 (around lines 624-640).
- v3-chat's phase-6a contract:
  - tests/fixtures/phase-6a-v3/creator-successor-product-contract.ts:721-775 (`isD108d2Authority`, `isD110cBSuccessorAuthority`);
  - packages/storage-browser/tests/phase-6a-creator-successor-product.pw.ts:1097 and 2518-2560;
  - packages/storage-browser/tests/assets/phase-6a-creator-successor-product-entry.ts:730-801;
  - tests/phase-6a-creator-successor-product-red.test.ts:142-156.

WHAT THE APPROVAL COVERS, AND WHAT IT DOES NOT
- Covered: in the files above, the literal profile identifier (`creator-trusted-v1` to `creator-trusted-settlement-v1`) and the latched ACL version (1 to 3), plus expected bytes or digests computed from them in the same test, where the test computes them rather than storing a frozen value.
- Not covered, so stop and report with the exact diff you would need: any stored frozen digest, vector, registry entry or golden byte string; any change to a predicate's structure (for example an authority shape that differs under settlement, such as a fence or a settlement preview); any other test; any assertion that would be loosened rather than changed to the new value.
- The settlement profile requires a version-3 latched ACL (packages/protocol-v3/src/latched-acl.ts:256). Track T found that this, plus the profile, was the only app-side change for Canvas.

BASE
- Your worktree should start at codex/phase3a1b-p6-golden-path HEAD 19caa468 (Tracks T and S merged). Check `git log -1`. If it differs, run `git switch -C <your-branch> codex/phase3a1b-p6-golden-path` (`git reset --hard` is blocked).

READ FIRST
- docs/realtime-latency/README.md (decision log, open items).
- tracks/30 (Track T) RESULT.md and <evidence>/track-t/MAP.md, PROGRESS.md. Follow Track T's pattern: examples/canvas/src/profile.ts is the app's single source of truth for its genesis profile, imported by the app and its tests.
- tracks/26 (Track P) and tracks/24 (Track N) RESULT.md; specs/bounded-storage-lifecycle/golden-path-guarantees.md (G1-G28).
- Memory notes with the bench recipe and pitfalls: <memory>/grid-latency-benchmark.md and stale-compiled-shadowing.md.

ORDER OF WORK
1. Re-map at your base. List every test and fixture that reads examples/grid or examples/v3-chat as source text, or builds their shipped composition. Track Q noted that many contract tests read examples/v3-chat as source text. Classify each as unaffected, covered by the approval, or not covered. Write <evidence>/track-v/MAP.md. If anything not covered would have to change for an app, leave that app on the legacy profile and report it. Carry on with the other app.
2. Commit the pin amendment by itself, one commit, covering only what the approval covers. Its message must say that the repository owner approved it on 2026-10-20, list every changed literal, and note that the pins fail until the switch commit that follows.
3. Switch each app in its own commit: the profile and the ACL version, through one exported source of truth per app (as examples/canvas/src/profile.ts does). Report any app-level change beyond those two values, and why. Do not change library code; if the library must change, stop and report.
4. Proof per app, base against your HEAD:
   - A node-level 16-epoch test of the shipped composition (`createV3ZoneApi` for the Grid; the v3-chat demo's composition), with the creator and one Writer recipient, then a persisted reopen and one more epoch. Use Track P's tests/canvas-long-room-issuance-retention-native.test.ts as the pattern, including its per-move native work counts. Assert from the first steady epoch: issued and outbox counts constant; nothing pending; no kept row older than the window; per-move work not above the first steady epoch's; and `next` rising by moves + fences per epoch, with the fence count from `settlementProfileFor`.
   - Latency per epoch on Node: issue, seal, adoption and install, with slopes.
   - The Grid: the latency bench (tests/fixtures/startup-discovery) signs its own settlement invite. Say whether, after your switch, the bench's composition matches the shipped Grid example apart from harness wiring. If it does, the existing Grid evidence (Tracks M and M2: flat storage to 100 epochs) applies; say exactly why. If it doesn't, run the shipped Grid example in Chromium for 16+ epochs if a harness can, or say why it can't.
   - The v3-chat demo in Chromium, if Track M's harness (tests/fixtures/track-m-apps/browser/) or an existing v3-chat Playwright spec can run it for 16+ epochs. Otherwise rely on the node-level proof and say so.
   - The shipped apps' Playwright specs that use these examples (for example tests/phase-3a1b-d9346-v3-zone.pw.ts, tests/e4-02-targeted-aoi.pw.ts, tests/phase-3a1b-d9336-two-client-room.pw.ts): same results as base.
5. If the 16-epoch proofs pass: a 100-epoch v3-chat endurance run (measurement only) with per-epoch rows, bytes and latency, if it fits in reasonable time. Track T found that examples/chat stops near epoch 57 under its own 32 KiB retained-state cap (`SHIPPING_CHAT_RETAINED_BYTES`); check whether v3-chat has a similar cap and size the run around it.
6. Update the legacy-profile notes. Track T added JSDoc at `settlementProfileFor` and in v3-room.ts, and a comment in examples/canvas/src/profile.ts. Add the same comment to each new profile file. Remove anything that now wrongly says these apps run the legacy profile.
7. Suites: compare per test against base (node; the root room and native tests, including Tracks K, L, N, P, M, O, M2, S and T's; storage-node retirement; the phase-3 and phase-6a contract tests you amended, which must pass at HEAD). `pnpm -r typecheck` must report 0 errors. Run `node scripts/check-shadowed-sources.mjs`.
8. Commit your RESULT.md into docs/realtime-latency/tracks/32-track-v-settlement-for-grid-and-chat/, with local paths written as <evidence>/…. Keep <evidence>/track-v/PROGRESS.md current.

PARALLEL WORK (list every file and function you touch)
- Track U is measuring lull-mode seal and adoption and the heap. It may add measurement-only options to tests/fixtures/startup-discovery (critical-observer.ts, healthy-grid.ts, r8-source-binding.pw.ts). Don't edit those files.
- Track Q is rebasing its Canvas and Chat resource bounds (packages/node/src/applications/canvas.ts, examples/chat, maybe examples/canvas/src/index.ts). Stay out of those.

HARD RULES
- Never weaken G1-G28.
- Never edit existing RED or governance tests, frozen artifacts, registries or vectors to make something pass. The only exception is the pin amendment in step 2, within what the approval covers.
- If a change cannot keep a guarantee, stop, record the counterexample and hand back.
- Run prettier on new files.
- Never run `tsc -p` without `--noEmit`.
- A hook blocks `rm -rf`, `unlink`, `git checkout <ref> -- <path>` and `git reset --hard`. Move unwanted files into <evidence>/track-v/trash/. Never delete logs.
- Commit only on your own worktree branch. Never push. Never touch the main checkout, except to copy the untracked bench inputs .logs/bounded-storage-lifecycle/r8-warm-capacity-01/ into your worktree (never commit them).
- End every commit message with exactly: Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
- Do not edit docs/realtime-latency/README.md; the coordinator maintains it.
- Builds: the browser harnesses read canonical, storage, storage-node, storage-browser and compaction from dist. Rebuild them in your worktree, building protocol-v3 before compaction.
- Run vitest from the repository root with `--exclude ".claude/**" --no-coverage`.
- The machine is heavily loaded: compare per test against base, and rerun timeouts alone. Never kill processes you did not start. If a run you started leaves workers behind, record that in PROGRESS.md.

<evidence> = <evidence>

FINAL REPORT
- The commit list.
- MAP.md summary: what the amendment changed (every literal), and anything not covered that blocked an app.
- Every change beyond the two values, and why it is needed.
- Storage per epoch (rows, bytes) for creator and Writer recipient, for each app, 16+ epochs, and the reopen.
- Latency per epoch, with slopes, base against HEAD.
- Whether the Grid bench's evidence applies to the shipped Grid example, and why.
- The 100-epoch v3-chat results, if run.
- Per-test suite diff against base; typecheck result.
- What remains, and the risks.
