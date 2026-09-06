# D.110c-0c1f5b0b final compatibility GREEN

Signed production commit `802a647ea412df7dcfe6284f2b62bfd66554ae23`
adds the final two-hunk compatibility correction to the earlier corrective
GREEN `e07f8a94d5e2449289bebd7aa89f1dcdbd4d9536`.

The correction preserves the profile-gated ingress, recovery, sink and fold
behavior already accepted for legacy rooms, while restoring the narrower
pre-f5b0b rebase contract: all legacy reserved rebase actions have empty
intents and remain immediately retireable. It also keeps terminal ambiguity
precedence and settlement `ISSUANCE_OUTCOME_UNKNOWN` fail-closed, while legacy
nonterminal ambiguity falls through to the exact parent signer-resolved
`admission-rejected` classification.

The final focused compatibility gate passed 27/27. Canonical Phase-3g passed
14/14; the expanded original/corrective focused set now contains 40 tests and
passed 40/40; retained passed 87/87; legacy consumers passed 26/26; rebuilt
shared consumers passed 64/64. A fresh detached checkout passed focused 27/27,
expanded focused 40/40, and the built-child title 1/1.

This evidence preserves the rejected review and RED provenance without
rewriting it: rejected review commit `fa4ee8f3`, compatibility tests-only RED
`a19e8454`, RED evidence `eb302c07`, prior corrective production `e07f8a94`,
and prior corrective evidence `bb94a03f`.
