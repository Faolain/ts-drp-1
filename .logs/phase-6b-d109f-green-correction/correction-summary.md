# D.109f final-review correction evidence

Date: 2026-09-01 (America/Puerto_Rico)

The correction is tests/evidence only. It changes no production source,
product API, schema, dependency, threshold, timeout, wire/digest/QC/
activation/availability/identity contract, browser scheduler, snapshot format,
or legacy behavior. No retained campaign ran.

It closes the accepted initial final-review blockers by:

1. replacing the planner's hard-coded projection/count outputs with one
   sorted, duplicate-free proof-kind registry tied exactly to all 22 D.109d
   lifecycle census keys, plus native AHE and issuance database censuses and
   exact receipt assertions;
2. adding tests-only durable-read observations on the genuine adoption
   fixture. Point-read identities are observed before backend lookup so an
   already-deleted lookup cannot evade `D109F_RAW_DEPENDENCY_READ` by returning
   `null`; maintenance still resolves the undecorated AHE backend from the same
   freshly built storage-node `dist` tree;
3. deriving the hot Discord-shaped and cold MMORPG-shaped controls from the
   actual accepted post-reclamation vertex, its canonical preimage, owner sink
   delivery, issued digest, and durable live-journal digest set rather than
   echoing planner constants; and
4. spawning a new Node/Vitest process that selects exactly the genuine close →
   adopt → reclaim → next-live lifecycle test with no inherited fixture object
   or weak handle.

Authoritative commands and results:

- `pnpm exec vitest run tests/phase-6b-differential-exit-red.test.ts packages/storage-node/tests/phase-6b-differential-exit-red.test.ts --reporter=json --outputFile=.logs/phase-6b-d109f-green-correction/focused.json --coverage.enabled=false`
  passed 11/11 in exactly 2 files;
- `pnpm exec vitest run tests/phase-6a-creator-adoption-commit-red.test.ts tests/phase-6a-creator-adoption-red.test.ts tests/phase-6a-creator-successor-activation-red.test.ts tests/phase-6a-creator-successor-handle-identity-red.test.ts tests/phase-6b-cleanup-eligibility-red.test.ts tests/phase-6b-runtime-reclamation-red.test.ts packages/storage-node/tests/phase-6a-creator-adoption-commit-death-red.test.ts packages/storage-node/tests/phase-6a-creator-successor-activation-death-red.test.ts --reporter=json --outputFile=.logs/phase-6b-d109f-green-correction/retained-vitest.json --coverage.enabled=false`
  passed 73/73 in exactly 8 files;
- `pnpm --filter @ts-drp/storage-browser exec playwright test --config=playwright.phase-6b-differential-exit.config.ts --reporter=json`
  passed 3/3, one per Chromium, Firefox, and WebKit, with zero skipped,
  unexpected, flaky, or top-level errors;
- `pnpm --filter @ts-drp/storage-browser exec playwright test --config=playwright.phase-6a-creator-successor-activation.config.ts --reporter=json`
  passed 24/24 across Chromium, Firefox, and WebKit with zero skipped,
  unexpected, flaky, or top-level errors;
- `pnpm --filter @ts-drp/storage build`, `pnpm --filter
@ts-drp/issuance-store build`, `pnpm --filter @ts-drp/storage-node build`,
  `pnpm --filter @ts-drp/storage-browser build`, and `pnpm --filter
@ts-drp/node build` passed;
- source-only `pnpm exec tsc -p <package>/tsconfig.build.json --noEmit`
  passed for storage, issuance-store, storage-node, storage-browser, and node;
- exact changed-file ESLint, Prettier, `git diff --check`, source-shape, owner-
  path, protected-path, 26-stash, process, and fixed-port checks passed.

Two invalid diagnostics are retained honestly. The first corrected focused
rerun omitted `--coverage.enabled=false`; all 11 tests passed, but the command
exited 1 on the unrelated global 70% coverage threshold. The corrected command
above is authoritative. A whole-package storage-node typecheck also selected
cross-root tests through inherited aliases and failed with the known
TS6059/TS6307 test-root set; all affected source-only build-config typechecks
passed.

Reporter hashes before the self-excluding manifest:

- `browser-d109f.json`:
  `a4ba29da105a63faa82502b3b6fbce25471eb911662819d461ea9d3cc64740e6`;
- `browser-phase6a.json`:
  `c52a35010caa8d274b174d343a3d8740c8aba1128c64523dae52d32f86f3cb07`;
- `focused.json`:
  `1ffc311fc7ee10adb79317d327a63a73609d200671bfebe361ab8af6d15173e7`;
- `retained-vitest.json`:
  `7c764fd1aa59f4f2d87b57d4d40563815ad85225b5c9eb61749921fe5a05c90f`.

Changed tests-only owner hashes:

- `packages/storage-node/tests/phase-6b-differential-exit-red.test.ts`:
  `bf54e93e97899cbf89c17ec46c368baddafd439327fb71795541b288804bc4dc`;
- `tests/fixtures/phase-6a-v3/creator-adoption-contract.ts`:
  `92d1f7af45fdeb82171f65e189fb0a16f12dc9d49b57e4910e789d6509e8a811`;
- `tests/fixtures/phase-6b/differential-exit-contract.ts`:
  `0c324bed4fb4b6a5429ab06490f6da1f493cc4bf79d54d9960522eb54268005b`;
- `tests/fixtures/phase-6b/runtime-reclamation-contract.ts`:
  `146ec273255d3df8f1b67c294e4b76169d102f25a0001c9d4d61a612a29e22f7`;
- `tests/phase-6b-differential-exit-red.test.ts`:
  `422192ec9663d56ddb054eb3694e78476f8cf33aa4e0864b9fc8ee42792f4368`;
- `tests/phase-6b-runtime-reclamation-red.test.ts`:
  `3ae9c3ac1758b3b7b256e5149ff98fd73accdb28be7297caaaecd773e613d3b1`.
