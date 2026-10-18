Perform the single governing high-risk plan/design review for
D.110c-0c1f5b0 at signed and pushed commit
`fc4b8fc78148e5211b09dc32e3f27f32756653ec`. Work read-only. Do not edit,
run workloads, invoke another reviewer, or spawn subagents. Return exactly one
JSON object matching the supplied schema.

This checkpoint selects an explicit author-settlement construction before any
RED or production edit. Inspect:

- `.logs/d110c-0c1f5b0-design-00a860ab/design.md` completely;
- `.logs/d110c-0c1f5b0-design-00a860ab/audit.md` and `manifest.sha256`;
- `docs/production-hardening/production-hardening-tdd-plan-v2.md`, especially
  D.110c-0c1f5a, D.110c-0c1f5b0 and D.110c-0c1f5b;
- diff `00a860ab3c2ed64b236713fc63b7ae2b073f9f27..fc4b8fc78148e5211b09dc32e3f27f32756653ec`;
- `packages/protocol-v3/src/index.ts`,
  `creator-author-issuance-frontiers.ts`, `latched-acl.ts`, and registry v1;
- `packages/node/src/creator-close.ts`, `v3-live.ts`,
  `internal/creator-transition-advance.ts`, and
  `internal/closed-epoch-cleanup.ts`;
- `packages/issuance-store/src/types.ts` and its browser implementation; and
- `examples/v3-room/src/index.ts` around `drainRebaseOutbox()` and the public
  application/session contracts.

The concrete defect is that an author sequence is never reset, while a
displaced old vertex is reissued at a later sequence. Creator close sees only
current graph `(author, sequence)` slots. It lacks an authenticated fact binding
the missing old slot to its exact replacement or terminal outcome, so the
adjacent admitted frontier can remain permanently below an honest gap. An
honest out-of-order delivery (`n+1` admitted before old-anchor `n`) has the same
shape. F5a already proved that a foreign anomaly may stop only that author's
frontier, not the whole room close; do not propose reopening that result.

Selected construction:

1. `$drp.author-settlement.v1` is a protocol-reserved operation inside the
   existing ordinary signed v3 vertex. The complete normal vertex preimage is
   the sole author signature under `ts-drp/vertex/v3`. The exact statement
   binds old source identity, every application intent, operation/semantic
   digests, a closed outcome, and ordered current replacements; or it carries a
   compact author baseline tied exactly to the control vertex's monotonic
   issuance ordinal.
2. Protocol/Node accepts the control body only in authenticated settlement mode
   after normal signature, ACL, dependency and existing resource checks. It
   enters the causality index, close set, history, issuance outbox and live
   journal, but never blueprint admission/reduction, ACL staging, application
   reservation/state or application callbacks.
3. The room owns application policy and a new deterministic
   `hasDisplacedOperation()` query over the authenticated snapshot-base
   projection. Node owns one `settleRebaseSources()` transaction. Replacement
   publication precedes control durability/publication, which precedes source
   completion. Restart enumerates durable truth before retry.
4. The creator signs one new
   `drp-creator-author-settlement-state` closure record with per-successor-ACL-
   member `settledThrough` values and exact close/QC/snapshot/history/predecessor
   bindings. It advances an author only through exact graph slots, same-author
   dispositions or a valid baseline; a foreign ambiguity stops only that
   author.
5. The new recovery capability terminalizes every row at/below the settled
   prefix regardless of digest. Such rows never reapply or rebase, so a
   substituted old row cannot gain authority. Rows above remain displaced.
6. Upgrade is explicit via `authorSettlementVersion?: 1`. V1 behavior is
   unchanged without opt-in. The first opt-in close names the v1 aggregate (or
   genesis sentinel) as predecessor, emits only the new checkpoint, and enables
   settlement operations in its successor. New-mode downgrade/missing/mixed
   state rejects. Old binaries reject the successor rather than continuing.
7. Completed receipts leave active custody after the existing adoption,
   rollback and availability prune gates. Active state is one ≤64-entry
   checkpoint, fixed rollback generations, compact history peaks and the
   current epoch's already-bounded vertices; no completed-epoch or completed-
   rebase chain is retained.
8. Implementation is split by owner: protocol codecs/compatibility (f5b0a),
   Node admission/durable transaction (f5b0b), room policy/orchestration
   (f5b0c), then creator/recovery/pruning integration (f5b). Every slice gets a
   genuine tests-only RED, bounded GREEN and signed evidence. Final f5b review
   covers the entire history.

Review the exact plan, not a nearby preferred architecture. Decide whether this
construction is safe and sufficiently exact to authorize f5b0a RED. Check in
particular:

1. Whether an author signature is adequate authority to abandon or replace
   only that author's historical operations, including `already-present`,
   `expire`, rebase/transform, an older settlement control, genesis gaps and
   same-key membership re-entry.
2. Whether requiring source/replacement sequences below the control ordinal,
   current exact replacement vertices as strict causal ancestors, and exact
   source uniqueness prevents replay, substitution, equivocation, partial and
   reordered settlement.
3. Whether the author-baseline rule preserves never-resetting issuance and
   fails closed when the original store is lost, rather than becoming a compact
   unproved maximum.
4. Whether a v1 dense admitted prefix may safely seed a new terminal settled
   prefix, and whether the proposed closure-kind/opt-in barrier truly makes old,
   mixed and downgraded peers fail closed.
5. Whether bypassing blueprint admission/reduction for a reserved operation
   while retaining normal vertex/ACL/dependency/capacity/history processing is
   coherent with the current registry and Node graph owners, without allowing a
   control body to affect application state.
6. Whether the exact durability order and restart/idempotence rules prevent
   source completion without a recoverable control statement and avoid duplicate
   replacements or receipts after ambiguous outcomes.
7. Whether the creator can deterministically derive a settled prefix from the
   current graph and accepted statements while preserving f5a close liveness,
   and whether terminal recovery below that prefix is safe for arbitrary
   same-slot bytes.
8. Whether state/census growth is age-independent and the design avoids hiding
   an O(epoch), O(rebase) or unbounded O(gap) proof log in application, archive,
   bootstrap, registration or ordinary cold-reopen custody.
9. Whether the new public opt-in and projection query are the minimum honest
   compatibility/API boundary and the four TDD slices have one owner and causal
   acceptance each.
10. Whether any promised outcome is unimplementable from the named current
    source seams or silently requires a wire field, new crypto, external
    authority, threshold change, application trust expansion or unavailable
    historical proof.

Only P0/P1 findings block. P2 findings must state a concrete owner and required
disposition but do not demand recursive review unless their correction changes
authority, executable scope or causal acceptance. Set `verdict` to
`CHANGES_REQUIRED` iff at least one P0/P1 exists. Set `red_authorized` true only
if the f5b0a protocol-codec/compatibility RED may begin exactly as sliced after
this review. Do not authorize production GREEN or any retained campaign.
