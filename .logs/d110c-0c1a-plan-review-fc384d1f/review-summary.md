# D.110c-0c1a plan review summary

Reviewed signed/pushed commit:
`fc384d1fe3d503bb9e3706e97bf62bea39fe8a7c`, tree
`96b29a8f366b2c7ec3243c2fa5627610b28acd5e`.

- Grok 4.6/high initial run: `NO_VERDICT`, cancelled after 720.291 seconds and
  24 turns without a terminal object. Exact session
  `01a0649a-9cee-7dd1-8241-41f673464078` was resumed once. Resume exited 0 and
  returned `CHANGES_REQUIRED`: one P1 and three P2 findings.
- Kimi K3, 100-step cap: exited 0 and returned `CHANGES_REQUIRED`: two P1 and
  four P2 findings. The terminal payload used Kimi's own expanded JSON shape
  rather than the shared schema; it is retained verbatim and is not represented
  as an approval.
- Opus xhigh: exited 0, schema-valid terminal payload, `CHANGES_REQUIRED`: two
  P0, two P1, and five P2 findings.

Blocking union:

1. Pending rows made the original published-only mint rule contradict close
   liveness.
2. A row pending at its own close could never later meet a current-epoch graph
   predicate, permanently pinning the boundary.
3. Empty and exhausted lineage arithmetic produced `-1` or an unbounded
   `Number.MAX_SAFE_INTEGER` range.
4. The unnormalized AHE closure delta conflicts with the existing exact
   control-plane predicates.

Prospective correction:

- The signed frontier authenticates dense historical admission in the genuine
  close graph and sealed replay, independent of publication/prune state.
- Pending admitted rows do not block close and remain visible to later rebase;
  they are not called published or prune-eligible.
- The graph/replay set bounds derivation; lineage is a consistency upper bound,
  exhausted lineage refuses without traversal, and 0→1 requires genuine
  sequence 0.
- The Node-private transition wrapper verifies and strips exactly the permitted
  epoch-0 add or N≥1 one-for-one replacement before invoking the unchanged
  control-plane predicates in stage and verify modes.

The correction is material, so one confirmation round is required before RED.
Raw reviewer outputs remain authoritative.
