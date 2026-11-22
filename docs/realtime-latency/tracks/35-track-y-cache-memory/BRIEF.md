Track Y: trim the library's caches and size their ceilings by measurement. Repository: ts-drp, a TypeScript local-first CRDT meant to power real-time games, whose rooms must live for thousands of epochs. The owner chose this approach on 2026-10-21.

WHAT TRACK U FOUND (docs/realtime-latency/tracks/31-track-u-lull-seal-and-heap/RESULT.md, §4.3, §4.6, §6, §9)
- Every library cache that still fills late in a long room has a constant ceiling, so G1 holds. At those ceilings, each client realm carries about 37 MB of canonical hash memo, 17 MB of transition memo and 2 MB of trust-record keys.
- The caches:
  - `hashMemo`: packages/canonical/src/internal/codec.ts:1397-1405 and 1483-1505. 32 MiB of hashed parts and 32,768 entries, LRU. Full before epoch 50 in the Grid bench.
  - `transitionMemo`: packages/node/src/internal/creator-transition-advance.ts:1388-1396 and 1508-1543. It is set by `inspectCreatorTransitionAdvanceExact`, which is called from creator-adoption.ts, creator-adoption-commit.ts and creator-close.ts. 16 MiB of copied bytes, with each entry at most 4 MiB, LRU. It keeps a private copy of every candidate, material and ACL byte of each successful E→E+1 check, plus a key of about 2.7 KB. That is 2 entries of about 44 KB per epoch, and it fills at about epoch 190.
  - `trustRecordVerdicts`: packages/protocol-v3/src/index.ts:1176-1203. 1,024 entries and 2,097,152 key characters. The key must stay the exact record bytes; the code says never a digest or an identity. It fills at about epoch 106.
  - ed25519 `memo`: packages/protocol-v3/src/internal/ed25519-verify.ts:7-33. 4,096 entries, messages up to 256 B. It fills at about epoch 190.
  - `closureDigests`: packages/storage/src/values.ts:104-119. 4,096 entries of up to 64 references. Small.
- The transition memo fills with E→E+1 checks for epochs the room has already left. Those entries are probably never hit again, but nobody has measured that.
- The plateau was projected, not observed, because the Grid harness allows at most 128 rollovers (tests/fixtures/startup-discovery/healthy-grid.ts:382).

THE OWNER'S CHOICE: "Trim and size by measurement"
1. Measure first. For each cache, find out how much of it a steady game actually uses.
2. Drop transition-memo entries for epochs the room has left, if the measurement confirms they are dead. This part is approved: implement it.
3. For the hash memo, the trust-record verdicts, the ed25519 memo and the closure digests, propose ceilings from the measurement, with the latency cost of each. These are proposals for the owner. Measure candidates on a scratch branch, but do not commit a lowered ceiling until the coordinator relays the owner's approval.
4. Prove that memory levels off with a run longer than the 128-rollover limit, past the point where every cache has reached its ceiling or its trimmed steady state (about epoch 190 today, so aim for 256 or more). The owner approved going past 128 for this measurement. Do it with a NEW, explicitly named opt-in (for example `STARTUP_HEALTHY_GRID_ENDURANCE_MAX`) and leave the existing check unchanged for every existing value. If a tool or classifier refuses this, record the refusal, tell the coordinator, and prove the plateau with a Node long room instead.

REQUIREMENTS
- Each of these caches must be a pure performance cache: a hit returns exactly what recomputation would. For each cache, confirm this from the code and record it in MAP.md: the key is exact, a hit cannot skip a check whose result could differ, and evicting an entry cannot change any verdict, admission, digest, ordering or stored byte. If a cache turns out to carry meaning (for example, an eviction changes a later decision), stop and report.
- Nothing is admitted without full authentication. Trimming never relaxes a check.
- G1: per-client memory is flat with room age. After the trim, the transition memo holds a constant number of epochs.
- Latency: the trim leaves the seal, adoption, install and per-move medians unchanged. Use paired runs against base on the 8-rollover bench in LULL=1 and concurrent modes, with the room database and retention. For each proposed ceiling, give its latency against the current ceiling: a single number per path, and the worst case (for example a cold reopen, or the first transition after a long lull).
- Measurement hooks are measurement only: off by default, with no cost when off, and never on a shipped hot path. The cleanest route is a test-only hook, or a counter the harness reads, behind a flag the library does not read in production. Say what you chose and why.
- The trim must not add measurable work to seal, adoption or install. It runs when the epoch advances (adoption, install or close), or the memo is keyed so old epochs fall out on their own. All these caches are in memory only: confirm that nothing in them persists, so a reopen starts empty and crash behaviour is unchanged.

READ FIRST
- Track U's RESULT.md (all of it), and <evidence>/track-u/ (PROGRESS.md, heap/, bin/, grid/). Its heap-snapshot method (owners, retainers, `-tablestrings.txt`) and its `STARTUP_HEALTHY_GRID_HARNESS_RECORDS=counted` option, which keeps the harness's own records out of the heap.
- docs/realtime-latency/README.md (decision log, open items), and specs/bounded-storage-lifecycle/golden-path-guarantees.md (G1-G28).
- The five caches' code and every caller of each.
- Memory notes with the bench recipe and pitfalls: <memory>/grid-latency-benchmark.md and stale-compiled-shadowing.md.

BASE
- Your worktree should start at codex/phase3a1b-p6-golden-path HEAD 97fff267. Check `git log -1`. If it differs, run `git switch -C <your-branch> codex/phase3a1b-p6-golden-path` (`git reset --hard` is blocked).

