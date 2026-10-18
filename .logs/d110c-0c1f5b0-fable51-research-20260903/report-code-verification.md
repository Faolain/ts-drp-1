# D.110c-0c1f5b0 + f5b0p — code-grounded verification report

Scope: read-only verification of `.logs/d110c-0c1f5b0-design-00a860ab/design.md` (f5b0) and `.logs/d110c-0c1f5b0p-design-e6a67013/{design,audit}.md` (f5b0p) against the working tree on `codex/phase3a1b-p6-golden-path`. Every code claim cites `file:line`; every design claim cites the design line.

## Claim-by-claim verification

| Design claim | Verdict | Evidence |
| --- | --- | --- |
| ACL caps at 64; `freezeMembers` drops a key after its last role/finality key; no incarnation bit (f5b0p audit §1) | Confirmed | `packages/protocol-v3/src/latched-acl.ts:132-134`, `:351-368`, `:376-446` |
| Opaque creator signing custody | Confirmed | `creator-author-issuance-frontiers.ts:299`; `packages/node/src/creator-close.ts:568-571` |
| Issuance store owns `transactIssue`, `prunePublishedPrefix`, lineage watermark | Partial | `packages/issuance-store/src/types.ts:82-89` (no prune on `DurableIssuanceStore`); prune is `DurableIssuancePruningMaintenance` `maintenance.ts:40-43`; ref impl `conformance.ts:313-380` requires one `closedEpoch` (`:366`) and `published` (`:369`). **No production caller** (only `storage-node/tests/phase-6b-*`, `storage-browser/tests/assets/phase-6b-issuance-retention-entry.ts`). |
| Live-journal replay authenticates local rows via issuance store + blueprint admission | Confirmed | `packages/node/src/v3-live.ts:4453-4560` (`readIssued` `:4508`; `extractAuthorizedV3Vertex` → blueprint-bound `extractAdmittedReceivedVertex` `:3797-3806`); size invariants `:4477-4480`, `:4547-4549` |
| Six `preparedBlueprintAdmission` families | Confirmed but incomplete | `v3-live.ts:2019, 2336, 3801, 4699, 4770, 5977`. Seventh consumer: the creator durable-replay seal `sealCreatorDurableReplay` `:4562-4590` used by `creator-close.ts:912` and `:308`. |
| `rebaseIntents()` returns `[]` for `join/causalJoin/acl` | Confirmed | `v3-live.ts:6308-6340`, reserved set `:224` |
| `stageBlueprintEpoch()` folds the same map that is the close graph | Confirmed | `v3-live.ts:7038-7050`; `captureCloseGraph` `:7430-7460` requires `vertices.size === registration.index.size` and `blueprintFolded` |
| Close maps `closeVertices/closeAuthors/closeCharges` | Not existing names | Existing: `applicationVertices/applicationAuthors/applicationCharges` (`v3-live.ts:7433-7435`) — today the *complete* map; f5b0b must rename, not add (naming collision). |
| v1 aggregate `[author, admittedThrough]`, ≤64, 8,192 B | Confirmed | `creator-author-issuance-frontiers.ts:61, 176-179, 12` |
| Legacy retirement record hard-stops creator displaced rows | Confirmed | `node/src/internal/creator-issuance-retirement-boundary.ts:127-135`, `:145` |
| `maxEpochVertices/maxEpochBytes/maxPendingEntries/maxPendingBytes` | Confirmed | `v3-live.ts:852-857`, `:2349-2350`, `:6227`, `:4456-4464` |
| RFC 9162 history has no author index | Confirmed | `packages/compaction/src/history-commitment.ts:28,45,48` |
| Flat AHE closure verifier; reclamation from generation/promotion rows | Confirmed | `storage/src/internal/closure-verifier.ts:95-120`; `storage-browser/src/internal/ahe-reclamation.ts:139-169` |
| Room rebase startup barrier | Confirmed | `examples/v3-room/src/index.ts:2796-2990`, `:2992-3000` |
| `covered-historical` / `displaced` classes | Confirmed, narrower than assumed | `v3-live.ts:4593-4645`: `displaced` authenticates only against **one** predecessor payload (`:5010-5100`); `covered-historical` needs `historicalIssuance`, created **only for the creator's scope** (`:7886`, `:7946`, `:4752`) from the single-author retirement record (`creator-transition-advance.ts:225-260`, `:240`). |
| Foreign non-advance keeps close alive; creator-own duplicate/regression fail closed | Confirmed (f5a) | `creator-close.ts:487-494`, `:539-546` |
| Profile hard-coded `creator-trusted-v1` | Confirmed + unlisted owner | `protocol-v3/src/index.ts:124,391`; `creator-close.ts:276,541,598`; `creator-checkpoint.ts:144,242`; `node/src/v3-live.ts:1431`; `node/src/creator-close.ts:209`; `examples/v3-room/src/index.ts:242,488,3985`; **`packages/protocol-v2/src/registry.ts:460`** (not named). |
| Bytes: op 6,003; checkpoint 7,064; node 792 | 6,003 ✓, 7,064 ✓, 792 conditional | Reproduced via `packages/canonical/dist` (scratchpad `measure.mjs`, `measure2.mjs`). Node = 792 only with `height` ≤ 3 encoded bytes (e.g. 76); all-`MAX_SAFE_INTEGER` = 810. Design's own bound (height ≤ 76) makes 792 defensible; RED must pin exact field values. Other distributions: 1 src/8 intents = 4,498; 7 zero-intent + 1 app = 5,947 → 6,003 is the true max. |

