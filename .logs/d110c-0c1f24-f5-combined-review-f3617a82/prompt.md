Perform the single combined governing high-risk review for ts-drp
D.110c-0c1f2/f4 and D.110c-0c1f5 at signed/pushed commit
`f3617a8284af6d149441f0531ddec520370a34fe` (tree
`96b8a0af82409bae4e4582469e9f82dc6c79b491`). Work read-only. Do not edit,
run tests/workloads, invoke agents/subagents, or inspect unrelated untracked
work. Return only one JSON object matching
`.logs/d110c-0c1f24-f5-combined-review-f3617a82/schema.json`.

This review has two linked decisions:

1. Decide whether the signed f2/f4 plan -> causal RED -> combined GREEN history
   is acceptable as a narrow implementation checkpoint. It must not be
   overclaimed as general rebase safety or complete repeated-room rollover.
2. Review the demonstrated f5 rebase-supersession and close-liveness blocker,
   identify the smallest exact safe construction (or the bounded missing design
   fact), and decide whether f5 is sufficiently specified to authorize its
   genuine-product-path tests-only RED. No f5 production edit is authorized by
   this review alone.

Immutable chronology:

- f2 plan/confirmation: `1502d4d81e1769a75bc3c416937b53e57dc3390b`;
- f2 causal RED: `c584b76bb7376fe2cbf4664dfdebacab8c153568`;
- corrected f4 causal RED and combined GREEN base:
  `fcd8735c8316b048166560ab904704102ce90705`;
- combined production GREEN:
  `9e1781e0966953d7adce8cf6b0a4d9e56d12299a`;
- isolated-checkout proof:
  `da3e75514e3921b71d57d611d9e2b61785124b07`;
- f5 close-liveness plan amendment:
  `f3617a8284af6d149441f0531ddec520370a34fe`.

Inspect at minimum:

- D.110c-0c1f2, f3, f4, f5, D.110c-c/d, the >=100-transition gate,
  and Phase 7 in
  `docs/production-hardening/production-hardening-tdd-plan-v2.md`;
- `.logs/d110c-0c1f2-red-f488f1f6/`;
- `.logs/d110c-0c1f4-red-causal-1033e22e/`;
- `.logs/d110c-0c1f24-green-working-fcd8735c/`;
- `.logs/d110c-0c1f24-clean-9e1781e0/proof.md`;
- `.logs/d110c-0c1f24-codex-precommit-review/result.md`;
- `.logs/d110c-0c1f5-source-audit-fcd8735c/audit.md`;
- `.logs/d110c-trajectory-fable51-high-oneoff-20260903/result.md` only as
  advisory input, never as approval;
- `packages/protocol-v3/src/creator-author-issuance-frontiers.ts`;
- `packages/node/src/creator-close.ts`;
- `packages/node/src/internal/creator-transition-advance.ts`;
- `packages/node/src/v3-live.ts`;
- `packages/node/src/creator-adoption.ts` and
  `packages/node/src/creator-adoption-activate.ts`;
- `examples/v3-room/src/index.ts`;
- focused f2/f4 protocol, Node, product, and retained compatibility tests.

For f2/f4, verify rather than assume:

- aggregate canonicality, byte ceiling, creator signature, genesis pin,
  object/current/successor identity, current/successor ACL digests, cut/QC,
  manifest, prior aggregate correlation, monotonicity, legacy-carrier equality,
  and O(1)-aggregate replacement;
- creator close derives and attests the exact successor writer set from the
  authenticated successor snapshot ACL before signing; the transition closure
  has no detached successor ACL candidate, so the removed transition-side
  rederivation check must not be treated as protection that exists;
- recovery validates exact configured pinned-genesis bootstrap bytes and all
  envelope facts, keeps slot zero outside covered-historical authority, and
  carries policy through the genuine same-room hot/cold custody paths;
- the two signed REDs failed causally and GREEN closes precisely those reasons;
- 41/41 focused tests, the exact two-title browser gate, 195/195 retained tests,
  affected builds/typechecks/lint/format/diff, and the isolated offline checkout
  are represented honestly and cover the claims made;
- a target-derived bootstrap-policy value in the cross-object displaced-source
  structure is currently unconsumed and is not silently claimed as a verified
  same-room source-policy path.

For f5, the demonstrated product paths are:

- rebase reissues displaced rows at fresh target author sequences and only then
  marks source rows published;
- the creator aggregate advances only an adjacent observed per-author prefix;
- numeric gaps can therefore leave a frontier permanently at S while admitted
  replacements and later writes appear above S;
- a null or absent prior boundary with first observed sequence >1 throws and
  aborts the whole creator close; sequences at/below a numeric boundary and
  duplicate author/sequence slots also throw; the accepted offending vertex
  remains in the graph, so unchanged retries recur;
- ingress does not enforce a complete per-author prefix before admitting those
  signed rows.

The required close-liveness invariant is: a foreign author's anomaly may leave
that author's frontier unchanged or produce an authenticated per-author
refusal/disposition, but cannot authenticate the anomalous row, cross a gap, or
abort the creator's transition for all other valid authors.

First state the exact authority granted by
`authenticatedCoveredHistoricalOutboxRow()`. It currently yields a reissue
candidate that is subsequently subject to current ACL/admission, canonical
transformation, and displaced-operation identity deduplication; it does not
directly install application state. Decide what authenticated source settlement
or supersession fact is truly required for that consumer and for later cold
reopen. Do not choose a heavier proof merely to satisfy a stronger unstated
threat model.

Compare the four families frozen in f5:

1. creator-authenticated per-source-to-replacement/disposition commitments;
2. a bounded settled-prefix construction;
3. a compact range/Merkle accumulator with membership/consistency proofs;
4. a simpler construction from existing signed vertex identities,
   displaced-operation identity, close/history commitments, and the aggregate.

For any recommendation, state exactly:

- who authenticates each fact and from which pinned trust root;
- how creator close verifies it without trusting untrusted storage;
- how null, absent, numeric-gap, regression, duplicate, crash-before-reissue,
  crash-after-reissue-before-source-completion, replay, substitution,
  cross-author/object/epoch, and later restart behave;
- what the aggregate/control state retains and when it can be pruned;
- whether active/control proof size grows with authors, gaps, rebases, or epochs;
- whether it needs a carrier/wire/schema/API/dependency/authority/threshold or
  migration change;
- how the exact causal RED can use only the real product path and preserve a
  no-gap control.

Hard constraints:

- no bare observed maximum;
- no O(epoch) or hidden O(rebase) control log required for ordinary reopen;
- no tests-only private durable state as a substitute for the product seam;
- no production edit, long campaign, dependency, wire/API, threshold, memory,
  timing, workload, archive, or Phase-7 change in this checkpoint;
- preserve immutable completed evidence and all current golden-path blockers;
- no Fable or collaboration subagents.

Only P0/P1 findings block. A finding must identify an executable semantic,
security, causal-evidence, compatibility, or golden-path defect with exact
evidence and a bounded required action. P2 gets a concrete disposition but does
not trigger recursive prose review. `f24_checkpoint_acceptable` may be true even
when f5 still blocks parent closure. Set `f5_red_authorized=true` only if the
current plan plus your exact selected construction defines deterministic causal
RED without first requiring a new high-risk prerequisite. If the construction
requires wire/schema/API/dependency/new-authority/migration work, identify the
prerequisite and keep f5 RED unauthorized.
