# Slice 1b-1 — Producer retention before close dependence

Status: accepted contract; separate RED authoring authorized, GREEN not authorized.
The [review ledger](../review.md) owns verdict qualifications and dispositions.
The accepted foundations
are committed at `7d0c2f66`. This is one consumer-ordering seam within the
[parent retention obligation](01-recovery-snapshot-retention.md), not full
producer/recipient integration or production boundedness acceptance.

## Contract and owner

Before a live creator close records a cut, obtains a successor prepare/commit
vote, or publishes pending successor dependence, the exact snapshot
declaration and content used by that close must have completed durable recovery
retention. Temporary verification is insufficient. A refused or uncertain
retention call must stop that close attempt before those effects.

The seam is `persistSnapshot` in
[creator close](../../../packages/node/src/creator-close.ts). It already encodes
the producer snapshot, opens its exact scope, verifies the stream and completes
the receipt. It must await that same scope's existing `retainForRecovery()`
before returning the snapshot to its caller. The caller's cached
`persistedSnapshot` then means verified **and retained**, not merely uploaded.
Scope release remains in `finally` and must not cancel retained content.

The [snapshot owner](../../../packages/storage/src/snapshot-transfer.ts) owns
atomic promotion, exact identity and finite capacity. Creator close owns when
the protocol first depends on it. Do not add a wrapper owner, second payload
copy, new public retention API, TTL extension or cleanup exception. Do not
promote inside the shared adoption/recovery verifier: reading recovery bytes
must not create new retention authority. This single-owner split follows the
refactor-clean audit of this contract.

The earliest close-specific durable boundary is the seal actor's cut evidence
write, before successor votes, in
[the creator seal actor](../../../packages/seal/src/creator.ts). The chosen seam
also precedes durable replay sealing. Actor/store initialization can legitimately
write before `close()`; the oracle must distinguish those writes from new cut,
vote, pending generation and trust/head effects. External room-floor publication
is owned by the room consumer, not this close handle. The focused suite proves
that no successful close result/adoption facts escape before retention; it must
not invent an unused floor counter. The parent's native room integration still
owns the external-floor and adopted-successor proof.

## Refusal, retry and uncertainty

Retention errors propagate through the existing close rejection path. Preserve
the error/cause where the owner supplies one; do not report close success or
invent a compensating adoption. The local staged snapshot may already have
sealed the live lifecycle. This contract does not promise that a failed close
restores active authoring.

A retry on the same live close binding must use the captured graph and staged
snapshot identity. If retention failed before commit, no durable recovery charge
for that scope may be reported. If retention committed but acknowledgement was
lost, a retry must reuse that exact recovery-owned scope without duplicate
scope/content charges. Neither outcome permits cancelling possibly owned data.
The storage owner remains responsible for atomic and idempotent enforcement;
the producer test proves that the real caller actually uses it.

Retry re-verifies the reopened, populated scope without rewriting chunks. The
[stream verifier](../../../packages/compaction/src/snapshot-stream.ts) reads
quarantine first and only fetches/writes a missing chunk. A new receipt may then
complete an already-verified matching scope before idempotent retention. Pin
this with a precondition control for both temporary-verified and recovery-owned
scopes on both adapters: successful real re-verification/completion, zero source
fetches, no quarantine writes, exact identity and single charging. The
[feasibility probe](../../../.logs/bounded-storage-lifecycle/producer-presign-contract-01/retry-probe.stdout.json)
establishes that this is possible today, but is not the producer RED oracle.
Keep verified-scope immutability guards intact. Do not add a status-only trust
shortcut or cache success before retention based on a mistaken assumption that
re-verification always writes. A failure after successful `persistSnapshot`
return differs: its cache is already populated, so retry reuses that retained
result rather than repeating persistence.

A later pre-sign failure may leave the now-retained snapshot in the finite pool.
That is conservative recovery debt, not permission to delete it. Admission must
still refuse before any new close dependence when the pool is full. Reclamation
requires the later authenticated dependency planner and is outside this patch.
Do not enlarge defaults to make repeated closes pass.

Process death is distinct from retrying a live promise. A cold test must prove
committed retained bytes and accounting survive reopening; it must not claim to
resume an in-memory binding after death. Cross-process protocol-close resumption
remains governed by the existing seal/recovery contracts.

## Separate-author RED surface

All cases start from ready v2 owners, not legacy classification debt. Run cases
1–5 against both the real SQLite snapshot adapter in Node and the real browser
snapshot adapter under the repository's current fake-IndexedDB Vitest runtime.
The latter is consumer/runtime coverage, not native browser durability. Its
strict-retention success precondition must pass without spoofing the returned
transaction durability or relaxing the owner gate. The Node variant supplies
the real snapshot adapter through test-only fixture dependency injection; retain
genuine close, registration, receipt and seal semantics. Name adapter/runtime
in every result. Full native Chromium/Firefox/WebKit recovery acceptance remains
the parent's separately reviewed integration obligation.

