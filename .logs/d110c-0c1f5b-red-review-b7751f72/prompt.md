# D.110c-0c1f5b corrected parent RED review

Act as an independent read-only implementation reviewer. Inspect the repository
at signed, pushed HEAD `b7751f722336caf359c3a3db4abc0d9870ff9f3d` on
`codex/phase3a1b-p6-golden-path`. Do not edit files, run the focused test, or
trust this prompt's claims without checking the named sources and evidence.

Authoritative inputs, in order:

1. `docs/production-hardening/production-hardening-tdd-plan-v2.md`: current
   frontier plus records `D.110c-0c1f5b0r`, `D.110c-0c1k`, and
   `D.110c-0c1f5b`, including the signed case-24 clarification at `62f71f4d`.
2. `.logs/d110c-0c1f5b0r-design-3a156aca/design.md` and `pre-review.md`;
   verify their sibling manifest. This is the accepted design. Do not use the
   superseded f5b0/f5b0p/f5b0q grammar.
3. The tests-only history and current test:
   `0c59869a`, `3a9e9329`, `1dcff170`, `8fcbc039`, `cecde972`, and
   `tests/phase-6b-d110c-0c1f5b-integration-red.test.ts`.
4. Immutable RED evidence roots:
   `.logs/d110c-0c1f5b-red-3a9e9329/`,
   `.logs/d110c-0c1f5b-red-1dcff170/`,
   `.logs/d110c-0c1f5b-red-8fcbc039/`, and
   `.logs/d110c-0c1f5b-red-cecde972/`. Verify every manifest and distinguish
   the rejected 2/2 runs from the final accepted 1-failed/1-passed run.
5. The actual product seams used by the test, particularly all five
   hard-coded successor/checkpoint profile sites in
   `packages/protocol-v3/src/creator-close.ts` and
   `packages/protocol-v3/src/creator-checkpoint.ts`, room settlement/recovery
   in `examples/v3-room/src/index.ts`, Node source/frontier and pruning seams,
   creator activation ownership, issuance stores, and AHE recovery.

Review questions:

- Is the accepted RED genuinely causal through real issue, publication,
  ingress, close/QC/snapshot preparation, and the intended settlement profile
  codec mismatch—not a missing import/export, forged record, substituted
  checkpoint, fixture-only trust, or setup error?
- Does the tests-only continuation cover the parent-owned design matrix (cases
  1-27 where not already exactly owned by closed prerequisite tests), including
  authenticated open progress, partial progress, delayed/unpublished fence and
  replacement, displaced control behavior, manual-review hold, same-key/new
  incarnation, same-slot duplicate, positive authenticated pruning, ambiguous
  outcomes, monotonic stale-head recovery, and v1 compatibility?
- Is case 24 correctly reframed as genuine stale-local-head fail-closed
  recovery plus monotonic three-transition custody, with no committed-floor
  regression or invented rollback API? Is interrupted pre-floor adoption cited
  to its retained owner?
- Does case 25 correctly halt/deactivate the ambiguous owner, read exact
  row-and-link-or-neither durable truth, permit only the existing bounded
  authenticated owner recovery/retry, and prevent duplicate issue, link,
  disposition, publication, or application effect?
- Is the per-peer query-isolated `creator-adoption-activate` import a faithful
  model of independent physical clients while preserving production source,
  opaque capability identity, same-peer restart ownership, real bindings, and
  the singleton guard within each client? Flag any bypass or false-positive
  possibility.
- Does one genuine room have 64 ACL-authorized writers, with every writer
  issuing/admitting/applying/publishing a real operation in each epoch 0-3,
  rotating eight-writer offline cohorts spanning close/adopt plus selected
  restart, authentic rejoin, selected displaced pending/published work, exact
  per-author and aggregate accounting, ACL/authority/anchor/history/plan links,
  product state and semantic digest? Membership or fixture counters alone are
  insufficient. This bounded parent test is not the later >=100 campaign.
- Are the positive prune assertions attached to the real authenticated parent
  owner and availability/rollback gate, without invoking a test-only pruning
  capability or mistaking a receipt replay for the deleting mutation?
- Are all continuations bounded, deterministic, and reachable after GREEN;
  are test timeouts and closed store/page contracts realistic without changing
  product thresholds or semantics?
- Does the current source show the narrow GREEN can be implemented without a
  new public API, wire/schema/crypto/dependency/threshold change? Identify the
  exact minimal allowed production seams, including all five profile sites,
  settlement checkpoint composition, authenticated frontier threading,
  existing-input close rebind, and authenticated prune ownership. If a new API
  or authority carrier is actually required, make it P1 and explain why.
- Verify signatures/pushed identity, changed-path custody, exact test counts,
  raw reporter matrix, static/type evidence, manifests, and the honest status
  of the two rejected runs.

Severity policy: P0/P1 block GREEN. P2 must have an owner and disposition but
does not block. Return only one JSON object conforming to the requested schema.
Set `green_ready` true only if the P0/P1 union is empty.
