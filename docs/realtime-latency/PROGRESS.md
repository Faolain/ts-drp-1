# Real-time game completion

Updated 2026-10-24. This is the current continuation point; the [decision log](README.md)
and track reports preserve the earlier evidence. The owner has authorized correcting
assumptions and using executable models to find a sound, performant design.

The task is incomplete. Passing a room test that pauses at each rollover does not
establish uninterrupted play. A formal model proves its stated abstraction and bounds,
not native storage or network behavior.

## Verify-once perf integrated — 2026-10-25 (current)

Root `a3b1f276` = `6c9b5935` + three slices, each RED → GREEN with work-count tests:
issuance verify-once (`bd7f90cf`, Quint `issuance-store/formal/verified-once-cache.qnt`),
per-connection SQLite statement reuse (`f3a89775`), maintenance verify-once (`a3b1f276`, Quint
`storage/formal/verified-image-cache.qnt`). Caches are keyed by exact bytes, never cache a
refusal, are bounded (32–64 entries, ≤ a few MB) and return frozen/detached values. Per issue:
control verifications 25 → 3, plan verifications 130 → 0, SQL prepares 15–27 → 0. Targeted
suites green ([acceptance](../../.logs/realtime-resume-2026-10-23/perf-integration-02/summary.txt));
`retirement-image-cas` has the same 3 failures on `6c9b5935`.

Grid conservation 40 (serial, base `6c9b5935` → new, two runs each): transition 4466/3947 →
2587/2131 ms, install 3651/3186 → 1940/1622, seal 277/245 → 198/177, adopt 479/433 → 373/319.

Continued play 40, base and new run **concurrently** (same host noise), four pairs
([table](../../.logs/realtime-resume-2026-10-23/perf-timing-01/paired.txt)): all 8 pass; process
CPU 302–390 s → 260–270 s; GC 24.1/22.6 s → 18.4/17.6 s; timer max gap base 524/561/1384/— vs new
375/1954/790/1062. Serial runs earlier showed new stalls up to 1671 ms (one tripped the 1000 ms
alarm), which looked like a regression. The stall probe (`perf-timing-01/stallprobe.mjs`:
per-gap CPU, page faults, context switches, GC) shows the long gaps are the process not being
scheduled (wall ≫ CPU, no swap faults, GC ≤ 5 s of 20–80 s idle-stall wall), and they hit
base equally (base-p3 1384 ms, base-p4 59 idle quanta) on a host at load 40–119 with 22 GB
swap in use. Cached `get`/`all` statements do not hold WAL snapshots (`ck.mjs`). Conclusion:
no tail regression; the timer max on this host measures host load, not the code. Seal/adopt
remain CPU-bound blocking tasks (≈200–500 ms quanta) in both.

Next: cooperative yield points in seal/adopt; remaining canonical re-encode-to-compare
(`closedRetirementEqual`, signing image, journal image digest); then rerun the 300-epoch
campaign on the optimized root.

## North star met — 2026-10-24 evening

Every 300-epoch endurance run passes on one clean source, `6c9b5935` (reopen at 30):

| Run | Result | Wall | Issue p95 / max | Transition p50 / p95 |
| --- | --- | ---: | ---: | ---: |
| Canvas conservation | 300/300, 3000 accepted | 2867 s | 705 / — ms | 3742 / 4471 ms |
| Grid conservation | 300/300, 3000 accepted | 2194 s | 187 / — ms | 3570 / 4492 ms |
| Chat conservation | 300/300, 3000 accepted | 3156 s | 765 / 3235 ms | 4014 / 5206 ms |
| Grid continued play | 300/300, 1845 issues, 13 repairs | 3068 s | timer max gap 371 ms | install 2.7→3.1 s |

