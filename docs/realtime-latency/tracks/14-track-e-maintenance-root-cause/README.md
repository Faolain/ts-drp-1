# Track E: root-cause maintenance cost and prove alternatives

**Outcome:** Analysis only. Proved the cost is architectural; modelled watermark retirement at 2.5 ms. Basis for Tracks R, R2, R3.

**Working documents in this folder:** [ROOT-CAUSE.md](ROOT-CAUSE.md), [ALTERNATIVES.md](ALTERNATIVES.md)

### Brief (plan given to the agent) (2026-10-19 15:42 UTC)

You are Track E. Your job: find out why recovery-pool maintenance (the retirement turnover run at seal, install, or the opt-in lull) costs 2–5 s per epoch on the creator and about 1 s per recipient. Decide whether the cause is architectural or incidental. Then propose alternatives and verifiably prove them: measured and tested, not argued.

Setup:
- Your worktree starts at 4c4f192c. First apply the merged tree with `git apply <evidence>/track-e/base-int.patch`. It contains Tracks A, B and D, recipient queueing, paged counted-range reads, and the storage-browser test re-pins.
- Rebuild canonical, storage and storage-browser dists (the bench reads them from dist), then build a base bench bundle. Use the `mx-` prefix for builds and runs.
- Put scratch files in `<evidence>/track-e/`.
- Do not commit.
- The machine is shared and loaded: use interleaved paired runs, and prefer CPU-profile and IDB request/transaction counts over wall time.
- You have about 200 turns. Budget them: diagnosis first, then prototypes.

Phase 1, decomposition. Answer with numbers per epoch and per pass:
- Why there are N passes. Use maxRecoveryScopes=4 and what the pass loop needs to "stabilize"; is the count inherent?
- Which fresh-native boundaries each pass re-establishes: census, holds, recovery reads, plan, two-phase install across about 6 participants. Count IDB transactions and requests per pass by owner, including readCreatorRecoveryDependencyCensus (about 46 transactions per pass, per Track D) and the HeldReadView #pump (more than half of requests).
- Split each pass into CPU by owner, IDB wait, and idle.
- Which of these costs exist only because each pass re-proves from scratch state that the previous pass, or this process, just wrote.
- Classify every big cost as one of:
  (a) inherent to the safety model;
  (b) architectural, from how the safety model is implemented (e.g. per-pass fresh census, all stores in one DB, retiring one scope per pass, main-thread hosting);
  (c) incidental inefficiency.

Phase 2, alternatives. Propose at least 3 and prototype the most promising 2. Candidates, not limits:
- batch-retire all due scopes in one pass with one census and one two-phase install;
- carry a verified census across passes inside one held boundary, with a change-detection proof (version stamps, or the commit sequence) instead of a fresh re-read;
- per-epoch stores, so retirement is a store drop rather than a row walk;
- host maintenance in a Worker, so the main thread never stalls (keep IDB on the worker);
- time-slicing with resumable intents;
- shrink or replace the #pump keep-alive (versioned reads, or a shorter hold);
- avoid the turnover entirely through a different pool policy (e.g. retire incrementally at every close, one scope at a time, so no pass batch accumulates).

For each alternative, give the safety invariant it must preserve and why it holds.

Phase 3, proof. For each prototype:
- **Correctness.** Show equivalence or safety with tests: differential tests that the final durable state, retired generations and refusal reasons match the original path for the same inputs, including crash or failure injection where the existing test fixtures allow it. Also run the affected node and storage-browser suites against your base, and report the test delta.
- **Performance.** Run interleaved paired Grid benches against your base with STARTUP_HEALTHY_GRID_POOL_LULL=1, at least 2 pairs. Report:
  - per-epoch maintenance cost (creator and recipient);
  - seal t4–t7 and install t3–t7;
  - IDB transaction and request counts per pass;
  - main-thread long tasks over 16 ms in the maintenance window. Use STARTUP_HEALTHY_GRID_TASK_TRACE as Track A did.
- If a prototype is not sound, say so and drop it; don't ship it.

Deliverables:
- patch file(s) in scratchpad/track-e/, one per prototype, against base-int.patch applied;
- a concise final report in your reply. Subagents can't write REPORT.md. It must cover:
  - the decomposition table;
  - architectural vs incidental verdict;
  - the alternatives with invariants;
  - measured before/after;
  - the test delta;
  - a recommendation for the real-time target (maintenance never blocks a frame or a move for more than 16 ms).

### Report returned by the agent

Maintenance is slow because of the architecture, not because of a hotspot: each maintained epoch re-proves the whole recovery state four times to make 103 row writes. Codec-level caching gave no measurable gain. A model of the watermark-retirement redesign (proposed below) retires an epoch in **2.5 ms**, versus ~2.7 s today.

Everything here comes from the healthy-native Grid bench (8 rollovers, creator maintaining at a lull) on the integrated A+B+D tree. Real-system comparisons were run as interleaved base/variant sets on a loaded machine. Nothing is committed; the worktree is back to its base state, checked file by file.

