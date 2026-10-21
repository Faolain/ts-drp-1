Track T: move the shipped apps to the settlement profile, so their issuance stops growing with room age. Repository: ts-drp, a TypeScript local-first CRDT meant to power real-time games, whose rooms must live for thousands of epochs. The user chose this (decision "R-A for all shipped apps", 2026-10-20).

WHY
- Track P (docs/realtime-latency/tracks/26-track-p-canvas-issuance-growth/RESULT.md, merged in a3f3f6b0) fixed per-move work compounding with room age. Its part (a) found a spec gap: issuance is retired only under a settlement profile. Every deleter requires settlement (BSL:186; D.109b has no production caller).
- So shipped Canvas, which runs the legacy `creator-trusted-v1` profile (no settlement), keeps every row it ever issued: +2 rows per epoch at 2 moves per epoch, per-move work linear in retained rows, seal 4.4 s at epoch 16. At 20 moves per epoch the creator's move is refused in epoch 17 ("creator issuance maintenance proof reserve is exhausted").
- P offered two remedies. R-B, a new reviewed deletion rule for the legacy profile, was not chosen. R-A, give the shipped apps the settlement profile so the existing, reviewed settlement retirement (including Track N's recipient drain) bounds them, was chosen for all shipped apps.
- The user wants the change proven: storage flat over 16+ epochs, move and seal latency flat, and a record that the legacy profile still grows.

SCOPE (the shipped apps that use the legacy profile today)
- examples/canvas/src/index.ts:162 (shipped Canvas; createV3CanvasApplication is in packages/node/src/applications/canvas.ts).
- examples/grid/src/v3-zone.ts:1885 (the Grid example). The latency bench (tests/fixtures/startup-discovery, healthy-grid.ts:365) already runs `creator-trusted-settlement-v1`, so the bench's flat Grid storage says nothing about the shipped example.
- examples/v3-chat/src/index.ts:496 (the v3-chat demo). examples/chat already uses settlement (examples/chat/src/index.ts:237).
- Known node-side pin: `V3RoomSuccessorAuthority.profileId` is typed `"creator-trusted-v1"` only (packages/node/src/v3-room.ts:336), while the runtime check at v3-room.ts:770 accepts settlement. There may be others (v3-live.ts:1836, 4374, 4772, 11093, 17999; creator-close.ts:850, 2578, 3487; CRD:11822-11932, 12472, 14362).
- `settlementProfileFor` is at packages/protocol-v3/src/index.ts:31-37.

READ FIRST
- docs/realtime-latency/README.md (decision log, open items), tracks/26 (Track P) RESULT.md sections 4 and 5, tracks/24 (Track N) RESULT.md, specs/bounded-storage-lifecycle/golden-path-guarantees.md (G1-G28), specs/phase-6b-bounded-pruning/slices/01-issuance-retention.md.
- Memory notes with the bench recipe and pitfalls: <memory>/grid-latency-benchmark.md and stale-compiled-shadowing.md.

BASE
- Your worktree should start at codex/phase3a1b-p6-golden-path HEAD a3f3f6b0. Check `git log -1`. If it differs, run `git switch -C <your-branch> codex/phase3a1b-p6-golden-path` (`git reset --hard` is blocked).

ORDER OF WORK
1. Map before you change anything. Write <evidence>/track-t/MAP.md listing every place that pins or depends on the shipped apps' profile:
   - example sources, node and protocol types, runtime checks;
   - tests and fixtures that read the example sources as text or construct the shipped composition. These may assert or mention `creator-trusted-v1`. Candidates found by grep: tests/phase-3h-v3-room-rehearsal-red.test.ts, phase-3g-v3-room-rebase-red, phase-3-exit-genesis-roots-red, phase-6a-creator-successor-product-red, phase-6b-d110c-0c1f5b0u-successor-replay-red, r9-grid-outcome-transfer-native ("shipped none-settlement profile"), packages/node/tests/creator-ordinary-neutral-resource.test.ts, packages/storage-browser/tests/phase-6a-creator-successor-product.pw.ts and its assets entry, tests/fixtures/startup-discovery/shipped.ts and room.ts, tests/fixtures/grid-room-workload.ts, tests/fixtures/phase-*/... Track Q also noted that many contract tests read examples/v3-chat as source text;
   - frozen vectors, registries and governance artifacts.
   Classify each one: (i) unaffected (builds its own composition), (ii) a RED, governance or contract test, frozen artifact, registry or vector that pins the shipped profile, or (iii) code that must change.
2. If any class (ii) item would have to be edited for an app to switch, do not edit it. Leave that app on the legacy profile, and hand back the list for that app with a recommendation. Proceed with the apps that need no such edit.
3. Make the switch with the smallest change: the profile at each example, plus whatever the settlement profile requires of an application or of the node API (for example widening v3-room.ts:336). Report every app-level change beyond the profile string, and why it is needed. Keep one exported source of truth per app for its profile if that is natural, so tests follow the shipped choice.
4. Acceptance test: Track P's tests/canvas-long-room-issuance-retention-native.test.ts. Its (a) assertion is RED by design until this decision.
   - You may change exactly one thing in it: where its profile comes from (line 156, `profileId: "creator-trusted-v1"`). Make it the shipped Canvas profile, ideally imported from the shipped app's source of truth. Update its comments (lines 35-36, 543-544) to match. Do not change, loosen or remove any assertion, bound or epoch count.
   - Keep the legacy measurement: an opt-in variant (for example `CANVAS_LONG_ROOM_PROFILE=creator-trusted-v1`) that prints the census and does not assert boundedness. This is how the record shows that legacy still grows. Do not assert growth.
   - Both (a) and (b) must pass for the creator and the Writer recipient through 16 successors and the reopen.
   - Add equivalent node-level 16-epoch checks for the shipped Grid example composition and the v3-chat demo composition, if no existing test already covers them under settlement. Track N's tests/recipient-long-room-issuance-retention-native.test.ts is the pattern.
   - Rerun Track P's 20-moves-per-epoch probe (untracked, at <evidence>/track-p/trash/track-p-canvas-census-bound-probe.test.ts; copy it, don't commit it) on the settlement profile over 30 epochs. It must no longer be refused. Note Track N's open item: the 1,024-row issuance bound limits any Writer to roughly 100 moves per epoch.