[Logs](../../.logs/realtime-resume-2026-10-23/final-6c9b5935/). Against PRE-PERF300-02, issue tails
are lower but transitions are ≈2× slower and seal/adopt still saturate the event loop
(next: per-merge transition-cost measurement between `6f414a25` and `6c9b5935`, then make
seal/adopt cooperative and cut install/maintenance CPU). Still open: rollback-promotion
post-promotion generation lifecycle, abandonment retirement-crash edge, 512-offer capacity
gate, browser/FPS.

### Transition cost by merge (measured, Grid conservation 40 / reopen 30, one at a time)

Medians over epochs 6–40; cycle fix `041c4136` cherry-picked where the import cycle blocks the
harness. [Logs](../../.logs/realtime-resume-2026-10-23/transition-bisect-01/summary.txt).

| Checkpoint | Transition | Seal | Adopt | Install |
| --- | ---: | ---: | ---: | ---: |
| `37bb6080` harness baseline | 1475 | 243 | 317 | 903 |
| `296cedf7` | 1455 | 242 | 300 | 894 |
| `79cf717c` rejoin + responsiveness merge | 2404 | 224 | 406 | **1761** |
| `5abfb079` | 2306 | 210 | 388 | 1689 |
| `bb3600e2` | 2300 | 222 | 394 | 1668 |
| `12b3794f` completion merge (`01944b66`) + cap fix | 3412 | 214 | 373 | **2814** |
| `041c4136` | 3411 | 221 | 382 | 2786 |
| `6c9b5935` final | 3359 | 210 | 373 | 2734 |

Inside the rejoin merge (`613ab647` base): `33453720` (rejoin branch + root, before yielding)
install 1514 ms; `a847900d` (after cooperative yielding `0e73815a`, which does not build alone)
1657 ms; merge `79cf717c` 1761 ms. So ≈620 ms comes from the rejoin branch's added verification
(checkpoint attachment/history authentication, historical source proof, pending bootstrap) and
≈140 ms from deliberate yielding. `34b08cd7`/`1515daab` cannot run the harness
(`nodeHostFor` absent), so the branch is not split further by bisect; a CPU profile of install
is the next instrument. Host load during these runs was 11–54 from another project's
long-running `tsgolint`/`tsgo` processes; the ordering is unaffected (fastest point ran at 46).
[Inner logs](../../.logs/realtime-resume-2026-10-23/transition-bisect-01/summary-inner.txt).

Recipient install is the whole regression: +≈860 ms at the rejoin merge (8 commits incl.
`1515daab`, `0e73815a`) and +≈1100 ms at completion custody (`01944b66`). Seal is flat, adopt
+≈80 ms. The prune, abandonment and lock-race fixes cost nothing measurable.

### Transition CPU profile (where to optimize)

Phase-scoped V8 profiles at `296cedf7` vs `6c9b5935` (profiled CPU per epoch: install 1359 → 4291 ms,
seal 481 → 664, adopt 574 → 865; continued-play maintenance 4061 ms). One dominant pattern:
durable canonical records are re-verified on every access (decode → rebuild → re-encode →
byte-compare → deep copy) instead of once per write. Ranked: issuance retirement control
re-validation from ~6 sites per issue (~900 ms), `issuanceRetirementBytesEqual` via
`Array.every` closure (457 ms self), settlement-plan decode + deep copy (~400 ms), census
re-authentication, per-call SQL `prepare`, codec round-trips and blob re-hashing in maintenance,
then yield points for seal/adopt. [Optimization map](../../.logs/realtime-resume-2026-10-23/install-profile-01/OPTIMIZATION-MAP.md).

## Campaign blockers found by runs — 2026-10-24 afternoon

- `12b3794f`: retirement-metadata 256 KiB cap → Grid now passes epoch 15 and the reopen at 30.
- `041c4136`: protocol-v3 import cycle (owned-signing-request → creator-checkpoint → trust
  singleton while the index evaluates) stopped `active-app-endurance-native` from collecting
  on root since merge `33453720`. Fixed with a RED-first module-order test; harness runs again.
