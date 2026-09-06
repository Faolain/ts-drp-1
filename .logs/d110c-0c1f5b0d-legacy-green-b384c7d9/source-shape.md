# Source and owner validation

- The AST-executed focused test finds exactly one top-level function declaration
  named `countHistoricalIssuanceRow` in `packages/node/src/v3-live.ts`.
- The exact emitted function accepts 8,192 distinct rows, accepts duplicate
  8,191 without increment, and rejects distinct 8,192 (the 8,193rd row).
- The changed production commit contains one path only:
  `packages/node/src/v3-live.ts`.
- The changed line replaces `context.maxEpochVertices * 3` with
  `context.maxEpochVertices`; no settlement-profile conditional or new seam was
  introduced.
- The unchanged backend ceiling suite remains 12/12 green.

