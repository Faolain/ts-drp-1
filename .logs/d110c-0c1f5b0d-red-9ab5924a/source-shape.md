# Source-shape audit

The accepted RED statically and behaviorally freezes these seams:

- all four issuance maintenance owners must contain the internal
  `pruneAuthenticatedSettledPrefix` capability;
- the RED compatibility adapter uses `Reflect.get` and falls through to the
  genuine existing `prunePublishedPrefix`, so current failure is behavioral
  and not a missing import/export;
- `packages/node/src/v3-live.ts` must make the real authenticated prune call and
  invoke `planClosedEpochCleanup` in that production path;
- `countHistoricalIssuanceRow` must stop comparing directly against one
  `maxEpochVertices` and must instead use either the exact rollback-window
  multiple or the authenticated settled watermark; and
- the only committed RED path is the one test file named in
  `changed-paths.txt`; no production or plan file changed.

The exact-token inventory was inspected with:

`rg -n "pruneAuthenticatedSettledPrefix|D110C_0C1F5B0D_|DEFERRED_D110C_C_SCOPE_RETIREMENT|countHistoricalIssuanceRow" tests/phase-6b-d110c-0c1f5b0d-reclamation-red.test.ts`
