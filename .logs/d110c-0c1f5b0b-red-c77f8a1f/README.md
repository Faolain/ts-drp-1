# D.110c-0c1f5b0b retained legacy-control RED correction

Signed tests-only commit `c77f8a1f6c7d5362be3ddeba7cb2fddcfc54cf04`
corrects the stale retained Phase-3g expectation for legacy
`creator-trusted-v1` `causalJoin` behavior. The fixture's exact original
application intent remains visible in the displaced-source response at author
sequence 1 with its authenticated source digest. Settlement-profile `join` and
`causalJoin` control-only expectations were not changed.

The bounded retained-file RED selected 14 tests: 13 passed and exactly the
corrected legacy `causalJoin` case failed. It failed at the response assertion
because current production returns an empty intent list; there were no missing
imports, missing exports, setup failures, skips, or top-level errors.

The separately selected Phase-3h oversized/irreducible multi-tip activation
case passed once under its unchanged 10-second limit in 6,369.727 ms. The prior
combined 87-test timeout is therefore classified as combined-run scheduling
variance, not a reproduced semantic failure. No timeout or expectation was
changed.
