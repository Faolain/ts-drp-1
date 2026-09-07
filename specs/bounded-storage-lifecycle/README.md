# Bounded storage lifecycle

## Next Agent Prompt

Status: versioned ownership (1a-0), bounded retention (1a-1), and fixture
content delivery (1b-0) are accepted, 2026-09-07. The
[review ledger](review.md) owns qualified verdicts, root dispositions and exact
evidence. Earlier failed or ineligible attempts remain preserved. Frozen
contract checkpoints retain their original framing; this handoff owns live
execution status. Producer/recipient integration and long-running boundedness
remain unaccepted.

The accepted seams form one dependency-complete checkpoint; the
[commit-boundary audit](review.md#accepted-foundations-checkpoint) separates them
from unrelated memory diagnostics and native product experiments still in the
shared worktree. Next draft and independently review the producer-only contract for
verification → retention → pre-sign authoritative dependence in
[creator close](../../packages/node/src/creator-close.ts). The existing scope
retention capability is the owner; no new storage API is needed. Retention must
finish before the close actor records cut evidence or obtains successor votes,
not merely before a later head swap. Define refusal and uncertain-completion
retry controls before separate RED and GREEN. Do not add promotion to shared
adoption/recovery verification as part of this producer seam.

Keep recipient pinning, pending/rollback dependency protection, reclamation,
legacy classification and declaration-free recovery separately reviewed. The
[parent retention obligation](slices/01-recovery-snapshot-retention.md) and
[native integration RED](evidence.md) remain open. Producer pinning alone cannot
establish full slice-1 or endurance acceptance.

Preserve all accepted frozen oracles, including the corrective content-delivery
cases. Only a separate RED author may correct a proven oracle gap, retaining
old reports and creating new custody; GREEN must not edit those tests. The
content selector now counts every row in the exact object/epoch prefix, excludes
neighboring epochs, and returns decoder-owned identity. Native destination
verification and the delivery-before-floor boundary remain intact.

Use the durable named strict projects. Broader package compiler diagnostics are
unchanged failures, not green claims; the ledger distinguishes current fixture
gates from historical native runs. Preserve the earlier grid64 timeout and all
unchanged workload/memory thresholds. Obtain Grok, Kimi (100-step cap), and Opus
xhigh contract/RED/GREEN reviews at meaningful checkpoints with terminal evidence
and explicit dispositions.

The user authorizes production-sensible implementation for thousands of epochs;
MMORPG, Discord, and short FPS/chess sessions remain the north star. Continue the
[full production-hardening plan](../../docs/production-hardening/production-hardening-tdd-plan-v2.md),
not a smaller replacement objective. Do not introduce arbitrary historical
deletion, weaken rollback or expand budgets. Update this handoff before ending
your pass.

- [x] Versioned owner and stale-client fence (slice 1a-0).
- [x] Bounded atomic retention (slice 1a-1).
- [x] Fixture snapshot content delivery (slice 1b-0).
- [ ] Producer/recipient retention and native integration for ready v2 stores (remaining slice 1 seams).
- [ ] Declaration discovery from authenticated recovery identity (slice 2).
- [ ] Protected-dependency planner and durable retirement protocol (slices 3–4).
- [ ] Authenticated legacy classification after discovery/planning/fencing (remaining slice 1 migration obligation).
- [ ] Journal and signing retirement with stale-writer fences (slices 5–6).
- [ ] Unified cleanup, admission budgets, bounded recovery work (slices 7–8).
- [ ] Shipped product profile and fixed-state endurance (slices 9–10).
- [ ] Short-session identity retirement and Discord archive path (slices 11–12).
- [ ] Full golden-path and release-device acceptance (slice 13).

Only the next reviewed contract may become executable below. Reslice later high-risk
contracts before GREEN; the roadmap is not permission to combine them into one
patch. Preserve the [native lifecycle investigation](../grid-memory-production/lifecycle-audit.md)
and existing diagnostic artifacts as historical evidence. Production storage
and memory boundedness remain unaccepted.

## Outcome and limits

For bounded admitted live state, active rooms, members and in-flight work,
protocol overhead and hot recovery state must not grow with room age. Thousands
of successful epochs must remain possible without database resets or larger
heaps. The product must backpressure new work before exhausting finite storage;
it cannot promise unlimited admission during indefinite failed maintenance.

| Golden path                | What remains bounded                                                                                    | What must remain correct                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| MMORPG / persistent grid   | Live state, protected recovery window, protocol history, signing work, temporary transfers and hot heap | Genuine transitions, all admitted writers, offline/rebase work, crash recovery and next issuance                        |
| Discord / persistent chat  | Hot window, edit overlay, archive index working set, page cache and protocol overhead                   | Intentional archive growth is accounted separately; old messages, edits and tombstones remain verifiable through paging |
| Short FPS / chess sessions | Concurrent/recent sessions, runtime handles, local recovery and identity bookkeeping                    | Terminal sessions cannot be resurrected by delayed callbacks, packets or stale signing requests                         |

Logical retained bytes and browser physical allocation are different claims.
Deleting IndexedDB records need not shrink files immediately. Keep native
logical census, quota accounting, renderer heap and process RSS separate.
Whole-origin rollback is not prevented by a floor stored in that same origin;
retain the existing host freshness/custody threat model and fail-closed loss
semantics.

## One owner per decision

The node's existing authenticated closed-epoch cleanup planner evolves into
the sole recovery/retirement decision owner. Do not add an independent sweeper
that treats local epoch age, TTL, head observation or `adopted: true` as proof
that dependencies may be deleted. Storage adapters own atomic enforcement,
not protocol eligibility. Reuse the existing settlement-derived issuance
boundary and monotonic sequence high-watermarks.

The snapshot storage implementation owns snapshot bytes and their lifecycle.
Temporary transfer verification and durable recovery ownership are different
roles: verification alone does not pin a snapshot forever. The intended shape
is promotion of verified content within that owner, with declaration and exact
bytes discoverable together; avoid a second payload copy in AHE by default.
AHE owns authenticated references, not a competing snapshot-payload cache.
Before adopting this choice in GREEN, prove the promotion/sweep transaction
boundary and exact identity binding. If that cannot be made sound, reslice and
compare moving the payload into the authenticated generation closure.

The source trace behind this choice lives in
[creator close](../../packages/node/src/creator-close.ts),
[creator adoption](../../packages/node/src/creator-adoption.ts), and the
[snapshot storage contract](../../packages/storage/src/snapshot-transfer.ts).
The successor projection currently records digests while cold recovery reads
payload bytes from quarantine. TTL cannot be the lifetime of an authoritative
recovery dependency.

There must be one bounded durable retirement checkpoint and resumable intent,
not an eternal job per epoch. Independent databases require ordered,
idempotent steps; no cross-database atomic transaction is assumed. Install
store-local monotonic write fences before deletion. Old writers, restored
requests, imports and late acknowledgments must not recreate retired data.

Transitional ownership APIs must name their removal condition. Consumers move
to the shared snapshot owner in slices 1–2; duplicate recovery lookup and
independent cleanup policy disappear when their consumers migrate in slice 7.
Do not carry two authorities into the end state for compatibility with
unshipped scaffolding.

## Migration depends on authenticated selection

Legacy classification cannot be a backend-only unblock switch. The accepted
owner conservatively holds inherited rows while descriptors and recovery roles
are unknown. The [room opener](../../examples/v3-room/src/index.ts) has trusted
current/pending room-head expectations, but still requires a supplied successor
snapshot declaration; the [recovery owner](../../packages/node/src/creator-adoption.ts)
authenticates that declaration against the cut rather than discovering it.
The existing [cleanup planner](../../packages/node/src/internal/closed-epoch-cleanup.ts)
protects AHE lineage but does not yet establish every current, pending and rollback
snapshot dependency. A maintenance binding is plumbing, not that missing authority.

Therefore minimal authenticated declaration discovery and complete protected-set
planning must precede classification that clears the migration barrier or makes
legacy bytes collectible. Its application also needs the cross-store decision
fences from the retirement protocol. Keep those responsibilities with the existing
node policy owner and transactional adapters. Neither successful byte verification
nor absence from one caller's declaration proves that other legacy data is disposable.
Unknown or over-budget debt remains held; partial progress cannot become a caller
"done" flag, and an unsafe migration cannot evict dependencies to fit the pool.

The next fresh-store consumer seam may use ready v2 retention independently.
It cannot claim migrated-room support or full slice-1 acceptance. Reslice the
legacy-classification mechanism after slices 2–4 establish its authority and
fencing; this changes dependency order, not the required migration outcome.
No classification API or production mutation is authorized by this roadmap.

## Invariants and budget obligations

The protected set contains the current authenticated head, two genuinely usable
rollback generations, and bounded pending-adoption dependencies. Protect exact
declarations, chunks, authority artifacts, journal suffixes and issuance
dependencies—not merely generation IDs. Shared bytes remain while any protected
head needs them. Rollback never lowers retirement or signing safety floors.

Every bound has both cardinality and byte accounting where payload size varies:

`retained <= recovery closures + snapshots + journal window + unsettled issuance + signing window + temporary work + bounded metadata`

Existing protocol limits should supply bounds where applicable. Missing limits
must be explicit, reviewed policy before acceptance runs, not constants chosen
after seeing measurements. A finite epoch window does not bound stalled rounds,
author/incarnation churn, giant epochs or unlimited pending work. Reservations
must occur before irreversible acknowledgments or signatures and leave room to
finish recovery/maintenance. Bound queues and scan batches as well as durable
output; an API that pages after loading all historical rows is not bounded work.

Promotion must precede durable authoritative dependence. Interrupted work may
retain extra bytes only within a finite staging budget. Reclamation requires
the authenticated protected set and may refuse rather than destroy required
state. Admission stops if maintenance cannot drain that bounded backlog.

## Slice graph

| Slice | One question / seam                                                                                            | Depends on                                              | Decisive artifact                                                                                                            |
| ----- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 1     | Can verified recovery ownership survive transfer expiry? Snapshot lifecycle contract and adoption ordering     | Existing successor fixture; legacy completion after 2–4 | [Native cold-reopen RED/GREEN](slices/01-recovery-snapshot-retention.md), then adapter ownership controls                    |
| 2     | Can a fresh caller discover the exact snapshot declaration from authenticated recovery identity?               | 1a-1 owner seam                                         | No test-held declaration; current, pending and rollback reopen controls                                                      |
| 3     | Can the existing cleanup planner derive a complete bounded protected dependency set?                           | 1a-1, 2                                                 | Deterministic current/rollback/pending/shared-dependency oracle, stale-head and missing-byte refusals; no deletion           |
| 4     | Can one revision/incarnation-bound retirement intent survive every cross-store interruption?                   | 3                                                       | Prepare/commit/drain crash-state contract and transactional stale-writer fences, initially without bulk deletion             |
| 5     | Can obsolete journal scopes retire without losing replay/issuance dependencies? Journal maintenance capability | 4                                                       | Browser/Node exact census, replay equivalence, stale install/append/read-token controls                                      |
| 6     | Can detailed signing/evidence history retire without erasing safety memory? Durable signing transaction floor  | 4                                                       | Delayed sign/restore/round-change/dispatch/ack and restart controls after physical deletion                                  |
| 7     | Can all owners consume one retirement decision? Existing AHE/issuance and snapshot release integration         | 5–6                                                     | Genuine same-room transitions, current plus both rollback recovery, bounded crash-replay progress                            |
| 8     | Can stalled work remain within admitted budgets? Reservations, bounded scans and maintenance scheduling        | 7                                                       | Quota, suspension, stalled settlement/rounds, transfer churn and bounded recovery working-set controls                       |
| 9     | Does the shipped invite/open path select supported bounded behavior? Profile compatibility seam                | 8                                                       | Real grid create/join/issue/seal/adopt/reopen without fixture-only profile override; legacy semantics preserved              |
| 10    | Does fixed-state storage saturate under genuine long-running work?                                             | 9                                                       | Reviewed thousand-epoch freeze and unchanged 64-writer acceptance with exact contribution/state accounting                   |
| 11    | Can terminal sessions release local state without an unbounded tombstone catalog? Session/custody contract     | 4, 8–9                                                  | Repeated distinct FPS/chess sessions plus delayed old requests and restart negatives                                         |
| 12    | Can growing chat history leave the hot working set? Genuine archive producer and verified paging               | 7–9; Phase 7 prerequisites                              | Reslice archive-root evolution, segment availability, bounded index/cache, and million-message cold-join evidence separately |
| 13    | Do all supported product and device claims have exact-release evidence?                                        | 10–12                                                   | Requirement-by-requirement acceptance, real Safari/macOS, iOS Safari and Android Chrome; final review ledger                 |

## Research and alternatives

The relevant external principle is to secure snapshot recovery state before
discarding history. Raft's snapshot discussion illustrates durable snapshot
metadata and log-prefix replacement; it is an analogy, not a replacement for
this project's authenticated Byzantine/settlement rules.
See [Raft, section 7](https://raft.github.io/raft.pdf).

Remaining fog is intentionally named: safe signing-round compaction versus
finite-round admission; snapshot promotion versus AHE payload ownership;
legacy-profile transition versus explicit bounded-mode support; session
namespace retirement without infinite tombstones; and archive-root evolution
under the existing close contract. Resolve each through a focused reviewed
contract, not by silently weakening availability, signing safety or history.

## Verification discipline

Keep independent RED and GREEN authors. Freeze failures, source hashes and
commands before GREEN. Record typecheck, lint/format, affected tests, requested
review findings/dispositions and terminal process status at each phase.
Pre-existing failures remain failures with attribution, never green claims.
The native snapshot characterization is not proof of all production open paths.

No visual UI is required for core persistence work. If a slice produces a
visual artifact, run unprimed screenshot-critique as its final acceptance check;
use compare-screenshots for any prior/target shot and preview-shots for user
inspection. Visual feedback is non-blocking; correctness gates are not.