- Writer-recipient issuance never prunes (bisected: good `34b08cd7`, first bad `1515daab`).
  This drives linearly growing install cost and the Grid continued-play starvation alarm
  (pre-merge 2131 ms, merged 1260 ms at the reopen-30 baseline). The completion merge
  adds per-epoch committed custody entries on top of that (plan 3 KB → 335 KB at 30 epochs).
  [A/B findings](../../.logs/realtime-resume-2026-10-23/grid-ab-01/FINDINGS.md). Fix in
  progress on `fix/recipient-prune`; acceptance is the recipient/Canvas long-room
  bounded-issuance tests plus the rejoin suites.
- Rollback promotion (`fix/rollback-promotion`: `8f964632`, `b49c2cfa`, `c0ff0afa`): BUSY,
  floor-3 recovery and post-promotion reopen fixed; the first issue after any promotion
  still fails `MAINTENANCE_AUTHENTICATED_SOURCE_HEADROOM` (needs a decision on which
  pre-promotion generations a post-promotion certificate may retire).
  [Report](../../.logs/realtime-resume-2026-10-23/rollback-promotion/RESULT-fixes.md).
- Conservation probe, 40 epochs, reopen 30, on `041c4136`: all three pass (Canvas 576 s,
  Grid 377 s, Chat 484 s). Per-epoch wall time plateaus after epoch 5 (Canvas ≈15 s,
  Grid ≈10 s, Chat ≈11 s), unlike continued-play install time, which grows linearly.
  [Log](../../.logs/realtime-resume-2026-10-23/endurance-probe-02/run.log).
- Source abandonment (`feat/source-abandonment`, 7 commits `a5e5e202`…`51aad355`, not yet
  integrated): unit/store/T8 native 6/6 + negatives, T9 kill-after-CAS recovers, rejoin
  suites green. Open: SIGKILL right after the removed author's retirement-preparation commit
  fails reopen with `snapshot-unavailable` (gated by `RUN_SOURCE_ABANDONMENT_RETIREMENT_CRASH=1`;
  same kill without abandonment recovers); join-time FENCE at seq 1 is a permanent hole so
  the abandoned row is retired but never physically pruned in the fixture.
  [Report](../../.logs/realtime-resume-2026-10-23/abandonment-impl/RESULT.md).
- Launched: 300-epoch conservation campaign on `041c4136`
  (`.logs/realtime-resume-2026-10-23/endurance-300-01/`, JSONL in `/private/tmp/ts-drp-endurance-300-01`).
  - Canvas: **300/300, 3000 accepted, 2919 s**, clean tree; issue p50/p95/max 118/708/1216 ms,
    receive p95 3230 ms, transition p50/p95/max 3778/4788/16210 ms.
  - Grid: **300/300, 3000 accepted, 2166 s**; issue p50/p95/max 61/186/239 ms, receive p95
    2941 ms, transition p50/p95/max 3565/4138/5072 ms.
  - Chat: **300/300, 3000 accepted, 3123 s**; issue p50/p95/max 165/768/1420 ms, receive p95
    3356 ms, transition p50/p95/max 4138/4702/7173 ms.
  - **All three conservation 300 PASS on `041c4136`** (EXIT 0, 3 passed, 8210 s total) — first
    since PRE-PERF300-02. Rerun on `1f8f8b65` queued (`final-1f8f8b65/conservation-300.log`).
- Recipient prune fixed (`d3b9e401` RED, `8ab3c8cb` fix, cherry-picked from `fix/recipient-prune`):
  epoch-0 kept close authority now verified by the genesis→epoch-1 rule (was `predecessor-rejected`);
  1515daab's fence early-return narrowed so a current member with only terminal retained work
  fences again; a terminal drain's reconstructed journal is declined once when fresh labels
  re-derive a different P. Recipient long-room 2/2 (prunedThrough 3→33, issued/outbox flat at 16),
  Canvas long-room, readmission 12/12, composition 15/15, plan-rewrite suites green.
  [Report](../../.logs/realtime-resume-2026-10-23/recipient-prune-fix/RESULT.md).
  Integrated checkout `/private/tmp/ts-drp-campaign-8ab3` (configs `/private/tmp/ts-drp-campaign-8ab3-config`).
  - Grid continued play 40 / reopen 30 on `8ab3c8cb`: **PASS** (390 s; was FAIL at 29). Per-epoch
    install flat ≈2.65 s from epoch 5 to 40 (was 16→26 s growing); timer max gap 264 ms,
    p99 151 ms; event-loop p99 140 ms.
    [Log](../../.logs/realtime-resume-2026-10-23/grid-continued-8ab3/grid40-run.log).
