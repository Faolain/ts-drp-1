# D.110c-0c1b tests-only RED commands

Plan gate: signed/pushed `4d616285f13daeb74934260b80fe627dd8bdb338`
(tree `b6017d4413d85e246b0aba1db3ff34fbef94fff9`).

- Inventory:
  `pnpm exec vitest list tests/phase-6b-d110c-0c1b-committed-issuance-red.test.ts`
- Authored-file static gate:
  `NODE_OPTIONS=--max-old-space-size=8192 pnpm exec eslint` over the four
  changed test/fixture files.
- Authored-file format/diff gates: Prettier and `git diff --check` over the same
  files.
- Sole focused execution:
  `NODE_OPTIONS=--max-old-space-size=8192 pnpm exec vitest run
tests/phase-6b-d110c-0c1b-committed-issuance-red.test.ts --reporter=json
--outputFile=.logs/d110c-0c1b-red-4d616285/report.json`, with stdout and
  stderr captured separately.
- Deterministic validator: `jq` checks report success/counts/file/title and
  `rg -F` checks that the abbreviated runtime prefix maps to exactly one full
  token literal and exactly one throw site in the executed fixture. Results are
  retained in `validation.txt`.
- Source custody: `shasum -a 256` over the exact test and three fixture/helper
  files into `source-hashes.sha256`.
- Evidence custody: `shasum -a 256 -c manifest.sha256` over the completed
  self-excluding root.

The focused test ran exactly once. After Vitest finished and wrote its complete
report, the shell wrapper attempted to assign its saved exit code to zsh's
reserved read-only variable `status`; therefore no independent runner exit code
or wrapper finish timestamp exists. The report itself is complete and
fail-closed (`success=false`, one selected file, one selected test, one failed
test). The invocation was not retried.

A broad root `tsc --noEmit` diagnostic was also attempted before RED and
reported the repository's existing cross-example/test configuration failures;
it is not an exact-owner gate and is not represented as a D.110c-0c1b code
failure. Exact-owner ESLint passed.
