# Phase 0: design moving maintenance off the close path

**Outcome:** Design only. Concluded relocation alone does not remove the stall; led to the lull API and per-pass CPU work.

### Brief (plan given to the agent) (2026-10-19 07:27 UTC)

You are a fork. Task: READ-ONLY feasibility study + concrete design for moving bounded-recovery maintenance (reconcileCreatorBoundedRecoveryMaintenance and its passes) OFF the gameplay-stalling epoch-close path in <repo>. Do NOT edit any repo files (the working tree has the user's uncommitted work plus my in-progress perf edits; I am concurrently editing packages/storage/src/internal/bounded-read.ts and canonical/protocol-v3 — don't touch anything). You may write notes only under the scratchpad dir <evidence>/agent-offpath/. Never use rm -rf.

Measured facts (8 rollovers, current code): seal t0..t3 = 170-510 ms, but t4..t7 = 4.1-4.4 s each because close (packages/node/src/creator-close.ts ~3720-3800) runs maintenance after lifecycle="sealed" and before the successor exists, whenever owner.recoveryScopes >= owner.limits.maxRecoveryScopes || resume || capacityMaintenance (generation page > AHE_BOUNDED_READ_LIMITS.maxObjectGenerations-2). So in steady state EVERY close pays ~3.5-4 s of retirement/GC of old epochs while gameplay is stalled.

Answer, with file:line evidence:
1. Exactly what invariants force maintenance to happen at that point (storage bounds: maxRecoveryScopes, maxObjectGenerations, signing/journal limits; what breaks if the close proceeds with scopes == max; does the successor close/adoption/export need the slot freed?). Is there headroom we could create by triggering maintenance one epoch EARLIER (e.g. at scopes >= max-1) — i.e. is the bound a hard cap on storage after close, or only a precondition at close?
2. Whether maintenance could run (a) after successor adoption/activation during the next epoch's gameplay (background, chunked), (b) during the existing post-adoption window before gameplay resumes, or (c) pipelined/overlapped with close stages that are I/O bound. For each: what conflicts exist with ordinary issuance (maintenanceConsumer rejects while maintenanceJobs.size!==0; shared native stores: AHE coordinator control/generation pages, signing retirement store, live journal; recovery holds via sealRecoveryDependencies; the prospective sizing in composeProspectiveCreatorMaintenancePrefixesForSizing in packages/node/src/internal/creator-closed-rollback-data.ts that sizes 'preclose'/CURRENT/FUTURE maintenance inside ordinary issuance quotes). Does ordinary issuance already account for maintenance happening mid-epoch ('preclose' lifetime, 'capacityMaintenance', 'adoptionDrain' parameters suggest some of this exists)? Look for existing non-close entry points that call reconcileCreatorBoundedRecoveryMaintenance or the maintenance job (grep callers) — e.g. a startup/resume path, an idle path, a recipient-side path.
3. A concrete recommended design (smallest change that removes maintenance from the close critical path while keeping every proof/resource invariant), listing exact functions to change, how crash/resume works (retirementReconciliationPending, registration.retirementReconstruction, intent.active), how tests in packages/node/tests (e.g. creator-recovery-maintenance-job.test.ts, closed-epoch-retirement-sequencing.test.ts) and the Playwright healthy Grid test (tests/fixtures/startup-discovery/r8-source-binding.pw.ts, healthy-grid.ts) would be affected, and the expected latency effect. Also state clearly if you conclude it is NOT safely possible and why, and what the next-best option is (e.g. making each pass cheaper, fewer passes).
Keep the final report under ~900 words, specific and evidence-based (file:line). Do not paste large code.

### Report returned by the agent

Conclusion: the work can be relocated off the close path with a small change, but relocation alone does not remove the gameplay stall. Real removal needs per-pass CPU cuts plus idle-time scheduling.

**1. What forces maintenance at close**
- **Hard cap on the pool.** The close persists the new snapshot only if `scopes − retired + 1 ≤ max` (`creator-closed-rollback-data.ts:13406`, `:12421`). Storage refuses anything above the cap (`storage-browser/src/snapshot-transfer.ts:2104`). Default `maxRecoveryScopes` is 4 (`storage/src/snapshot-transfer.ts:1668`).
- **Why it repeats every close.** The pool is full again right after each close: retire one, persist one. So every close from t4 on needs one turnover first. Generation pressure follows the same pattern (`creator-close.ts:3752`).
- **It is not tied to the close.** Turnover selection depends only on generation count, pool owner, completed control and current epoch (`RB:14662-14672`, `RB:6667-6679`). It uses the current anchor's stable floor and the cut where `cut.epoch + 1 === current.epoch` (`RB:18954-18961`). That cut is E−1 both at close E and at epoch E's post-adoption boundary, so eligibility is identical there.
- **Headroom is possible.** A completed retirement only blocks scopes while `head.epoch ≤ throughEpoch + 1` (`RB:14641-14647`). The previous turnover had `throughEpoch = E−2`, so it does not block at epoch E.

