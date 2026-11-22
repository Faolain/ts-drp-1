# Review-claim disposition

Opus correctly demonstrated the reachable P0 that ungated `join` and
`causalJoin` control classification changes creator-trusted-v1 sink delivery
and blueprint application projection/fold membership. The final RED reproduces
that legacy compatibility failure.

The narrower assertion that this also creates a separately reachable reserved
ABI bypass was not reproduced. Both independent public routes tested here fail
closed before `isControlOperation` can bypass `reserveOperation`:

- local wide-frontier generation rejects missing and altered causalJoin ABI;
- genuinely signed ingress against a catalog without causalJoin is rejected by
  authenticated extraction/catalog operation admission before journal/sink.

This is recorded as an evidence-backed narrowing, not a dismissal of the P0.
GREEN still must profile-gate join/causalJoin control-only behavior so legacy
sink and fold semantics match the parent commit.

