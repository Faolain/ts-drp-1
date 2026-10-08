# Deterministic source audit

The audit used bounded `rg` and `sed` reads; it did not run tests or edit
production.

- `examples/v3-room/src/index.ts` owns `lifetimeTransitionTail` and
  `enqueueLifetimeTransition`; current `rebasePromise` is a separately created
  promise, while migration rehearsal and activation execute on the lifetime
  tail and await `rebasePromise`. This proves a nested recovery enqueue would
  create the Opus cycle and that enqueueing the whole startup body once removes
  it.
- Public issue and session close already await `rebasePromise`, so that single
  queued startup body remains their barrier without another queue insertion.
- The existing hot-adoption path rebinds creator-close and stops
  `predecessorClose` on both success and terminal rebind failure, providing the
  exact private precedent required by f5b0u.
- The room already owns the recovered-vertex `commit()` path and fresh
  `createOperationAdmissionPolicy` construction seams.
- `packages/node/src/v3-live.ts` pins `applicationBatch`, exact outer/nested/
  entry key sets, version 1, 2..16 entries, safe strictly increasing logical
  times, and canonical limits `{maxBytes: 65_536, maxDepth: 8, maxItems:
1_024}`.
- The uncommitted rejected GREEN's
  `settlementReplacementLastLogicalTime` field-name heuristic remains the
  causal RED target; this audit does not treat it as accepted implementation.

The corrected plan matches these seams and retains the hot-adopted declaration
custody stop rule.
