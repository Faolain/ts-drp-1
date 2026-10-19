# Phase 0: cut per-move admission latency

**Outcome:** Landed in 4c4f192c (concurrent per-move admission reads).

**Working documents in this folder:** [DESIGN.md](DESIGN.md), [notes-rootcause.md](notes-rootcause.md), [publication-path.md](publication-path.md)

### Brief (plan given to the agent) (2026-10-19 08:40 UTC)

You are a fork of me. New, focused task: cut the creator's PER-MOVE maintenance admission latency (the gameplay path), not epoch transitions (another agent owns those).

Evidence (run-pp-prof3 / pp-prof3.cpuprofile in the scratchpad, phasestat.py and spanprof2.py there):
- creator ordinary-issue-and-publication p50 ~145 ms; of that creator-maintenance-admission-inclusive p50 ~70 ms (write reservation ~7 ms, accepted-publication ~17 ms).
- Every REMOTE move the creator admits (received-append, v3-live.ts:7644) also pays ~70 ms admission. All ordinary ops hit `ordinary-incremental-hit` (prepareCreatorIncrementalIssuanceMaintenanceQuote via maintenanceConsumer, packages/node/src/creator-close.ts:3398-3560).
- Inside admission windows (68 windows): ~35% idle (waiting on IndexedDB round-trips), ~15% (program), JS ~21 ms/op. Hot: runBoundedSteps/loadBrowserBoundedReadRequest (per-op bounded census reads: head, keys, every generation, blobs + digestBlob), acquireRecoveryRoleCertificate, admitBrowserRetirementControl, readRetirementImagePoint, readRecoveryMetadata, inspectTrustClosure/authenticate, composeProspectiveCreatorMaintenancePrefixesForSizing, encodeCanonical.
- Strict IDB commit on disk is only ~0.7 ms (measured), so fsync is NOT the issue; the count of sequential IDB requests + re-verification per op is.

Goal: verify-once per-op admission. Identify exactly which facts each op re-reads/re-verifies that are invariant between ops in the same epoch, and replace them with a cache validated by a cheap currency token (e.g. one IDB read of head revision + retirement-control revision/digest + journal frontier inside the same transaction), falling back to the full original path whenever the token changes or anything is unrecognized. Also consider batching sequential IDB gets (getAll / single cursor) inside the bounded read steps. Never weaken authentication or capacity accounting: a cache hit must be provably equivalent (same exact bytes/digests), and refusals must keep their original reasons/precedence.

Work rules:
- Your worktree is clean HEAD; FIRST sync the main tree's uncommitted state into it (copy modified + untracked source/test files from <repo>, excluding .claude/, node_modules, dist, .logs output; see scratchpad/agent-redesign/ for the redesign agent's sync approach), run pnpm install if needed, rebuild canonical/storage/storage-browser/control-plane dist.
- Never use rm -rf (blocked). Do not commit to any branch other than a local WIP commit in your worktree; do not push.
- Benchmark with unique names prefixed `pa-` in the scratchpad (bench needs rollovers 4/5/8; machine is very loaded, so compare CPU profiles + interleaved paired runs, and report per-op p50 for creator issue, creator live admission and recipient issue).
- Run the relevant node/storage tests and compare against baseline failures (scratchpad/fails-base.txt plus a baseline run of the same files in your worktree before your edits). Use `--exclude ".claude/**"` with root vitest.
- Deliver: scratchpad/agent-perop/DESIGN.md (root cause per fact re-read, what is cached, why it is sound, what remains), scratchpad/agent-perop/prototype.patch (git diff against the synced baseline), test comparison, and before/after numbers. Keep your final report concise with the numbers.

### Follow-up instruction — Refocus per-move agent on redundant checks (2026-10-19 09:26 UTC)

Refocus: your concurrent-read prototype (pa-conc1) showed no measurable gain, so park the scheduleRead batching unless it is one small step from done.

Priority now: the 4 full check() passes per op (acquisition, capacity check-1, capacity check-2, begin), about 36 ms together.
- Work out which of these run under the same continuously held native exclusions/holds with no intervening write or await that could change what they verify.
- Collapse those to one check, or to a cheap currency re-read: head, retirement-control revision and the journal frontier compared to the values from the first check.
- Keep a full check wherever something could have changed in between. Refusal reasons and their precedence must stay identical.
- Prove equivalence in DESIGN.md, case by case.

Then finish the deliverables:
- prototype.patch, as a git diff against your sync baseline commit 6fa2bf3e;
- a baseline-vs-prototype comparison of the relevant node test files (use --exclude ".claude/**");
- interleaved paired per-op numbers (creator issue p50, creator live admission p50, recipient issue p50), plus your per-op sub-phase breakdown before and after.

Note: the main tree now also has the redesign patch applied (maintainRecoveryPool, creator-close.ts ~3773/4692/4776 and v3-live runOrdinaryReadinessMaintenance). Keep your patch in the maintenanceConsumer / admission area so it merges cleanly. Keep the final report concise, with numbers.

### Report returned by the agent (2026-10-19 10:06 UTC)

