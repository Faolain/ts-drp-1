# D.110c-0c1f5b0b response-shape-corrected tests-only RED

Signed tests-only commit `9a4b35f4c29afc813ff1a24abe27a370be2278df`
removes only two stale `publishState` expectations from the public rebase
response. The diagnostic proved that both published settlement pages retain
their exact source sequence, digest, order, and application intents; the
response intentionally does not carry the store-private publication state.

The same diagnostic disproved the suspected legacy ordering mismatch. Legacy
`join` returns the intended sequence-one row first, but its intents are
incorrectly empty under the candidate GREEN patch. Its existing application-
visible intent assertion therefore remains unchanged and causally RED.

The post-correction combined RED selected 39 tests: 25 passed, 14 failed
causally, and 0 were skipped. The failing-title roster is identical to the
prior accepted RED. There were no missing imports/exports, setup failures, or
top-level errors. Production was restored exactly before the tests-only edit.