- Source abandonment merged: `1f8f8b65` (one import conflict in owned-signing-request,
  kept the cycle-free reattachment import). Acceptance on the merge, one file at a time: module
  order 4/4, received-close 2/2, recipient/Canvas long-room, expiry signing/verifier, abandonment
  6/6 + crash 1 (+1 gated), readmission 12/12, composition 15/15, bootstrap turnover 9/9,
  host turn 7/7, issuance-store 28/28, plan-rewrite 16/16, host-source-expiry 3/3, keychain 39/39,
  closed-epoch sequencing 19/19, close membership 24/24.
  [Summary](../../.logs/realtime-resume-2026-10-23/merge-abandonment-01/summary.txt).
- **Final campaign source `1f8f8b65`** (`/private/tmp/ts-drp-merge-probe`, configs
  `/private/tmp/ts-drp-final-1f8f-config`): Grid continued play 300 launched; conservation 300
  ×3 to follow. Logs `.logs/realtime-resume-2026-10-23/final-1f8f8b65/`.
  - Grid continued play 300 on `1f8f8b65`: **FAIL at epoch 62** (`maintenance-62`): `creator
    close active generation is unavailable`. A/B: `8ab3c8cb` (no abandonment) fails the same way
    at epoch 6 of a 70-run and in a 40-run, so it is nondeterministic and not from the merge.
    Instrumented: `recoverActiveGeneration` → `SUBSTRATE_FAILURE: database is locked` at
    `BEGIN IMMEDIATE` from the recipient recovery pool's `inspectHead`; with `busy_timeout=1000`
    on synchronous `DatabaseSync` this also blocks the loop ≈1.1 s (the 1162 ms task gap).
    Another same-process connection holds the AHE write lock across an await. Fix agent on
    `fix/ahe-locked-race`. [Diag](../../.logs/realtime-resume-2026-10-23/grid-continued-8ab3/diag-1.log).
  - Conservation 300 on `1f8f8b65`: Canvas **300/300, 3000 accepted, 2779 s** (issue p95 696 ms,
    transition p95 4031 ms); stopped at Grid 141 to move the campaign to `6c9b5935`.
- AHE locked race fixed (`7ee07f70` RED, `6c9b5935` fix). Measured holder: the recipient's
  retained publication read turn (`withCurrentRetainedRead` → native read reservation, `BEGIN
  IMMEDIATE` on a second connection, held across awaits inside the registration FIFO); waiter:
  the pool's turnover-due pre-check outside that FIFO (acquired 1.0–1.2 ms after the holder,
  blocked 1101/1106 ms). Fix: `inspectQueuedNativeHead()` runs the same `inspectHead` as a turn in
  the plane FIFO; `inspectHead` errors now carry the store reason. RED test held the read turn
  and got `SUBSTRATE_FAILURE: database is locked` after a 1082 ms stall. 3× consecutive Grid
  continued play 40 pass (timer max gap 270/264/290 ms); 3 concurrent fixed runs also pass
  (654/460/478 ms) where 3 of 4 unfixed failed. Remaining out-of-FIFO `inspectHead` callers
  (install-time adoption, `nativeHeadUnchanged`) never failed; left unmoved pending measurement.
  [Report](../../.logs/realtime-resume-2026-10-23/ahe-locked-race/RESULT.md).