I cut the creator's per-move maintenance admission from about 73 ms to 48 ms p50 (−34%), without changing epoch transitions. Creator issue went from 141 ms to 101 ms. I collapsed two of the four checks; the other two have to stay full. Node tests show no regressions: the same 31 tests fail before and after the patch.

**Numbers** (interleaved base/proto/proto/base runs, pooled p50 / p95 in ms):

| Per-op | Before | After |
|---|---|---|
| Creator issue | 141.4 / 318 | **101.5** / 171 (−28%) |
| Creator issue: maintenance admission | 72.9 / 189 | **47.9** / 73 (−34%) |
| Creator live admission (received op) | 91.5 / 217 | **70.9** / 149 (−23%) |
| Creator live: maintenance admission | 71.6 / 97 | **47.9** / 92 (−33%) |
| Recipient issue | 46.7 | 46.0 (this path has no creator maintenance) |
| Remote accept | 86.5 | 70.3 |

**Sub-phases:**

| Sub-phase | Before | After |
|---|---|---|
| Proof acquisition | 54.6 | 39.4 |
| Source reads | ~33 run one after another | 21.1 run together |
| Check 1 (end of acquisition) | 7.6 | 7.2, still full |
| Capacity reservation | 19.1 | 11.2 |
| Check 2 (before the app hook) | 7.6 | **0.3** |
| Check 3 (after hook and charges) | 8.0 | 7.15, still full |
| Check 4 (at `beginWrite`) | ~7.6 | ~0.3 |
| Full checks per op | 3.9 | 2.1 |

Checks 2 and 4 took the fast path on all 196 ops; none fell back.

**The four checks, case by case**
- **Check 1 stays full.** Before it, the acquisition waits on several real disk reads, so other events can run in between.
- **Check 2 is merged into check 1.** Between them our code only does in-memory work and never waits on anything external.
- **Check 3 stays full.** The app's resource hook (arbitrary code) and the capacity charges run just before it.
- **Check 4 is merged into check 3** whenever nothing else ran in between. Both the local-issue and received-op paths call `beginWrite()` immediately after the quote comes back.

Your suggested "cheap re-read" of head, control revision and journal position wouldn't help much:
- Those values are already read cheaply (one probe each), and now overlap with the snapshot reads.
- The snapshot store isn't locked during admission, and its two reads are about 60% of each check. Its control revision doesn't change when snapshot rows are added or swept, so it can't vouch for them.

**How the merge works and why it's safe**
- When check 1 or check 3 finishes, it leaves a one-time token naming the single next check that may skip.
- The token is only valid until the browser or Node runs any other task (a storage event, timer, message, or crypto result). The token proves none has run since it was issued.
- The token is used up by its first use, by any other check, or by a check at the wrong point. In all those cases the check runs in full.
- A skipped check still runs the same outer runtime/signing checks and the same first steps: abort, released, frame alive, source identity. These fail with the same reasons, in the same order.
- Anything that could change the skipped storage facts comes from outside our code, and none of it can arrive while the token is valid. So every run of the new code matches a possible run of the old code in which the change landed a few milliseconds later. In that run, the old check would also have passed.
- A change the old code would have caught at check 2 is caught at check 3, with the same reason. The difference is that the app hook has already run, and an in-memory cache gets cleared.
- At check 4, the write's own expected-issuance and journal guards are unchanged.
- The full case-by-case argument is in DESIGN.md.

**Other changes in the patch**
- **Source reads in parallel.** Acquisition starts its independent storage reads at the same time, then judges them in the original order. This includes the native issuance read and the 15 ms signing borrow.
- **One deviation (signing borrow).** If an earlier check refuses, the new code has already borrowed the signing dependencies and releases them; the old code never borrowed. If that release fails, the op errors out and maintenance is marked failed. That is stricter, not weaker. It's one hunk if you'd rather drop it; it's worth about 10 ms.
- **Blob comparison.** The blob comparison is now linear instead of quadratic, saving about 1 ms per op.
- **Check reads in parallel.** Inside each full check, the snapshot, floor, journal and issuance reads run at the same time.
- **Parked.** The concurrent snapshot-read scheduling showed no gain, so it is not in the patch.

**Tests and merge scope**
- The patch touches only `creator-closed-rollback-data.ts` plus a test file, not `creator-close.ts`, `v3-live.ts` or storage. It should merge cleanly with the redesign.
- Baseline ran 866 tests (835 passed, 31 failed). The prototype ran 869 (838 passed, 31 failed), with exactly the same failures as baseline.
- I added 3 tests for the merge rule, and they pass.
- I made one local commit in the worktree (`afe76d83`) and did not push.

**Biggest levers left** (all outside the admission code):
- **Snapshot versioning.** A per-object version stamp in the snapshot store, or locking that store during admission, would turn each remaining 5 ms snapshot read into a single lookup.
- **Storage-lock polling.** The polling that keeps storage locks alive is about 9% of the creator's CPU.
- **Signing borrow.** The 12–15 ms signing-dependency borrow could be prepared once per epoch.
- **AHE read.** The per-op AHE read (8–11 ms) could be cached across ops.

Files are in `<evidence>/agent-perop/`:
- DESIGN.md
- prototype.patch
- ab2-compare.txt
- tests-base1.fails
- tests-proto2.fails
