# Node typecheck baseline comparison

The package-wide Node typecheck remains nonzero for inherited test-only
diagnostics unrelated to the one-line production change.

- Accepted earlier f5b0d baseline:
  `.logs/d110c-0c1f5b0d-green-1063feca/typecheck-node.log`
- Current complete output: `node-typecheck.log`
- `error TS` lines in each: 13
- Normalization: retain only `error TS` lines, strip the absolute prefix through
  `packages/node/`, and remove carriage returns.
- Earlier normalized SHA-256:
  `a5fd26b3d324c4cfefa2d850001d3b39bb4c4cef31ae0a92e232ba790f39e190`
- Current normalized SHA-256:
  `a5fd26b3d324c4cfefa2d850001d3b39bb4c4cef31ae0a92e232ba790f39e190`
- Normalized diff: empty.

The production build configuration passed, so no diagnostic is introduced by
the changed owner.

