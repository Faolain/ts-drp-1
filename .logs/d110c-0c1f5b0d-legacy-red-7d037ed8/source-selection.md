# Exact production-body selection

The test parses `packages/node/src/v3-live.ts` with the TypeScript compiler AST
and requires exactly one top-level function declaration named
`countHistoricalIssuanceRow`. It transpiles and executes that declaration's
exact source text.

The execution environment supplies only the standard intrinsics referenced by
the existing private body: `Reflect.apply`, `Set.prototype.has`, and
`Set.prototype.add`. The tested count and membership state are ordinary live
objects. No production predicate is copied into the test, no product export is
added, and no comment, regex, or source substring decides acceptance.

If the production owner is removed, duplicated, or ceases to be executable in
this bounded unit harness, the test fails closed with
`D110C_0C1F5B0D_HISTORICAL_SCAN_OWNER_MISSING` rather than silently testing a
substitute.