**2. Where else it could run**
- **(b) Post-adoption readiness boundary: already exists.** `prepareOrdinaryReadiness` (`creator-close.ts:4632`) calls the identical `reconcileCreatorBoundedRecoveryMaintenance` (`:4715-4728`). It runs inside `runCreatorOrdinaryReadinessMaintenance` (`v3-live.ts:11262`), and the readiness producer tests already exercise the boundary (`creator-ordinary-readiness-producer.test.ts:30`).
  - Today it runs only for recovery halts, active or pending intents, or an uncertified window (`creator-close.ts:4693-4723`).
  - Pool pressure is deliberately deferred to "the original seal owner" (comment at `:4699-4703`).
  - It is called inside successor adoption (`v3-room.ts:6412`), so moving turnover there shifts ~3.5 s from seal to adoption. Net stall is unchanged.
- **(a) Background during gameplay: not without a redesign.**
  - The boundary needs full quiescence: no pending ingress, no rebase, no received transition (`v3-live.ts:11290-11303`).
  - It sets `blueprintClosing = true`, freezing admission for all passes.
  - It occupies `maintenanceJobs`, so `maintenanceConsumer` rejects ordinary issuance (`creator-close.ts:3403-3415`).
  - It discards the ordinary proof source, which then needs a cold re-prime of ~300 ms (`:4644-4645`).
  - The work is mostly synchronous main-thread CPU. The profile shows `baselineIntact` rehashing every blob (`storage/src/internal/bounded-read.ts:747`), which janks frames even when "backgrounded".
  - True concurrency would need a census that tolerates live consumers, and ordinary sizing would have to model mid-epoch maintenance. That is a protocol redesign.
- **(c) Overlap with close stages: little gain.** Maintenance first releases the recovery and promotion readers (`creator-close.ts:3774-3781`). Everything after it (re-acquire source, persist snapshot, membership, stage successor) depends on the post-retirement surviving roles. Only IDB idle time could overlap, roughly 15% of maintenance.
- **Mid-epoch already accounted for?** Partly. Ordinary sizing re-reads current pool and control state (`readProspectiveCreatorSnapshotTurnoverForSizing`, `RB:14690-14713`). After an early turnover it would size a "resume" turnover, which errs on the safe (larger) side.

**3. Recommended design (smallest safe change)**
- **A. Add pool pressure to the readiness `required` predicate** (`creator-close.ts:4693`): `owner.recoveryScopes &gt;= owner.limits.maxRecoveryScopes || capacity.value.generations.length &gt; AHE_BOUNDED_READ_LIMITS.maxObjectGenerations - 2`. Both values are already read at `:4686-4689`.
- **B. Fix the close's resume trigger.** After a readiness turnover the durable control has `throughEpoch = E−1`, so close E sees `throughEpoch + 1 === currentEpoch` and runs a full reconstruction pass anyway (`creator-close.ts:3762-3767`; activation halts on the same predicate at `v3-live.ts:20599-20611`). Fix:
  - When readiness maintenance returns "complete" (with ACK), record a process-local token on the `bindCreatorLiveClose` closure: the exact control read after completion.
  - At close, skip `resume` only if `!retirementReconciliationPending`, `registration.retirementReconstruction === undefined`, `intent.active === null`, and the intent equals the token.
  - After a crash the token is lost, so durable resume works exactly as today.
- **C. Scheduling to actually remove the stall.**
  - Add an explicit room API, e.g. `maintainRecoveryPool()`, that the game calls during a lull or loading screen. It re-enters `prepareOrdinaryReadiness` with the pool-pressure predicate.
  - Optionally trigger it automatically after N ms with empty `pendingIngress`.
  - The close keeps its inline maintenance as the fallback, like RocksDB's background compaction with a write-stall backstop.

**Tests affected**
- `creator-ordinary-readiness-producer.test.ts:30` (maintenance elision): new pool-pressure case.
- `creator-recovery-maintenance-job.test.ts` and `closed-epoch-retirement-sequencing.test.ts` exercise the job, not the trigger, so they should not change.
- The Playwright critical profile (`r8-source-binding.pw.ts:559`) attributes maintenance spans to transition 4 sealing; with A alone they move to adoption. The fixture deadline is 360 s (`healthy-grid.ts:292`), so it is not a risk.

**Expected effect**
- A+B: seal t4+ falls from ~4.1–4.4 s to ~0.5 s, but adoption rises by ~3.5 s. Total stall is unchanged.
- A+B+C: the stall moves to a moment the game picks, and close stays fast when the window ran.
- Not achievable: getting maintenance off the gameplay path entirely without a quiescence-free census or a Worker-hosted maintenance owner. That is not safe to do incrementally.

**Next-best, and a prerequisite for anything near ms**
- Shrink each pass. Hashing is the top cost: `hashDomain` 8.5 s across the run; `baselineIntact` with `digestBlob` ~1.6 s.
- Replace the re-hash in `baselineIntact` with an exact compare against a private copy.
- Cache verified blob digests per read lifetime.
- Cut the number of `checkCurrentSource` runs and the re-authentication per pass.
- Make the CPU loops yield (chunk them) so any background schedule does not jank frames.

No files were written; the scratchpad notes directory was not used.