ORDER OF WORK
1. Map. Write <evidence>/track-y/MAP.md:
   - each cache: where it is, its key and value, its bound and eviction, every caller and path (seal, adoption, install, per move, lull, reopen), and the pure-cache argument;
   - every test, fixture, frozen artifact, registry, vector or spec that pins any of these ceilings, keys or behaviours, or reads these files as source text. Classify each as (i) unaffected, (ii) a RED, governance or contract test, frozen artifact, registry or vector that pins the current design, or (iii) code to change. Never edit a class (ii) item. If the trim or a proposed ceiling needs one changed, list the exact amendment for the owner.
2. Measure, at base, with measurement-only hooks:
   - per cache: hits and misses per path, the age of the entries hit (in epochs since insert, and LRU position), the resident entries and bytes, by epoch;
   - for Grid, use the startup-discovery bench, LULL=1 and concurrent, with the room database and retention. For Canvas and Chat, use Track M's browser long room (tests/fixtures/track-m-apps/browser/). Add a Node host if its clients hold the same caches;
   - hit-rate curves: for each cache, the hit rate you would get at smaller ceilings (from the age and LRU-position distribution, or by replaying the recorded key trace through a model LRU at each candidate ceiling).
3. RED tests first, committed before the trim:
   - across many epochs, the transition memo releases entries for epochs the room has left (for example with WeakRef and a forced GC, or a test-only size probe) and holds at most a constant number;
   - a run with the trim gives the same verdicts, digests and stored bytes as a run without it.
4. Trim the transition memo, with the smallest change.
5. HAND BACK: stop and send a short report to the coordinator:
   - the hit-rate findings per cache;
   - the trim and its proof so far;
   - "Ceilings for owner review", in plain language. For each cache: the current value and the proposed one, the memory saved per client, the latency cost (typical and worst case), why that value, and what a player would notice, if anything. Keep a cache as it is where the measurement says so.
   The coordinator will put the proposals to the owner and resume you with SendMessage.
6. After the owner decides: apply only the approved ceilings, each in its own commit.
7. Proof:
   - RED tests green;
   - per-client memory after GC by epoch, over 256 or more epochs: the plateau, the slope late in the run, and every cache at its ceiling or steady state. Do this for Grid, and for Canvas and Chat at whatever length Track M's harness allows;
   - paired latency against base (8 rollovers, LULL=1 and concurrent): seal, adoption, install and per-move medians;
   - storage flat.
8. Suites: compare per test against base (node; the root room and native tests, including Tracks K, L, N, P, M, O, M2, S and T's; canonical, protocol-v3 and storage; storage-node retirement; the startup-discovery observers; Canvas and Chat e2e). `pnpm -r typecheck` must report 0 errors. Run `node scripts/check-shadowed-sources.mjs`.
9. Commit your RESULT.md into docs/realtime-latency/tracks/35-track-y-cache-memory/, with local paths written as <evidence>/…. Keep <evidence>/track-y/PROGRESS.md current.

PARALLEL WORK (list every file and function you touch)
- Track X is fixing the settlement fence delivery stall in the library: v3 ingress and pending ingress in packages/node/src/v3-live.ts, packages/node/src/room-network.ts, and possibly the settlement fence in creator-adoption.ts. Keep your edits to creator-adoption.ts, creator-adoption-commit.ts and creator-close.ts minimal and separate, or avoid them. Do not edit v3-live.ts or room-network.ts; if you must, stop and report first.
- Track W is changing shipped Chat's state to a rolling window (examples/chat). Don't edit examples/chat.
- Track V's held Grid switch owns examples/grid and examples/v3-chat. Don't edit them.
- Track U is finished, so you may add measurement-only options to tests/fixtures/startup-discovery. Leave every existing default and check unchanged.

HARD RULES
- Never weaken G1-G28.
- Never edit existing RED or governance tests, frozen artifacts, registries or vectors to make something pass.
- If a change cannot keep a guarantee, stop, record the counterexample and hand back.
- Run prettier on new files.
- Never run `tsc -p` without `--noEmit`.
- A hook blocks `rm -rf`, `unlink`, `git checkout <ref> -- <path>` and `git reset --hard`. Move unwanted files into <evidence>/track-y/trash/. Never delete logs.
- Commit only on your own worktree branch. Never push. Never touch the main checkout, except to copy the untracked bench inputs .logs/bounded-storage-lifecycle/r8-warm-capacity-01/ into your worktree (never commit them).
- End every commit message with exactly: Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
- Do not edit docs/realtime-latency/README.md; the coordinator maintains it.
- Builds: the browser pages and harnesses read canonical, storage, storage-node, storage-browser and compaction from dist. Rebuild them in your worktree after any change to those packages, building protocol-v3 before compaction.
- Run vitest from the repository root with `--exclude ".claude/**" --no-coverage`.
- The machine is heavily loaded: use paired runs, compare per test against base, and rerun timeouts alone. Never kill processes you did not start. If a run you started leaves workers behind, record that in PROGRESS.md.

<evidence> = <evidence>

FINAL REPORT (after step 9)
- The commit list.
- MAP.md summary: the pure-cache argument per cache, and any pins with the amendments they would need.
- The hit-rate findings.
- The trim, and why it is safe against each guarantee it touches.
- The ceilings applied, and the ones kept.
- Memory over 256+ epochs: the plateau and the late slope, per app.
- Paired latency against base.
- Per-test suite diff against base; typecheck result.
- What remains, and the risks.
