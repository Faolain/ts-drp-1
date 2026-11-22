# Rejected fixture diagnostic

The first attempted focused load was rejected before it became RED evidence.
Its read-only source-shape extraction used an unescaped closing brace in a
Unicode regular expression and Vitest reported:

`Invalid regular expression: /function countHistoricalIssuanceRow[\\s\\S]*?\\n}/u: Lone quantifier brackets`

The diagnostic was corrected to escape the brace. Exact-file Prettier and
ESLint then passed, and the accepted focused run selected all 21 tests with no
top-level error. This regex mistake was a test diagnostic defect, not a product
failure, and is not counted in the causal matrix.
