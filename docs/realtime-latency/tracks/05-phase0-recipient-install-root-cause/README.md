# Phase 0: root-cause recipient install latency

**Outcome:** Read-only analysis. Led to Track B.

### Brief (plan given to the agent) (2026-10-19 07:27 UTC)

You are a fork. Task: READ-ONLY root-cause analysis of recipient install latency ('recipient-install-inclusive' span, healthy-grid.ts:281 → original.installCreatorSuccessor). Measured (8 rollovers, current code): t0 359 ms, t1 421, t2 488, then t3 1587, t4 1819, t5 1975, t6 2166, t7 2159 ms. The jump at t3 suggests recipient-side bounded-storage retirement/maintenance or a growing re-authentication cost starting at the 4th transition. Do NOT edit any repo files (I'm concurrently editing packages/storage/src/internal/bounded-read.ts, canonical, protocol-v3). Never use rm -rf. You MAY run read-only analysis and, if useful, ONE instrumented benchmark run using a NEW unique scratchpad name: e.g. `STARTUP_HEALTHY_GRID_CPU_PROFILE=1` only profiles the creator page, so instead prefer code reading + the existing evidence in <evidence>/run-state2r8/report.json (healthy-native-integrated-result attachment, roleObservers spans; see scratchpad/phases.py for how to decode) and run-prof8/report.json. Check whether the observer spans include sub-phases for recipient install that show where time goes (list distinct span 'command' names for recipients with per-transition max ms). Then trace installCreatorSuccessor in packages/node/src (likely v3-live.ts and internal/*) to identify: what runs at install (snapshot transfer from creator over the network, chunk validation/hashing, recovery source authentication, recipient retirement/maintenance when its own recovery scopes hit the bound, journal replay), and which of these grows with epoch count. Report: the top 3-5 cost centers with evidence (span data and file:line), whether the t3 step is recipient maintenance (and the trigger condition with file:line), and concrete fixes ranked by impact/risk. Keep report under ~700 words.

### Report returned by the agent

Task: read-only root-cause analysis of recipient install latency (`installCreatorSuccessor` / `recipient-install-inclusive`).

**Evidence: sub-phases for recipient-1** (from `run-state2r8/report.json`, `roleObservers[*].observer.spans`, keyed by `phase` where `command == recipient-install-inclusive`; max ms)

| phase | t0 | t1 | t2 | t3 | t4 | t5 | t6 | t7 |
|---|---|---|---|---|---|---|---|---|
| recipient-install-inclusive | 287 | 401 | 483 | **1587** | 1759 | 1744 | 2038 | 2018 |
| receive-authentication-retention-inclusive (`receiveCreatorSuccessorAdoption`) | 90 | 92 | 96 | **1164** | 1191 | 1247 | 1376 | 1422 |
| accepted-publication-inclusive (`publishAccepted`) | 6.5 | 11 | 21 | 28 | 40 | 41 | 79 | 80 |
| settlement-plan-and-fence | 31 | 38 | 52 | 44 | 56 | 53 | 57 | 62 |
| settlement-rebase | 34 | 42 | 60 | 52 | 67 | 64 | 75 | 78 |
| snapshot byte transfer + native verify | 11 | 9 | 8 | 7 | 14 | 7 | 9 | 8 |
| snapshot decode/verify | 4 | 4 | 3 | 3 | 5 | 3 | 4 | 4 |
| residual (install minus the phases above, mostly `performCreatorSuccessorAdoption`, v3-room.ts:6556) | ~117 | | | | | | | ~370 |

Recipients 2 and 3 show the same shape (receive phase 1.07–1.58 s from t3 on). Snapshot transfer, chunk hashing and decode are negligible at 5–15 ms.

There are no proof events inside recipient install at t0–t2. From t3 on, each install has 11–15 `proof-owner-start`, one `closed-retirement-selection`, one `closed-recovery-reader-borrowed` and 10 `closed-snapshot-preparation-declined`. Proof bytes charged grow from 0.74 MB (t3) to 1.09 MB (t7). That is the closed-epoch retirement machinery running inside install.

**Is the t3 step recipient maintenance? Yes.**
- `receiveCreatorSuccessorAdoption` (creator-adoption.ts:875) calls `prepareReceivedRecoveryTurnover()` at creator-adoption.ts:1302, before `scope.retainForRecovery`.
- Trigger at creator-adoption.ts:983–984: `currentEpoch &gt;= 2 &amp;&amp; owner.migration === "ready" &amp;&amp; (recoveryScopes &gt;= limits.maxRecoveryScopes || classifiedPresent)`.
- `maxRecoveryScopes` defaults to 4 (packages/storage/src/snapshot-transfer.ts:1668). The recipient checks before its incoming scope is added, so it fills the pool one transition before the creator (t3 versus the creator's t4).
- The turnover (creator-adoption.ts:985–1028):
  - opens signing custody and runs a full signing census;
  - loops up to `2 + epochs + maxObjectGenerations` passes;
  - each pass runs `sealReceivedRecoveryDependencies`, then `reconcileCreatorSnapshotRecoveryRoles` (creator-closed-rollback-data.ts:21414), then `reconcileSnapshotRecoveryRoles` and `installClosedRetirementSource`.
  - It loops while `installClosedRetirementSource` returns "fresh-summary-required".
- This is the same multi-pass, full re-acquire and re-authenticate engine as the creator's close maintenance.
- After turnover, install re-runs `verifyChain`, `verifySnapshot`, `selectedPromotionSnapshot`, `verifiedCatalog`, `projection` and two `inspectHead` plus `replay.verify` checks (creator-adoption.ts:1315–1322).

**Top cost centers, ranked**
1. Recipient bounded-recovery turnover inline in install: about 1.07 s at t3, rising to about 1.33 s at t7. Cost grows with retained signing, journal and generation data. This is 55–70% of install.
2. Residual recipient adoption (stage/publish/activate in `performCreatorSuccessorAdoption`): about 117 ms → 370 ms, growing roughly 35 ms per epoch. Same pattern as the creator's adoption growth.
3. `publishAccepted` (v3-room.ts:4205, a loop over `publishPending()`): 6 → 80 ms, linear in epoch count. Worth checking for O(history) work per pending row.
4. Settlement plan/fence plus rebase: about 65 → 140 ms combined, growing slowly.
5. Pre-turnover receive authentication: about 90–100 ms, flat. Not a growth driver.

**Fixes, ranked by impact and risk**
1. **Move recipient turnover off install (high impact: −1.1–1.3 s per install; medium risk).**
   - Run the same `prepareReceivedRecoveryTurnover` body as a background job right after a successful install/retain, when `recoveryScopes &gt;= max` (or `max-1` for headroom). The next install then finds the pool below the bound and skips both the turnover and the post-turnover re-verification.
   - The constraint in the comment at creator-adoption.ts:978–981 is "before the creator retires its copy". Mid-epoch execution satisfies it, because the creator retires at its next close.
   - It must serialize with recipient ordinary issuance, using the existing `beginReceived`/`terminalizeReceived` gating or an equivalent native-owner hold. If a background run is still active, install should either join it or fall back to the inline path.
2. **Cut per-pass cost in the shared retirement engine (medium-high impact, low risk, benefits creator and recipient equally).**
   - The probe-skip (`exhaustiveClosedSigningSummarySelections`) already lands on this path, because it is the same `installClosedRetirementSource`.
   - Dedup blob re-hashing in `baselineIntact`, `materialSteps` and the currency steps.
   - Reuse authentication across the pass loop at creator-adoption.ts:1009–1028; today every pass re-seals dependencies and re-authenticates from scratch.
3. **Skip post-turnover full re-verification when native identity is unchanged (−tens of ms, low-medium risk).**
   - Today it re-verifies the snapshot, catalog and projection (1315–1322).
   - A head/replay-equality check plus exact-byte equality of the chain inputs would suffice. This only matters while fix 1 is not in place.
4. **Bound the growth of `publishAccepted` and the residual adoption (low-medium impact).** Profile `publishPending` and `performCreatorSuccessorAdoption` for re-reads proportional to epoch count. Same root cause as the creator's adoption growth (fence cold path re-authentication).

No repo files were edited and no benchmark was run; all evidence comes from the existing run-state2r8 report and code reading.
