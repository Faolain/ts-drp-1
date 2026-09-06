# D.110c-0c1f5b0d rejected GREEN review ledger

## Verdict union

- Grok 4.6/high: BLOCK, P0 1, P1 1, P2 1.
- Kimi K3/100: BLOCK, P0 0, P1 2, P2 4.
- Opus/xhigh: BLOCK, P0 2, P1 1, P2 6.
- Aggregate blocking union: three P0 and four P1 reports, collapsing to two
  causal defects plus one evidence consequence.

## Blocking disposition

1. The authenticated method is a post-hoc no-op replay of a caller-supplied
   legacy pruning receipt. It is not the deleting mutation; the global plan
   gate can run after rows are gone, and mixed-epoch pending/published pruning
   is test-only. Blocking owner: f5b0d corrective RED/GREEN.
2. `planClosedEpochCleanup(` appears only in a comment at the call site and the
   focused source-shape test accepts that comment. Neither the planner nor the
   runtime reclamation kernel has a genuine product caller. Blocking owner:
   f5b0d corrective RED/GREEN with a behavioral production-path test.
3. The GREEN evidence consequently overstates production reachability. The
   immutable packet remains rejected; a superseding GREEN packet must state
   the actual owner and results. Blocking owner: f5b0d evidence correction.

No f5b parent work is authorized from this review.

## P2 disposition

- Add an authenticated per-row ceiling (`row.epoch <= closedEpoch`) to the
  corrective matrix so a maintenance caller cannot delete current/future rows.
- Keep the same-realm maintenance registry within the trusted-runtime threat
  model for this correction, but state that the published maintenance subpath
  is an intentional capability surface rather than calling it package-private.
  The pre-planted `Symbol.for` hardening question remains a nonblocking
  maintenance-identity owner; it cannot substitute for exact-store tests.
- Preserve the legacy one-epoch scan cap for `creator-trusted-v1`; derive the
  three-generation settlement cap from the frozen active-plus-two-rollback law
  or authenticated watermark. Raising the legacy cap is not accepted as
  byte-for-byte compatibility.
- Add real-browser authenticated-prune refusal/success/replay coverage to the
  corrective retained gates.
- Distinguish permanent store corruption from retryable not-ready in the
  behavioral correction, using an existing fail-closed result if possible;
  do not silently add a public error contract.
- The inherited f5b0a 3/4 diagnostic and broad package-test-root typecheck
  errors remain with their recorded owners because none of the five GREEN paths
  can cause them; production build/typecheck configs remain required.

The corrective RED must fail through the real execution path, not through
another substring or comment predicate. If the accepted internal owners cannot
perform authenticated deletion after the frozen cleanup gates without a public
product API, schema, wire, authority, threshold, or dependency change, stop and
reslice instead of widening f5b0d.