## Findings

### P0-1 — `settledThrough ≤ admittedThrough` is inverted; membership-changing close fails closed forever after the first disposition
- f5b0p `design.md:54-57` vs f5b0 `design.md:359-360`, `:367-368`.
- First principles: every admitted slot is settled ⇒ admitted dense prefix ⊆ settled dense prefix ⇒ invariant is **`admittedThrough ≤ settledThrough`**; `admittedThrough === null` with non-null `settledThrough` is legal (zero-intent for genesis `join` slot 0). After any `expire`/`rebase`, honest state is `settled > admitted`; inserting a removed member with that state (`f5b0p design.md:127-128`) is invalid → the ACL-changing close aborts (`:146-147`), permanently.
- Dependent errors: (a) `f5b0p design.md:130-131` re-entry bound "strictly above `admittedThrough`" must be **`settledThrough`**, else a re-added key issues into terminal slots `(admitted, settled]` (`f5b0 design.md:392-394`) → silent loss; (b) `f5b0 design.md:395-398` "above `settledThrough` and ≤ `admittedThrough` … covered-historical" is an **empty set** — the recovery taxonomy must be rewritten.
- Amendment: `admittedThrough === null || (settledThrough !== null && settledThrough >= admittedThrough)`; re-entry bound = `settledThrough`; delete the vacuous class.

