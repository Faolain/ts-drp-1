# Invalid clean fixture attempt — not causal RED

Signed/pushed tests-only commit: `bb2453d5cd9923b88cdfc5275105ff0c22f9b2ae`.
The isolated checkout was `/tmp/d110c-f5b0u-red-cPquzp/checkout`.
Offline frozen installation, fresh package builds, and the exact four-file
listing passed. One focused clean run completed: 67 tests, 20 passed,
47 failed, no pending tests. The complete reporter and command streams are
retained, without substituting this run for accepted causal RED.

All nine genuine-room tests failed while creating their source room, before
their intended fault injection, with `v3 room recovery failed: journal-rejected`.
Read-only source attribution identified the fixture's redundant eighth
parameters field, `authorShareMultiplier: 4`. The real live-journal contract
accepts exactly its seven historical keys; Node defaults an absent multiplier
to the same value 4. This fixture mismatch is not a product defect or f5b0u
causal failure. The parent authorized removing only the redundant fixture
field in a separately signed tests-only correction.

Other failures occur against the clean commit's inherited absent f5b0t
progress contract; no f5b0u causal acceptance is claimed. No overlay was
applied or run. Before/after evidence preserves all seven frozen production
hashes, the combined binary-patch hash, and all 27 stash identities.

The earlier invalid listing attempt remains independently preserved under
`../d110c-0c1f5b0u-red-a9ba60ab/`. Neither invalid attempt authorizes GREEN.
