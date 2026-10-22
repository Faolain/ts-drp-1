Track W2: shares for Chat members who join after creation, and the bytes of members who leave. Repository: ts-drp, a TypeScript local-first CRDT meant to power real-time games and long-running chats. The owner chose this follow-up on 2026-10-21 (decision row 43) when approving Track W.

WHY
- Track W shipped Chat's version-4 rolling window (docs/realtime-latency/tracks/33-track-w-chat-rolling-window/RESULT.md). The room's shared state keeps each member's newest messages within that member's share of 32,768 bytes, split equally among the members at creation.
- Known limit (RESULT.md section 3 item 6 and "What remains"): a member added after creation gets no share unless bytes are free (as in version 3), and a member who leaves keeps that member's last messages in the window. A long-running chat gains and loses members, so a late joiner that cannot speak, or a window filled by departed members, breaks the product.
- The library caps room application state at 32,768 bytes (v3-room.ts normalizeApplicationStateBytes; pinned by tests/phase-3-exit-genesis-roots-red.test.ts:358-364). Raising it is an open item with no track; W2 works within 32 KiB.

ORDER OF WORK
1. OPTIONS FIRST, AND HAND BACK. Before building anything:
   - Map how membership changes reach the Chat reducer today: adding a Writer, removing one, settlement epochs, and what the reducer can see (member set, epoch, join epoch).
   - Design at least these options, each with its exact rule, what a player sees, the worst case (most members, a full window, a burst of joins or leaves), its effect on the per-checkpoint admission cap, whether it stays deterministic on every peer and on crash replay, and its cost per epoch:
     a. Rebalance on membership change: shares recomputed from the current member set, so existing members' oldest messages are evicted to make room.
     b. Reserve: a smaller genesis split that keeps a reserve for later members.
     c. Borrowing: unused share bytes can be used by anyone, and are reclaimed when their owner needs them.
     d. An age horizon: messages older than N epochs leave the window regardless of share, which also clears departed members' bytes.
     Combinations are fine. Say which you recommend and why.
   - Say what changes in the artifact digest, the blueprint, Track Q's resource bound (approved {32,768 bytes, 16,384 items, depth 16}) and the archive. Rooms already created on version 4 have no users yet, so no migration is needed unless you argue otherwise.
   - Write the answer at the top of <evidence>/track-w2/PROGRESS.md and in <evidence>/track-w2/OPTIONS.md, then STOP and hand back a short report. The coordinator takes the choice to the owner and resumes you with SendMessage.
2. After the go-ahead: RED tests first, committed before the product change. Then implement, keeping the window rule in the compiled reducer.
3. Proof: unit tests; the native 300-epoch run with joins and leaves added at chosen epochs (state flat, every peer's digest equal, crash replay equal); Track X's real-network harness for shipped Chat (16 epochs x 2 runs, plus a run with more messages than the window holds); Track M's browser harness; the Canvas/Chat e2e.
4. Suites: compare per test against base (root chat, canvas and room tests; Tracks Q, W and X's). `pnpm -r typecheck` 0 errors. `node scripts/check-shadowed-sources.mjs`.
5. Commit your RESULT.md into docs/realtime-latency/tracks/37-track-w2-chat-membership-shares/, with local paths written as <evidence>/…. Keep <evidence>/track-w2/PROGRESS.md current.

BASE
- Start at codex/phase3a1b-p6-golden-path HEAD, which the coordinator names in your prompt. Check `git log -1`. Create your branch with `git switch -c track-w2-chat-membership-shares codex/phase3a1b-p6-golden-path` (`git reset --hard` is blocked).

READ FIRST
- Track W's RESULT.md (folder 33) and <evidence>/track-w/DESIGN.md.
- docs/realtime-latency/README.md (decision log, open items); specs/bounded-storage-lifecycle/golden-path-guarantees.md (G1-G28).
- Track Q's RESULT.md (folder 27) for the resource bound.

PARALLEL WORK
- Track X is changing the settlement creator's startup order and ingress retention in packages/node/src/v3-room.ts and v3-live.ts. Track Z is working on the default storage host in the library and may touch v3-room.ts host selection. W2 should need no library change. If it does, stop and report first.
- Track V's held Grid switch owns examples/grid and examples/v3-chat.

HARD RULES
- Never weaken G1-G28.
- Never edit existing RED or governance tests, frozen artifacts, registries or vectors to make something pass. Track W's own tests can change only where the rule they state changes, and each such change is listed in RESULT.md.
- If a change cannot keep a guarantee, stop, record the counterexample and hand back.
- Run prettier on new files. Never run `tsc -p` without `--noEmit`. Don't run `eslint --fix` on committed RED tests.
- A hook blocks `rm -rf`, `unlink`, `git checkout <ref> -- <path>` and `git reset --hard`. Move unwanted files into <evidence>/track-w2/trash/. Never delete logs.
- Commit only on your own branch. Never push. Never touch the main checkout.
- End every commit message with exactly: Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
- Do not edit docs/realtime-latency/README.md; the coordinator maintains it.
- Builds: the browser pages and harnesses read canonical, storage, storage-node, storage-browser, issuance-store, node and compaction from dist. Rebuild after any change.
- Run vitest from the repository root with `--exclude ".claude/**" --exclude "**/.logs/**" --no-coverage`.
- Node: put `export PATH="<fnm>/node-versions/v22.15.0/installation/bin:$PATH"` first in every script and shell. Never change the fnm default or install anything globally, and never pair runs across Node versions.
- The Chromium harnesses use fixed ports 4174, 4175, 4180, 4181, 50000, 50002, 51000 and 51002, shared with other tracks. Check each port separately before a run (read lsof's output, not its exit code) and wait if any is taken. If a run fails with "is already used" or EADDRINUSE, rerun it.
- The machine is heavily loaded: use paired runs, compare per test against base, and rerun timeouts alone. Never kill processes you did not start.

<evidence> = <evidence>

FINAL REPORT (after step 5)
- The commit list; the chosen rule and why it is deterministic and bounded; what a player sees on join and leave; the digest change; latency and storage over 300 epochs with joins and leaves; per-test suite diff; typecheck; what remains.