### P0-2 — The checkpoint cannot convey, and the grammar cannot express, "already admitted in a closed epoch"; honest dispositions are undecidable and a frontier can stall forever
- Creator scans only the **current** graph (`f5b0 design.md:358-359`, `:377-379`). A slot admitted in an earlier closed epoch above an unsettled gap is never graph-accountable; the only history-flavored outcome is `already-present`, gated on `hasDisplacedOperation` (`:170-174`), which is unsound as history evidence (overwritten effects, non-idempotent ops → `false` → forced `rebase` = wrong/duplicate op, or `expire` = mislabeled).
- Reachable: (1) the design's own durable order (`:252-259`) has a network publish between step 1 (replacement admitted) and step 2 (control issued); a close inside that window leaves source `s` (epoch N) unsettled and replacement `s+k` admitted in epoch N+1 beyond the gap; at close N+2 it is "unknown evidence" and cannot be referenced (`:106-107`). (2) The plan's named "no-rebase trigger" (`docs/production-hardening/production-hardening-tdd-plan-v2.md:98682-98689`).
- The author cannot learn admission either: `historicalIssuance` is creator-only (`v3-live.ts:7886,7946,4749-4757`), and `admittedThrough` stops below the gap by definition. Outcome: double-apply on reissue (`v3-live.ts:6445-6470`, `examples/v3-room/src/index.ts:2880-2980`) or a permanently stalled frontier → unbounded rows for that author.
- Amendment (reuses f5b0p machinery): add a second entry kind to the Merkle AVL dictionary — **admitted-beyond-prefix slots** keyed `(author, authorSequence)` with closed epoch/anchor — inserted by the creator at close for every graph slot strictly above the author's new `settledThrough`, deleted when `settledThrough` passes. Accounting rule: graph vertex **or** dictionary membership **or** one same-author disposition. The room verifies O(log R) membership/nonmembership from untrusted storage against the checkpoint root before choosing: member → complete without disposition; non-member → `expire`/`rebase`/`transform` truthfully. `already-present` becomes an optional optimization or is deleted. Cost: same archive-tier class already accepted; O(M log R) per close, M ≤ `maxEpochVertices`; checkpoint bytes unchanged. Rejected alternative: per-author admitted ranges in the checkpoint — 7,064 B + 64 × ~22 B ≈ 8.5 KB > 8,192 B ceiling, and adversaries fragment ranges without bound.

### P1-1 — Rows older than epoch−1 are unclassifiable; "retains displaced/rebase behavior" is false for them
- `classifyPlaneVertex` `v3-live.ts:4593-4645` has one `displacedSource` (`:5036-5040`); recovery hard-fails (`:5432-5434`); rebase outbox `record-rejected` (`:6402-6408`). f5b0 `design.md:395-398`, `:248-249` assume settleability. Reachable via P0-2's crash window or an author absent for two closes (cannot reopen at all).
- Amendment: define **stale-displaced** under the settlement profile: durable row above `settledThrough` with `epoch < currentEpoch − 1`, authenticated by the author's own signature + room-invariant blueprint schema (`v3-live.ts:5037`), never republished, disposition-only; recovery/outbox must not fail on it. Name `v3-live.ts` classification as an f5b0b owner.

### P1-2 — Published-but-unadmitted displaced rows are never surfaced, so no disposition is ever authored for the commonest displacement
- `v3-live.ts:6448` `if (crossSource === undefined && classified.row.publishState !== "pending") continue;` — frozen by the plan (`plan-v2.md:98815-98823`). f5b0 `design.md:273-275` "drained" never sees them → `settledThrough` stalls at that slot forever; op lost without a statement.
- Amendment: under the settlement profile `readRebaseOutbox` surfaces every row above `settledThrough` regardless of `publishState`; P0-2 evidence decides admitted vs lost. Explicitly reopen the frozen predicate in f5b0b/f5b0c.

### P1-3 — Owner list misses closure-law validators that will reject a settlement-profile closure with `TRUST_CLOSURE_INVALID`
- `node/src/internal/creator-transition-advance.ts:326-328` requires exactly one retirement, `:397-398` exactly one aggregate, in `stage` and `verify` (`creator-close.ts:995`, `creator-adoption.ts:359,1076,1413`, `creator-adoption-commit.ts:390`).
- `control-plane/src/creator-trust-checkpoint-advance.ts:198-207` demands proposed closure = `retained + trust + cut + qc` exactly; the new checkpoint must be normalized out as at `creator-transition-advance.ts:462-470`, with its own monotonicity pair checked in both modes.
- `verifyCreatorHistoricalIssuance` (`:225-260`) needs `retirement.length === 1`; settlement profile emits none (`f5b0 design.md:371-373`). `protocol-v2/src/registry.ts:460` profile registry unnamed.
- Amendment: add these owners with the rule: under `creator-trusted-settlement-v1` exactly one settlement checkpoint, zero retirement/aggregate, adjacent predecessor + per-author monotonicity in `verify`.