- **Final campaign source `6c9b5935`** (`/private/tmp/ts-drp-merge-probe`): Grid continued play 300
  and conservation 300 ×3 running concurrently. Logs `.logs/realtime-resume-2026-10-23/final-6c9b5935/`.
  - **Grid continued play 300 / reopen 30: PASS** (3068 s, 1845 accepted issues, 13 repairs,
    0 busy/rejected, 48 unavailable per peer). Timer gap p95/p99/max 68/170/371 ms over 148,840
    callbacks (alarm 1000 ms). Install median 2696 → 3003 → 3125 ms at epochs 1–10 / 141–150 /
    291–300: bounded but still drifting ≈15% over 300 epochs.
  - Per phase (first 175 epochs): seal 226 ms and adopt 395 ms at event-loop utilization 1.0,
    ephemeral delivery 13/s and 9/s vs 183/s between transitions; install ≈3.0 s and
    maintenance ≈3.1 s deliver 62/s and 46/s with task gaps ≤343 ms. Adoption still degrades
    play; this is the next performance target.

## Stopped for shutdown — 2026-10-24

Root is `12b3794f` (plus this docs commit). In flight when stopped, all killed by shutdown:

1. **Grid 300 on `8ccac3f4` FAILED at epoch 15**: `canonical value exceeds byte limit`
   in `closed-epoch-cleanup.ts` retirement metadata (fixed 256 KiB vs the 1 MiB issuance
   control codec; completion proofs in plans crossed it). Fixed with a RED-first test in
   `12b3794f`. Evidence: `.logs/realtime-resume-2026-10-23/campaign-01/` and
   `.logs/realtime-resume-2026-10-24-shutdown/grid-300-01-failed/`.
2. **Next step**: a 40-epoch Grid probe on `12b3794f` (reopen 30), whose log was
   `.logs/realtime-resume-2026-10-23/campaign-02/grid40-run.log`, was running. Rerun it, then
   a short Canvas/Chat probe, then full Grid 300 → Canvas/Chat 300 (env exactly as in
   `endurance-preparation/preparation.json`; reopen 30; no forced checkpoint/vacuum).
   Campaign checkout `/private/tmp/ts-drp-final-campaign-preparation`: if `/tmp` was wiped,
   recreate it with `git worktree add --detach <path> 12b3794f`, then
   `pnpm install --frozen-lockfile`, then build `packages/node`, then `packages/storage-node`,
   then `pnpm -r build` (the first recursive build fails on that ordering). Recreate configs from
   `endurance-preparation/*.mjs` under `/private/tmp/ts-drp-final-campaign-config/`
   (hashes in `copy-manifest.json`). Affected preflight passed 16/16 on `8ccac3f4`
   (`campaign-01/preflight.log`).
3. **Rollback promotion fixes**: branch `fix/rollback-promotion` (base `c5b62bb5`); work
   was uncommitted. Snapshot: `.logs/realtime-resume-2026-10-24-shutdown/ts-drp-rollback-promotion.*`.
   Gate and report: `.logs/realtime-resume-2026-10-23/rollback-promotion/`.
4. **Source abandonment**: branch `feat/source-abandonment` at `dc53aaa0` (store-level
   expiry and publication exclusivity committed); further work uncommitted. Snapshot:
   `…-shutdown/ts-drp-source-abandonment.uncommitted.patch`. Results so far:
   `.logs/realtime-resume-2026-10-23/abandonment-impl/`.

Neither 3 nor 4 blocks the endurance campaigns; merge each into root only after its own
tests pass and then rerun the affected preflight.

## Resumed — 2026-10-24

Goal: the 300-epoch Grid/Canvas/Chat campaigns green again on the integrated source;
only executed tests and model checks count as evidence. Performance tuning follows.

- Completion delta reviewed (independent Claude review; no P0/P1). Fixed F1 (store
  admitted `→ expire` + resolution without a verifier; now legal only on `committed`)
  and F4 (retransmit labelled `published` without a publish). Committed `01944b66`,
  merged into root as `8ccac3f4`. Merged tree: fresh build, 97/97 focused tests.
  [Triage](../../.logs/realtime-resume-2026-10-23/rejoin-completion/resume-02/TRIAGE.md)
  keeps F2 (reserve over-counts own rows; fails safe) for the 512 gate to measure.
