Track W: let a shipped Chat room run indefinitely. Its shared state becomes a rolling window of recent messages, and each device keeps a local archive of what it has seen. Repository: ts-drp, a TypeScript local-first CRDT meant to power real-time games, whose rooms must live for thousands of epochs. The user chose this design (2026-10-20).

THE PROBLEM
- Shipped Chat (examples/chat) keeps every message ever sent in its replicated state (`ShippingChatState.messages`, examples/chat/src/v3-chat-capacity.ts). Each author has a lifetime share of a 32 KiB budget (`SHIPPING_CHAT_RETAINED_BYTES`, `allocations`, `createShippingChatGenesisStateBytes`, `reallocateShippingChatCapacity`).
- Messages never leave the state. Track T's 100-epoch run refused new messages near epoch 57 at 4 messages per epoch (about 230 messages). That is by design and the same at base, but it means a Chat room cannot live long.
- The state is carried, hashed and signed into every successor, so simply raising the cap makes every transition heavier with room age (G1) and still hits a wall.

THE USER'S CHOICE: "Window + local archive"
- The shared room state keeps only a rolling window: the most recent messages that fit the budget.
- Older messages drop out deterministically, so every peer computes the same state and digest from the same authenticated inputs, and their bytes go back to their authors' shares.
- Per-author fairness stays: one author still cannot crowd out the others within the window. Only the "lifetime" aspect of the shares goes away.
- Each device keeps every message it has seen in a local archive outside the shared state, so a player can scroll back through their own history, and the archive survives a reopen.
- Late joiners see only the window.
- The window's size (bytes, and any message or epoch counts) is a reviewed limit (G21). Propose values and present them for the owner's review; don't treat your proposal as approved.

REQUIREMENTS
- G1: the replicated state, every room store and every transition stay flat with room age. The archive is application data on the device. It must never be read or written on the seal, adoption, install or lull paths, and it must not live in, or be counted as, room storage. Document exactly where it lives and what bounds it.
- The archive gets its own bound and eviction policy (for example a configurable cap in messages or bytes, oldest first), with a default proposed for owner review. Appending to it must stay off the move's critical path; measure the per-message cost.
- Trust: the archive records only messages this device authenticated and admitted, with the epoch and the authenticated facts it already had. It grants no authority and never feeds back into the replicated state, admission or any proof. It is shown to the player only as local history.
- Determinism: the window rule must be a pure function of authenticated state, so all peers agree on the state digest. Decide where the rule runs: in projection, in the successor's canonical state, or at admission. Check whether it must interact with the admission policy's reservations (`createShippingChatCapacityAdmissionPolicy`, the operation admission reservation), so that an admitted message is never refused or dropped before its epoch's state is sealed. Argue each choice against G1-G28.
- Crash and reopen: eviction must behave identically after a persisted reopen or a crash at any point (G3, G14). The archive must survive a reopen and tolerate a crash between admitting a message and appending it. Say what a player sees in that case; for example, the archive may miss a message that is still in the window, and it can be re-filled from the window.
- Format: this changes Chat's state format, for example `version: 3` to 4. New rooms use the new format; existing rooms keep the format their genesis signed (G25, no migration; the library has no users yet). Say so in RESULT.md.
- The settlement profile: shipped Chat already signs `creator-trusted-settlement-v1`. Keep it.

READ FIRST
- docs/realtime-latency/README.md (decision log, open items), specs/bounded-storage-lifecycle/golden-path-guarantees.md (G1-G28).
- examples/chat/src (v3-chat-capacity.ts, v3-chat-application.ts, v3-chat-message.ts, index.ts), and any spec that defines Chat's capacity, allocations or reallocation (search specs/ for "chat", "capacity", "allocation", "retained").
- tracks/30 (Track T) RESULT.md for the 100-epoch Chat run that stopped at epoch 57; tracks/23 (Track M) RESULT.md §11-12 for the Canvas/Chat long-room harness (tests/fixtures/track-m-apps/).
- Memory notes with the bench recipe and pitfalls: <memory>/grid-latency-benchmark.md and stale-compiled-shadowing.md.

BASE
- Your worktree should start at codex/phase3a1b-p6-golden-path HEAD 6066c539. Check `git log -1`. If it differs, run `git switch -C <your-branch> codex/phase3a1b-p6-golden-path` (`git reset --hard` is blocked).

ORDER OF WORK
1. Map. List every test, fixture, frozen artifact, registry, vector and spec that pins Chat's state format, its 32 KiB budget, its allocation or reallocation rules, or reads examples/chat as source text. Classify each as (i) unaffected, (ii) a RED, governance or contract test, frozen artifact, registry or vector that pins the current design, or (iii) code to change. Write <evidence>/track-w/MAP.md. If a class (ii) item would have to change, do not edit it: stop after the design (step 2) and hand back with the list and the exact amendments you would need, so the owner can decide.
2. Design. Write <evidence>/track-w/DESIGN.md, and a spec slice if the repository's practice for Chat capacity calls for one:
   - the window rule and where it runs;
   - per-author shares inside the window, and how bytes are released;
   - the admission interaction;
   - the archive's store, format, bound, eviction and trust;
   - crash, reopen and late-join behaviour;
   - the state format change;
   - the guarantee argument;
   - the proposed limits for owner review, in plain language: what each value is, why that value, and what a player sees when it is reached.