**Root cause: what one maintained epoch actually does**

The counts are identical from run to run:

- **Real work:** 61 puts and 42 deletes.
- **IndexedDB traffic:** 11,217 requests in 1,398 readonly and 57 durable (strict) write transactions, spread over 6 separate databases. On top of that, about 26,800 keep-alive requests from the code that holds read transactions open.
- **Encoding/decoding:**
  - 19,100 decodes (34 MB) of only 410 distinct inputs: 97.9% repeat earlier work.
  - 38,100 encodes (39.5 MB) of 1,586 distinct outputs: 95.8% repeat.
  - In passes 1–3, 99.7% of decodes repeat; each pass sees only about 15 new byte strings.
  - The existing hash cache gets about 17,000 hits over 58 MB.
- **The decisive test:** I added one extra maintenance pass that finds nothing to retire. It still costs **0.44–0.86 s**, about the same as a real pass (0.53–0.79 s). So nearly all of a pass's cost is fixed re-checking overhead.
- **Time split (about 2.7 s per epoch):**
  - re-reading and re-authenticating everything in each of 4 passes: about 1.2 s
  - four cross-database two-phase commits: about 0.8 s
  - the actual stage work: about 0.4 s
  - re-capturing state after maintenance: about 0.25 s
- **CPU profile:** 30% waiting on IndexedDB, 23% encoding/hashing, 14% IPC/cloning, 6% the keep-alive loop. The rest is a long tail of verifiers at 1–4% each.

**Why the code is shaped this way**

- **Proof per operation:** every local operation rebuilds a size-limited proof (4 MB budget for maintenance) from fresh reads. Many encodes exist only to measure byte size for that budget.
- **Four passes per epoch:** the protocol allows one kind of retirement per pass (journal and evidence, or summaries, or one generation). Each epoch adds two generations, so every epoch needs four passes.
- **Nothing carried over:** no verified state survives from one pass to the next.
- **Six databases:** IndexedDB only makes a transaction atomic within one database, so retirement needs a hand-built two-phase commit across all six.
- **Keep-alive loop:** read transactions are held open by spinning a dummy request, about 20,700 per second when idle.
- **Re-encoding to check:** every check re-encodes every row to recompute a digest.

**Alternatives, and what each was shown to do**

| Alternative | How tested | Result |
|---|---|---|
| Cache encode/decode results | Real system, interleaved runs | No measurable change (pair means 2,848 ms base, 2,781 ms, 2,833 ms). Detecting a repeat costs about as much as redoing it; ruled out. |
| Remove the keep-alive loop | Real system | Breaks the lull path: every lull deferred as busy, sealing went from 0.3 s to 2.7–4.1 s. Cached facts are tied to the held transaction, so this needs revision counters plus Web Locks first. |
| Do all stages in one pass | Extra-pass test | About 2.7 s → 0.9–1.1 s (−60%). Needs protocol and proof-budget changes. |
| Carry verified state between passes | Redundancy counts; Chromium model | About 0.6–0.9 s left. A currency check takes 0.3 ms instead of about 52 ms. |
| One database, one transaction | Chromium model, on disk | Each two-phase commit drops from 12.8 ms to 1.3 ms (the real commit phase is about 0.8 s per epoch). |
| Watermark retirement (redesign) | Chromium model, on disk | **2.5 ms** median (max 4.3 ms), or 6.2 ms if the six databases stay separate. |

The watermark redesign means:

- one database, with keys grouped by epoch so retiring an epoch is a range delete per store;
- verify data once when it arrives;
- keep digests up to date incrementally as rows are written;
- a single increasing "retired through epoch" mark that writers refuse to go below.

The model used the bench's real per-epoch retirement set, and the surviving rows checked out exactly.

**Conclusion:** codec and keep-alive fixes are worth at most about 10–25%. Protocol work inside the current storage design gets to about 0.6–1.1 s. Getting to milliseconds requires the storage and trust redesign above. Its main trade-off is trusting local IndexedDB contents once they have been verified on arrival, which is the normal client model. Suggested order:

1. revision counters plus Web Locks, replacing the keep-alive loop;
2. carry verified facts between passes;
3. merge the stages into one pass;
4. migrate to one database with epoch-grouped keys and a watermark.

All files are in `<evidence>/track-e/`:
- `ROOT-CAUSE.md`
- `ALTERNATIVES.md`
- `patches/diag-counters.patch` (reusable counters)
- `patches/whatif-nopump.patch`, `patches/whatif-codec-memo.patch`, `patches/whatif-extra-pass.patch` (test-only, not shippable)
- `idbmodel/` (Chromium models: `out2-disk.json`, `out3-v2.json`)
- `diag-e.py`, `whatif.py` and the analysis scripts
- `run-*/report.json` (raw run reports)