5. Latency, base vs your HEAD, per epoch from the first steady epoch through 16+:
   - On Node: P's deterministic per-move native work counts, plus wall times for issue, seal and adoption/install.
   - In Chromium, for Canvas and Chat: Track M's harness, tests/fixtures/track-m-apps/browser/ (`pnpm exec playwright test -c tests/fixtures/track-m-apps/browser/playwright.config.ts --project=chromium`; see tracks/23 RESULT.md §11). Report per-epoch seal, adoption, install and issue p50, and the slope over epochs.
   - The shipped Grid example: if the latency bench cannot run the shipped profile, say so and use the node-level check.
   - Shipped Canvas and Chat creators declare no `readOrdinaryApplicationResourceBound`, so their lull reports `deferred:unsupported` and retirement stays inline at seal. Track Q fixes that and is held. Do not add resource bounds. Do report where settlement retirement runs (seal, adoption or lull) and what it costs per epoch.
6. If the 16-epoch proof passes: run a 100-epoch Canvas endurance run with per-epoch metrics (rows, bytes, seal, adoption, install, issue p50), measurement only. The user asked for 100-epoch runs for Canvas and Chat when sensible; Track M ran one for the Grid (tracks/23 RESULT.md §12, bin/endurance.py). Do Chat too if the harness allows it in reasonable time.
7. Document for library users that `creator-trusted-v1` keeps every issued row (no settlement, no retirement) and that apps should use `creator-trusted-settlement-v1`. Find where profiles are documented for users (package READMEs, specs, or a comment at the profile's definition) and add a short note there. Don't change the legacy profile's behaviour.
8. Suites: compare per test against base (node; the root room and native tests including Tracks K, L, N, P and the R3/M/O room tests; storage-node retirement; the Canvas/Chat equivalence tests). `pnpm -r typecheck` must report 0 errors. Run `node scripts/check-shadowed-sources.mjs`.
9. Commit your RESULT.md into docs/realtime-latency/tracks/30-track-t-settlement-for-shipped-apps/, with local paths written as <evidence>/…. Keep <evidence>/track-t/PROGRESS.md current.

PARALLEL WORK (keep out of these areas, and list every file and function you touch)
- Track Q (held, will rebase later) edits packages/node/src/applications/canvas.ts and examples/chat to add resource bounds.
- Track S edits packages/node/src/internal/creator-closed-rollback-data.ts (CRD) for a reopen right after the creator's first maintained lull (`floor-stale`). If a reopen in your runs fails that way, record it and don't fix it.
- Track M2 edits the opt-in room retention path (storage/storage-browser room-retention, CRD retention planning).

HARD RULES
- Never weaken G1-G28.
- Never edit existing RED or governance tests, frozen artifacts, registries or vectors to make something pass. The one exception is the profile source in Track P's test, as step 4 states.
- If a change cannot keep a guarantee, stop, record the counterexample and hand back.
- Run prettier on new files.
- Never run `tsc -p` without `--noEmit`.
- A hook blocks `rm -rf`, `unlink`, `git checkout <ref> -- <path>` and `git reset --hard`. Move unwanted files into <evidence>/track-t/trash/. Never delete logs.
- Commit only on your own worktree branch. Never push. Never touch the main checkout, except to copy the untracked bench inputs .logs/bounded-storage-lifecycle/r8-warm-capacity-01/ into your worktree (never commit them).
- End every commit message with exactly: Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
- Do not edit docs/realtime-latency/README.md; the coordinator maintains it.
- Builds: the Grid bundle and the browser harnesses read canonical, storage, storage-node, storage-browser and compaction from dist. Rebuild them in your worktree, building protocol-v3 before compaction. Stale dists produce errors like "roomRetentionControlDigest is not a function".
- Run vitest from the repository root with `--exclude ".claude/**" --no-coverage`.
- The machine is heavily loaded: compare per test against base, and rerun timeouts alone. Never kill processes you did not start.

<evidence> = <evidence>

FINAL REPORT
- The commit list.
- MAP.md summary: which apps switched, which were blocked by pins, and why.
- Every change beyond the profile string, and why it is needed.
- Track P's test: (a) and (b) results; the legacy measurement's census.
- Storage per epoch (rows, bytes) for creator and Writer recipient, for each app, 16+ epochs; the 20-moves probe result.
- Latency per epoch (Node and Chromium), with slopes, base vs HEAD.
- The 100-epoch endurance results, if run.
- Where the legacy-profile note was added.
- Per-test suite diff against base; typecheck result.
- What remains, and the risks.
