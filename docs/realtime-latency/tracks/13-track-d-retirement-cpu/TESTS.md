# Track D test comparison (baseline 4c4f192c vs patch.diff, dists rebuilt after each switch)

Script: tests.sh / baseline-tests.sh in this directory; logs t-base-*.log and t-after2-*.log.

| check | baseline | patched |
|---|---|---|
| tsc --noEmit -p tsconfig.build.json: canonical / storage / storage-browser / node | 0 / 0 / 0 / 0 errors | 0 / 0 / 0 / 0 errors |
| canonical vitest (incl. codec-differential vs frozen v1 reference) | 37/37 | 37/37 |
| storage vitest | 264/264 | 264/264 |
| storage-browser vitest (maxWorkers=1) | 284 pass, 10 fail | 284 pass, 10 fail — identical failing set |

The 10 storage-browser failures are pre-existing at 4c4f192c (fails-base-storage-browser.txt ==
fails-after2-storage-browser.txt): governance/package-shape checkers (idb-ownership-controls,
phase-2d2a governance, phase-2e7 publication, phase-2g-a/2g-b, phase-2l-b, corrective-clean-checkout)
that type-check whole programs with project-config errors, and journal-image-single-capture
(CanonicalEncodingError vs retirement-fenced class-identity mismatch between canonical src/dist).
Package-local `tsc --noEmit` (non-build tsconfig) has many pre-existing rootDir/test-file errors in
both states; the build configs are clean.