- Rollback-slot promotion gate written (`/private/tmp/ts-drp-rollback-promotion`):
  refusal controls pass, both usable-slot promotions FAIL on pre-existing production
  defects (floor 2: post-promotion issue headroom/reopen; floor 3: recovery-failed;
  floor ≥4: journal header `NATIVE_READ_RESERVATION_BUSY` against capacity
  maintenance). [Report](../../.logs/realtime-resume-2026-10-23/rollback-promotion/RESULT.md).
  Fix work in progress on `fix/rollback-promotion`.
- Source abandonment designed ([DESIGN](../../.logs/realtime-resume-2026-10-23/abandonment-design/DESIGN.md));
  implementation in progress on `feat/source-abandonment`, including the fence-less
  pruning liveness gap (removed author's committed entries never prunable).
- Campaign checkout refreshed to `8ccac3f4`; affected preflight then Grid and
  Canvas/Chat 300 follow. [Campaign evidence](../../.logs/realtime-resume-2026-10-23/campaign-01/).

## Paused for credit — 2026-10-23

The user requested a pause. No final campaign has started. Root at `05297776`
contains the reviewed performance scheduling, pure target reuse and latest formal
checks. Completion work remains **uncommitted** in
`/private/tmp/ts-drp-rejoin-readmission` at `a847900d` plus its frozen patch;
independent review was interrupted for this pause. Its durable resume handoff is
under [rejoin-completion](../../.logs/realtime-resume-2026-10-23/rejoin-completion/).

On resume, finish that review and fixes, commit and integrate completion, then
implement removed-author abandonment and finish the full recovery-range review.
Both usable rollback-slot recovery tests remain unfinished: only read-only design
was done, with no new test files or runs. The intended checks use genuine creator
owners, cold reopen and authenticated forward promotion from each actual local
rollback base, exact projection and subsequent useful issue, plus a physical
custody census that distinguishes the extra source-floor header.

The current-proof 512-offer capacity gate and final 300-epoch campaigns remain
pending. [Saved campaign preparation and unfinished rollback design](../../.logs/realtime-resume-2026-10-23/endurance-preparation/rollback-design.md)
include exact copies of the configs and manifest. The prepared checkout remains
at `/private/tmp/ts-drp-final-campaign-preparation`; refresh it to the final
reviewed composition and affected preflight before launch. Fresh-build every
runtime owner and record actual resolved module paths and compiled hashes, since
a correct source HEAD alone did not prevent a stale package export. Reopen at
epoch 30 and preserve the unforced WAL interval. Browser permission and rendering
FPS readiness remain open; the earlier source-specific receipts below do not
close them.

## Next agent prompt

Root native production now includes `bb3600e2`: reviewed scheduling after native
maintenance participants release, and reuse of a validated issuance-retirement target
within one synchronous check. These follow the recovery/outbox checkpoints at `5abfb079`.
The [track 42 receipts](tracks/42-native-continued-play/RESULT.md) preserve each source;
the pure refactor supplies no new latency measurement or capacity claim. Genuine recipient
SIGKILL evidence is integrated at `cc4a9908`; the coarse starvation harness is at `e20cd61d`.
The full `613ab647` to recovery composition review, historical pending egress after journal
retirement, and full-removal completion/local-author expiry
remain separate open gates. Do not describe the whole rejoin composition as fully reviewed.

Finish those gates and their affected composed checks before starting the final campaign.
The continued-play harness uses a 1,000 ms coarse starvation alarm with per-receiver
baselines after convergence. Passing it does not establish smooth play or close the
performance goal. Run Grid continued play and separate Canvas/Chat conservation for
300 epochs, reopening at 30; preserve the remaining uninterrupted WAL interval without
manual checkpoint or vacuum. Then run the remaining browser/capacity gates below. Preserve
the original Claude worktrees: several contain deliberately reversed source files from
before/after comparisons. Their committed heads and scratchpad progress reports identify
the candidate fixes. Use isolated checkouts, retain failed runs, and compare the actual
tests rather than aggregate pass counts. Update this file at each integration checkpoint.

Before launch, run the final changed completion/expiry/maintenance cases together with
the small native owner/close, mixed-history and real receipt/floor SIGKILL core. Preserve
one final-source campaign rather than repeating long runs before production is ready.
Planning allowance from existing receipts is 25–45 minutes for Grid and 80–110 minutes
for sequential Canvas/Chat, plus builds and roughly 2–5 minutes for the affected preflight.
Those estimates use different source scopes and are not bounds. Keep our heavy jobs idle
during Grid timing; continue recording external shared-host load.

## Completion contract

- Canvas, Grid and Chat continue through hundreds of real transitions with concurrent
  writers, delayed and lost delivery, bounded overload, and persisted reopen.
- Every accepted operation remains represented by authenticated committed state, durable
  pending work or a policy-authorized disposition. A sent request is not delivery evidence.
- Durable rows, queues, membership evidence and work per epoch plateau. Admission reserves
  the resources needed to finish accepted work before capacity exhaustion.
- Closure membership comes from the authenticated cut, even when a recipient missed
  members. Proofs live until their last consumer; retirement and plan updates are atomic.
- High-rate movement uses the existing unreliable ephemeral plane. Durable gameplay and
  chat retain their safety contract. Measure receiver-observed latency, frame stalls and
  maintenance overlap separately; report hardware, load and delivery conditions.
- Keep [G1–G28](../../specs/bounded-storage-lifecycle/golden-path-guarantees.md).
  Storage claims require both native owners, three browser engines and crash evidence.

## Active work

| Work | State and next gate |
| --- | --- |
| [Track X: settlement delivery and migration admission](tracks/34-track-x-settlement-fence-delivery/RESULT.md) | Integrated. The combined application campaign and the larger-capacity admission gate remain open. |
| [Track AA: creator delivery repair](tracks/39-track-aa-creator-delivery-repair/RESULT.md) | Integrated quiet-room retries and the reviewed replay lifetime/resource fix. Combined replay/H5 validation passed 51 checks, including held successor sends and native rewrite crash recovery. Real localhost libp2p repair also recovers a lost final copy and first answer without another move. Final quiet timings remain open. |
| [Track J: late-arrival model](tracks/38-track-j-late-arrival-retirement-model/REJOIN-CONTRACT.md) | The reviewed rejoin adjunct is integrated: 58 checks, 54 declarations, seven exhaustive graphs, six scoped Apalache checks and 38 negative controls; the largest graph has 2,335,818 states. Its exact model and implementation hashes match integration `77e641a3`. The explicit expiry producer is proposed, not implemented; full-contract arbitrary-state induction and native refinement remain **open**. Earlier replay/custody and A5 receipts retain their separate source scopes. |
| Authenticated partial-cut membership (F1) | Integrated signed successor membership transfer with native point reads. The endurance harness exports the complete v2 membership carrier. |
| [Durable classification and cleanup (F2, A-1, H2, H5)](tracks/40-track-x-native-retirement/RESULT.md) | Integrated durable terminal authority and atomic issuance/settlement-plan retirement. Native storage crash evidence is separate from application endurance. |
| [Recovery and long-room proof](tracks/41-active-application-endurance/RESULT.md) | PRE-PERF300-02 completed 300 epochs and 3,000 accepted operations in each of Canvas, Grid and Chat, with both peers reopening at epoch 150. This source predates the replay fix and remaining capacity/rejoin changes. The final integrated campaign is pending. |
| Arbitrary-gap rejoin and same-key readmission | **Open completion/review gates.** The native gap/custody checkpoint is composed into root. [Real recipient process-death evidence](tracks/42-native-continued-play/evidence/rejoin-process-death/RESULT.md) passes receipt-commit and floor-commit recovery of captured A despite newer B, preserving unknown signed work through another install/reopen. The complete `613ab647` to recovery review, durable full-removal completion and local-author expiry remain open. The separate physical census retains the distinction between an extra source-floor header and the oldest usable recovery base. |
| [Larger work per epoch](../../specs/bounded-storage-lifecycle/capacity-finishability.md) | Common currency, exact-intent and startup-recovery fixes are integrated, together with authenticated pending-bootstrap retention. Isolated shipped-profile campaigns finished 412 serial records across four cycles and 4,208 batched edits across six cycles. Common integration passes 22 focused controls and both real SQLite SIGKILL/recovery edges; final rejoin/performance composition remains open. Historical 357/489-record legacy creator-trusted/NONE failures are not shipped-app G2 regressions. |
| [Native continued play](tracks/42-native-continued-play/RESULT.md) | **Performance completion remains open.** Reviewed cooperative work, recovery/outbox checkpoints, released-participant maintenance scheduling and pure validated-target reuse are integrated through `bb3600e2`. The report keeps the matched pair and separate short candidates within their original source scopes. The pure refactor adds no latency or capacity measurement. Final completion/expiry composition, the 512 native-record offer and the 300-epoch campaign remain pending; the coarse starvation alarm is not smooth-play completion. |
| Browser parity | Actual three-engine browser launch remains **blocked** on macOS permission. Native libp2p plus controlled raw datagrams supplies no real browser WebRTC or rendering/FPS result. |

The new application harness uses the shipped compositions, two concurrent durable
writers, deliberately lost first copies, explicit durable replay, settlement-plan
conservation checks and persisted native reopen. Every epoch compares exact application
state; Chat also uses an independent whole-window retention oracle. The current load is
two initial writes per writer, four writes overlapping rollover, and writes overlapping
maintenance. It does not establish sustained high-rate play, unreliable ephemeral
traffic, automatic libp2p repair or arbitrary offline gaps.

The separate [native transport probe](tracks/42-native-continued-play/RESULT.md)
establishes automatic quiet repair and retains source-specific transition measurements.
Earlier profiles and the matched responsiveness pair preserve their original sources.
Per-phase raw observations remain available even when a short phase has no callback or
usable overlapping authority. Baselines compare public room/genesis/ACL scope and count
only codec-accepted deliveries; local channel observations are compared only with that
channel's starting observation. A coarse alarm or finite conservation receipt cannot
substitute for uninterrupted smooth play or browser rendering evidence.

The [completed campaign](tracks/41-active-application-endurance/RESULT.md) records
source `6f414a25` and exact patch hash `25f03f5a…3187449`. Logical rows and primary
files stabilize under its declared load, but whole-directory WAL bytes still grow
at epoch 300 because reopen at 150 resets the slowest owners before their ordinary
checkpoint threshold. The final campaign will reopen earlier and preserve a longer
uninterrupted segment. No checkpoint or vacuum will be injected to manufacture a
plateau. Epoch count, per-epoch work and dependency depth remain separate axes.

Earlier smoke and interrupted-run evidence remains identified in that report.
The harness now joins concurrent work before reporting a failure; failure injection
reproduces the old unhandled-rejection/early-cleanup behavior and passes after the fix.

## Evidence recovered

Claude's session evidence is under
`/private/tmp/claude-501/-Users-aristotle-Documents-Projects-ts-drp-1/62160344-dffd-4919-a00c-b5b5da90e416/scratchpad/`.
Each active track has a `PROGRESS.md`; the completion proposal is `track-x/CONTRACT.md`.
The root checkout started at `11552c43`. Its tracked files were clean; existing untracked
logs and the attached conversation are preserved.

Prior results include paused browser long rooms and Chat membership over 300 native
epochs. These remain useful regression evidence, but do not close the continued-play,
loss, crash or performance gates above.