3. RED tests first, committed before any product change:
   - a Chat room on the node SQLite host, creator plus at least two Writers, runs 300 epochs at 4 messages per epoch with no refusal;
   - state bytes and every room store stay flat from the first steady epoch;
   - the state digest agrees across peers at every epoch;
   - the window holds exactly the most recent messages that fit;
   - one author cannot exceed their share inside the window;
   - the archive holds every message each device admitted, survives a persisted reopen, and respects its bound;
   - a late joiner sees only the window;
   - a crash between admission and archive append is tolerated as designed;
   - eviction is identical after a reopen.
   Use Track P's tests/canvas-long-room-issuance-retention-native.test.ts and Track M's long-room harness as patterns.
4. Implement with the smallest change. Keep product changes inside examples/chat, plus whatever archive storage helper it needs. If the library (packages/*) must change, stop and report why first.
5. Proof:
   - Node: the RED tests green; per-epoch state bytes, store rows and bytes, seal, adoption, install, lull and per-message issue latency, with slopes over 300 epochs.
   - Chromium: Track M's browser harness (tests/fixtures/track-m-apps/browser/) for Chat, 100+ epochs, measurement only: per-epoch metrics, IndexedDB size, the archive's size and its append cost.
   - Compare against base for the first 50 epochs, where base still runs.
6. Suites: compare per test against base (node; the root room and native tests, including Tracks K, L, N, P, M, O, M2, S and T's; storage-node retirement; every Chat test). `pnpm -r typecheck` must report 0 errors. Run `node scripts/check-shadowed-sources.mjs`.
7. Commit your RESULT.md into docs/realtime-latency/tracks/33-track-w-chat-rolling-window/, with local paths written as <evidence>/…. Keep <evidence>/track-w/PROGRESS.md current.

PARALLEL WORK (list every file and function you touch)
- Track Q is rebasing its Canvas and Chat resource bounds onto 6066c539. It edits examples/chat/src/v3-chat-application.ts (`createShippingV3ChatApplication`, new helpers `resourceDataRecord` and `resourceBoundBases`) and examples/chat/src/v3-chat-capacity.ts (exports `SHIPPING_CHAT_CAPACITY_STATE_LIMITS = LIMITS`). Its bound is derived from Chat's capacity, so your window changes what it measures. Expect to rebase onto Track Q when it lands, and keep your edits to those two functions minimal and separate.
- Track V is moving the v3-chat demo (examples/v3-chat) and the Grid example to the settlement profile. Do not touch examples/v3-chat or examples/grid. If the v3-chat demo has the same lifetime-history design, note it in RESULT.md as a follow-up.
- Track U may add measurement-only options to tests/fixtures/startup-discovery. Don't edit those files.

HARD RULES
- Never weaken G1-G28.
- Never edit existing RED or governance tests, frozen artifacts, registries or vectors to make something pass.
- If a change cannot keep a guarantee, stop, record the counterexample and hand back.
- Run prettier on new files.
- Never run `tsc -p` without `--noEmit`.
- A hook blocks `rm -rf`, `unlink`, `git checkout <ref> -- <path>` and `git reset --hard`. Move unwanted files into <evidence>/track-w/trash/. Never delete logs.
- Commit only on your own worktree branch. Never push. Never touch the main checkout, except to copy the untracked bench inputs .logs/bounded-storage-lifecycle/r8-warm-capacity-01/ into your worktree (never commit them).
- End every commit message with exactly: Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
- Do not edit docs/realtime-latency/README.md; the coordinator maintains it.
- Builds: the browser harnesses read canonical, storage, storage-node, storage-browser and compaction from dist. Rebuild them in your worktree, building protocol-v3 before compaction.
- Run vitest from the repository root with `--exclude ".claude/**" --no-coverage`.
- The machine is heavily loaded: compare per test against base, and rerun timeouts alone. Never kill processes you did not start. If a run you started leaves workers behind, record that in PROGRESS.md.

<evidence> = <evidence>

FINAL REPORT
- The commit list.
- MAP.md summary, and any pins that blocked you, with the amendments you would need.
- The design, in brief: the window rule, shares, admission, archive, crash and reopen, format.
- "Limits for owner review", in plain language: each proposed value, why, and what a player sees when it is reached.
- Per-epoch state bytes, store rows and latency over 300 epochs on Node, and 100+ in Chromium, with slopes; the archive's size and append cost.
- The guarantee argument.
- Per-test suite diff against base; typecheck result.
- What remains, and the risks.