Create a dedicated producer-close test fixture and test file. Reuse real close,
snapshot verification, storage and seal consumers, with decorators only for
observation, barriers and fault injection. The existing genuine adoption fixture
closes during setup, so interception must occur before that first close; wrapping
its already-produced result would not test this seam. Keep any fixture extraction
test-only, preserve existing consumers and avoid introducing a product hook.

Observe the real bound snapshot scope's completion, retention and release with
delegating decorators. Track handle identity, not merely an equal declaration.
Preserve the original backend `verificationQuarantine` object identity: its
receipt is consumed by that backend's `complete`. Even one stable substitute
quarantine wrapper would change receipt identity; the adoption-phase read
decorator is not a valid producer completion recipe. Observe backend operations
without replacing the receipt-bearing object or minting test capabilities.
The retention hold is before delegation to the real owner, outside its serialized
transaction queue; status reads must remain possible while held. Use a test-only
module spy around the actual exported `deriveCloseSetHistoryCommitment` to
observe the first step after `persistSnapshot` and inject the later failure. The
spy must delegate unchanged except for the one armed failure and must prove it
intercepts the module actually consumed by close. Observe replay sealing's
real journal reads through the existing journal decorator; source ordering and
the commitment spy jointly exclude replay work before the barrier. Do not
replace the registration resolver or forge a live-plane capability to inspect
private locals. If these seams cannot be instrumented without changing product
behavior, stop and reslice before freezing RED.

Use two explicit checkpoints in every case. Start observation after binding
and before `close()`. At entry to the decorated `openScope` call made by
`persistSnapshot`, capture the persistence-entry durable/operation baseline,
before delegating to the owner. Preserve and report the intervening staging
delta (AHE operations, journal reads, evidence puts, enrollment/vote calls and
close observations); do not erase it by resetting counters. A precondition
control must characterize genuine staging/fold/export and queued-work effects.
No cut, successor prepare/commit vote, actor-close invocation, successful close
result or successor publication is permitted anywhere in that earlier window.
Unknown authority effects fail the control rather than becoming allowed baseline
noise. In the persistence window, compare against the captured `openScope`-entry
baseline, never a later retention-entry baseline. Cold AHE assertions must account
for only that explicitly characterized staging delta; a newly observed successor
generation/head change can never be explained away as staging.

Freeze tests proving all of these before GREEN:

1. **Awaited ordering.** Hold retention on the same still-unreleased scope handle
   that completed verification inside `persistSnapshot`. While held, close is
   unsettled, exact verification is complete, and commitment derivation and
   replay sealing have not started. No new cut evidence, successor vote,
   pending/trust/head publication or successful close result has occurred.
   Use the two checkpoints above, preserving the pre-persistence observations.
   Release the barrier, then prove genuine close success and retained
   exact manifest/chunks, not just a call counter. Use an explicit entered barrier
   and bounded observation; absence of an event before setup is not a verdict.
   Explicitly reject close completion or authority effects before the entered
   barrier, so omission of retention cannot masquerade as a setup timeout.
   After success and release, advance beyond temporary TTL and sweep; exact
   retained content and its scope/content charge must survive.
2. **Finite refusal.** Fill the actual owner pool with distinct retained scopes.
   Close must reject with the real retention-capacity failure, with no new
   close-dependent authority effects. Prove unrelated retained content and its
   accounting remain exact. Fill with distinct object/epoch/anchor triples;
   a conflicting manifest for one triple is not a capacity test. A smaller
   explicit limit on the test-owned store is allowed; enlarging defaults is not.
   Starting with no scope for the refused close's triple, the refused attempt
   leaves exactly its own additional verified temporary scope, with unchanged
   recovery counters and filler content; ordinary TTL maintenance can collect
   that temporary residue. Do not require the whole database image to remain
   identical or misclassify that temporary residue as recovery debt. Do not
   simulate capacity only by throwing from a stub.
3. **Before-commit fault.** Reject a promotion before the real commit, prove no
   new owned charge or close effects, then retry the same binding after removing
   the fault and prove exact identity, successful close and single charging.
4. **Lost acknowledgement.** Let real retention commit, then reject its return.
   Prove no new cut/votes/head from that failed attempt; sweep past temporary TTL
   and show the exact snapshot remains. Retry the same binding successfully with
   unchanged retained identity and counters. This must fail if retention is
   omitted, unawaited, or moved after signing.