### P1-4 — Crash matrix omits "close intervenes between replacement admission and control issue"
- `design.md:466-491` "crash after some replacements → deduped" holds only within one epoch: room dedupe is in-memory per registration (`examples/v3-room/src/index.ts:1774`), empty after successor recovery (`plan-v2.md:98797-98803`). Add the row with P0-2's resolution.

### P2-1 — Checkpoint seam vs "write-before-sign" ordering
- `creator-close.ts:936-963`: cut/QC signed by `actor.close` **before** per-author records; aggregate bound to `commitQcRef`. State exactly: registry transition commits after `stageSnapshot()`/ACL diff and before `actor.close`; settlement checkpoint signed after the QC. Creator has everything else: `graph.vertices` (ops + deps), `graph.authors`, current ACL (`registration.exactCanonicalLatchedAclBytes`), successor ACL (`payload.acl`), prior checkpoint (`current.candidates`), anchor `stateDigest` (`creator-close.ts:882-897`, `v3-live.ts:7430-7460`).

### P2-2 — `pruneAuthenticatedSettledPrefix` is the first production prune integration
- No caller of `prunePublishedPrefix`/`inspectPruningState` outside tests. f5b0d must specify `readIssued` → `ISSUANCE_RECORD_PRUNED` vs `readCreatorReplayRows` (`v3-live.ts:4508`) and `republishRetained` for rollback-generation journals; define retention as "no row referenced by any retained (current+2) live journal".

### P2-3 — Durable replay seal and complete-map invariants are unlisted f5b0b owners
- `v3-live.ts:4453-4590` authenticates journal rows through the blueprint admission and checks `applicationVertices` sizes; must route settlement bodies to the settlement codec and use the complete map.

### P2-4 — `hasDisplacedOperation` requires unbounded identity retention in application state
- `design.md:437-441`. With P0-2 adopted, demote to a non-authoritative optimization or delete.

### P3 — notes
- Discriminator collision: `runtimeState.admission.discriminator` may not be `action` (`protocol-v3/src/index.ts:3067`); an app op with data property `action: "$drp.author-settlement.v1"` under another discriminator is rejected as a lookalike (`design.md:222-224`). Document as a reserved value.
- Terminal rule walked against real store APIs (`transactIssue`, `compareAndMarkOutboxPublished`, `readIssued`, `readOutboxPage`, `readLineage`): a single-lineage honest author loses no row except through P0-2/P1-1/P1-2 stalls; same-key multi-device substitution is terminal by design (`design.md:482`). The terminal rule itself is sound.
- Zero-intent waiver for a displaced `acl` op discards an authority intent; document manual re-issue.
- Permissionless rooms: writers must still be ACL members (`latched-acl.ts:334-336`, `:398-399`), so "frontiers = successor ACL members" covers every admissible author.

## Verdict

I would **not** authorize RED as-is. Two P0s: the f5b0p boundary/re-entry constraint is inverted against f5b0's advancement rules (one-line schema fix plus deleting the vacuous "above settled, ≤ admitted" class), and — fundamentally — the checkpoint plus closed grammar cannot account or decide slots admitted in a closed epoch above an unsettled gap, reachable through the design's own replacement→control publish window and the plan's named no-rebase trigger. Minimal amendments: (1) invert the invariant to `admittedThrough ≤ settledThrough` and bound re-entry by `settledThrough`; (2) extend the selected Merkle AVL dictionary with per-author admitted-beyond-prefix slot entries, add dictionary membership to the creator's accounting rule, and let the author decide dispositions from verified membership/nonmembership rather than the application presence query; (3) define the stale-displaced class and reopen the frozen `readRebaseOutbox` published-row predicate under the settlement profile; (4) add `creator-transition-advance.ts`, `creator-adoption*.ts`, control-plane normalization, `protocol-v2/src/registry.ts`, and the durable replay seal to the owner lists; (5) add the cross-close replacement/control crash row. With those five, the carrier, checkpoint, retired-key registry, terminal rule, and pruning contract are consistent with the code and I would authorize the tests-only RED.
