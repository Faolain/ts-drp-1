# D.110c-0c1k W0 corrective RED result

- Signed tests-only RED: `f511a18bdb35f56a31757f9739338f48572f00df`.
- The W0 focused contract remained 10/10 passing after replacing the faulty
  full-shape v1 fixture with the authoritative writer-only roster.
- The direct ACL retained file was 6/7 passing. Its sole failure was causal:
  current production accepted a version-1 member carrying the exact
  `[admin, finality, referee, writer]` tuple while the new compatibility pin
  required `snapshot-mismatch`.
- No import, export, fixture-loader, product, configuration, or dependency
  failure occurred. Exact test lint, format, diff and isolated status passed.
