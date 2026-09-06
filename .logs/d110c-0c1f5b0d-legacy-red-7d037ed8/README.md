# D.110c-0c1f5b0d legacy-bound corrective RED

This evidence records the accepted reduced tests-only RED at signed and pushed
commit `7d037ed825a092cf985d1a271d3f56d965992ed3`, based on the signed and
pushed reslice `721d1c0e0675b16ca45ca61f4b264de67cbff5f6`.

Exactly one test file selected 19 tests. Eighteen passed and one failed. The
sole failure is
`D110C_0C1F5B0D_LEGACY_HISTORICAL_SCAN_EXCEEDS_ONE_EPOCH_WINDOW`: the exact
existing private `countHistoricalIssuanceRow` implementation accepts a new
8,193rd historical sequence after accepting 8,192 distinct sequences under a
real `maxEpochVertices` value of 8,192.

The test obtains the production function declaration through the TypeScript
AST, transpiles that exact declaration, and executes it against real `Set` and
count state. It does not copy the predicate, export a product seam, use a
substring as an acceptance oracle, or claim genuine recovery coverage.

The three invalidated source/comment assertions were removed. Parent f5b
integration still owns genuine repeated-close recovery and the authenticated
settlement invocation. The already-green 12-case corrective backend ceiling
suite remains byte-identical.