5. **Post-retention failure.** Fail the first commitment-derivation invocation
   after successful `persistSnapshot` return, before delegating to the actual
   compaction function. As a regression guard, prove the retained handle was
   released; the load-bearing assertions are that replay and
   the seal actor have not started, and conservative retained debt survives
   maintenance without compensation deletion. Remove the one-shot fault and
   retry the same binding. Its retained persistence result is cached: no new
   snapshot scope/completion/promotion is needed, while real derivation and
   close proceed with exact identity/accounting. Do not inject at signing or
   weaken close-conflict/ambiguous-signing behavior to force retry success.
6. **Native cold snapshot durability plus pre-kill ordering.** Run genuine close
   in a child with the real SQLite snapshot and AHE stores. This fixture's seal
   vote/evidence stores remain the real browser adapters under fake IndexedDB;
   they do not supply process-cold durability. Establish both checkpoints above
   and observe actual evidence-store writes, separately classified enrollment
   and successor vote
   calls, close observations and AHE mutations with delegating instrumentation.
   Immediately after the real snapshot retention commit, send a token-bound
   checkpoint with exact declaration, owner accounting and cumulative operation
   observations, then synchronously hold the child before the caller continues.
   The parent must reject any new cut/vote/publication already observed, including
   evidence that occurred before a wrongly delayed retention call. Race this
   checkpoint against explicit early close completion/effects, not just timeout.

   Terminate the owned child and confirm exit. Cold-reopen the exact SQLite
   snapshot/AHE files: assert exact manifest/chunks/recovery charge and no new
   AHE head/generation change after the persistence-entry baseline. That baseline
   must itself reconcile to the pre-close image through the recorded staging
   delta, counted once. Never infer cut/vote absence from head alone.
   Reuse the existing native-child birth/PGID check before termination, explicit
   exit/signal/timeout assertions and process-group survivor scan; a recycled PID
   or an unobserved orphan cannot satisfy the gate.
   Collect an unrelated expired temporary scope to
   prove sweep still works. Only identity/declaration, baseline and operation
   metadata may cross the boundary, not payload or a live store handle. Cut/vote
   absence comes from the pre-kill observed and held execution boundary, **not**
   from an empty reopened fake IndexedDB or AHE head alone. Test controls must
   show the instrumentation sees a genuine successful close's evidence/votes
   and rejects retention moved after evidence. This is not native seal-store
   durability or whole-process protocol recovery proof. Do not create a new
   production Node seal adapter here; full native-browser cold adoption remains
   mandatory in the parent integration gate.

Separate injected errors from real owner refusal in names and reports. A causal
baseline RED should fail on missing producer promotion/ordering, not on an
invented API, missing fixture, unrelated compiler debt or process setup failure.
Retain failing reports and exact source hashes. If fixture access requires a
broader production refactor, stop and reslice before editing production code.

## Verification and acceptance

Review this contract independently with Grok, Kimi (100-step cap) and Opus xhigh;
record terminal verdicts and root dispositions in the [ledger](../review.md).
Only then may a separate RED author materialize and freeze the tests. Review
that RED independently before a distinct GREEN author edits the producer. GREEN
must not alter frozen oracles to accommodate the implementation. Obtain the same
requested independent GREEN reviews and the scoped Codex second opinion.

Use a durable named strict TypeScript project for the new fixture/tests, wired
into the relevant package typecheck. Log focused types, lint/format and tests at
each phase. Record broader package diagnostics separately; unchanged failures
are not passes. Preserve existing snapshot owner/retention, receipt/quarantine,
creator close/adoption, issuance-retention and closed-epoch cleanup regressions.
Keep the accepted fixture content-delivery tests unchanged. Report native engine
coverage actually run; fake IndexedDB is not native browser durability evidence.

Before RED freeze, inventory existing regression consumers that close multiple
distinct epochs against one snapshot owner. The current default pool holds four
retained scopes; without the later planner, a fifth may correctly refuse. Record
that transitional blast radius explicitly rather than discovering it during
GREEN, enlarging capacity or silently removing an endurance test. Such a refusal
does not satisfy the full production-hardening goal. Preserve historical reports
and keep the later reclamation/endurance obligation open.

The runnable artifact is the focused producer suite and its cold-process report;
there is no visual/UI acceptance surface in this slice. Neither the earlier
grid64 timeout nor workload, heap, storage or rollback budgets may be relaxed.
Recipient pinning, pending/rollback dependency selection, legacy classification,
declaration discovery, safe reclamation and thousand-epoch endurance remain open.
Feedback that changes custody, rollback guarantees or data-loss policy requires
user direction; internal fixture organization does not.
