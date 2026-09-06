# D.110c-0c1f5b0d legacy-bound GREEN

This packet records the narrow production correction at signed and pushed
commit `b384c7d9bdb3b3b3f5fa5b7de05cbafb3da7f4af`, based on tests-only RED
`7d037ed825a092cf985d1a271d3f56d965992ed3` and reslice
`721d1c0e0675b16ca45ca61f4b264de67cbff5f6`.

The sole production change restores `countHistoricalIssuanceRow` to one
`maxEpochVertices` window for `creator-trusted-v1`. The exact AST-selected
private implementation accepts 8,192 distinct sequences, ignores a duplicate
without incrementing, and refuses distinct sequence 8,193.

This does not implement or claim settlement-profile rollback-window behavior,
real product reachability, repeated close/adopt, or parent f5b integration.
No API, schema, wire, authority, dependency, threshold, or test file changed.

All focused, unchanged backend, real Chromium, retained, build, static and
corrected isolated-checkout gates passed. The package-wide Node typecheck
retains its accepted test-root/fixture baseline: its 13 normalized diagnostic
lines have the exact same SHA-256 as the earlier f5b0d GREEN baseline.

