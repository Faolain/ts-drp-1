# Repository typecheck fixes

**Outcome:** Landed in de70325e (repo typecheck to 0 errors).

## Agent: Fix node package type errors

### Brief (plan given to the agent) (2026-10-19 17:16 UTC)

You are fixing pre-existing TypeScript errors in the `@ts-drp/node` package of the monorepo at <repo> (branch codex/phase3a1b-p6-golden-path; lots of uncommitted work in the tree — that is expected; do NOT commit, stash, reset, checkout, or revert anything, and never run `rm -rf`/`unlink`, a hook blocks them; to move something aside use `mv` into your scratch dir). Another agent is concurrently editing packages/storage-node/** and repo-root tests/fixtures/** — do NOT edit any file outside packages/node/tests/** (and packages/node/src/** only if you prove a genuine production bug; prefer reporting it instead).

#### Command
From packages/node:
`../../node_modules/.bin/tsc -p tsconfig.typecheck.json --noEmit --pretty false`
(tsconfig.typecheck.json is a new non-composite typecheck config; it is correct, don't change it, or tsconfig.json / tsconfig.build.json.) Currently 45 errors. Ignore the ones in `../../tests/fixtures/**` (the other agent owns those). Your target: 0 errors in files under packages/node/**.

Current error files: tests/creator-closed-rollback-proof-accounting.test.ts, tests/creator-finishing-width-program.test.ts, tests/ephemeral-webrtc-e3-02-red.test.ts, tests/proptest/spawn.ts, tests/rpc.test.ts, tests/creator-retained-close-signed-provenance.test.ts, tests/creator-recovery-verified-branch.test.ts, tests/creator-ordinary-generation-closure-capacity.test.ts, tests/creator-ordinary-application-material.test.ts, tests/creator-replay-seal-native.test.ts, tests/closed-epoch-retirement-sequencing.test.ts and possibly others — run the command for the real list.

#### Rules (these matter more than reaching zero)
- Never weaken a test: don't delete/loosen assertions, don't skip tests, don't add `@ts-ignore`/`@ts-nocheck`, don't widen to `any`. Don't add files to the tsconfig exclude lists.
- `@ts-expect-error` is acceptable ONLY where the test deliberately passes type-invalid input to prove a runtime refusal — and then prefer a precise cast at that one argument (e.g. `forged as never` / `as unknown as T`) with a short comment saying it's deliberately forged.
- Brand types (StorageObjectId, GenerationId, ClosureDigest, HeadRevision, BlobDigest...): cast literals at the construction site (`"x" as StorageObjectId`), or use the package's `parse*` helpers if the test already does elsewhere.
- Optional methods that the concrete implementation always provides: narrow once via a small runtime-checked helper (throws if absent) rather than sprinkling `!`.
- Test-local helper typed too narrowly (e.g. `must()` expecting `{value}` on results that have none): add a sibling helper, don't change semantics.
- Narrowing lost in closures: bind the narrowed value to a `const` after the guard.
- Stale tests against an API that no longer exists (e.g. `@ts-drp/object` — that package is retired: `packages/object` has no package.json and pnpm-workspace.yaml excludes it; `DRPNode.createObject`, `IDRPObject` from @ts-drp/types, `interval_sync_options`): figure out whether the file is reachable from the typecheck program only via an import from another test. If a test is genuinely dead (imports a module that cannot exist at runtime, so vitest can't even load it), DON'T hack types — instead report it to me with evidence (which file pulls it in, whether vitest can load it) and leave it; I will decide. Same for "red" tests whose API drifted: if fixing types would require inventing semantics, report rather than guess.
- Target / lib issues (e.g. TS2737 BigInt literals with target ES6): use `BigInt(n)` in tests rather than changing compiler options.
- Match the surrounding code style (tabs, comment density).

#### Verification (required)
1. Before editing, record a baseline: from the repo root run `node_modules/.bin/vitest run <each test file you will touch> --exclude ".claude/**" --no-coverage` and save per-test pass/fail (the machine is heavily loaded; 10 s timeouts happen — rerun a flaky failure once before concluding). Some of these are "red" files with pre-existing failures; that's fine.
2. After editing: typecheck shows 0 errors in packages/node/** and re-run the same vitest files. No test that passed in baseline may fail now (timeouts that pass on rerun are fine — say so).
3. Run `node_modules/.bin/prettier --check <files you touched>` from repo root and fix formatting if prettier was clean on the file before your edit (check before editing too; don't reformat files that weren't prettier-clean before).

#### Report back (in your final reply, concise)
- Per file: what the errors were and how you fixed each category (1–2 lines each).
- Anything you deliberately left (with evidence) and why.
- Final typecheck error count for packages/node/** and the before/after vitest pass/fail per touched file.
- `git diff --stat` of the files you touched.

### Report returned by the agent

_No final report: the run was interrupted or ended without one; see the outcome above and the working documents._

## Agent: Fix storage-node and fixture type errors

### Brief (plan given to the agent) (2026-10-19 17:17 UTC)

You are fixing pre-existing TypeScript errors in the `@ts-drp/storage-node` package and in shared repo-root test fixtures, in the monorepo at <repo> (branch codex/phase3a1b-p6-golden-path; lots of uncommitted work in the tree — that is expected; do NOT commit, stash, reset, checkout, or revert anything, and never run `rm -rf`/`unlink`, a hook blocks them; to move something aside use `mv` into your scratch dir). Another agent is concurrently editing packages/node/** — do NOT edit files there. You own: packages/storage-node/tests/** and repo-root tests/fixtures/** (only the fixture files with errors listed below). Don't edit production src unless you prove a genuine bug — prefer reporting it.

#### Commands
- storage-node: from packages/storage-node: `../../node_modules/.bin/tsc -p tsconfig.typecheck.json --noEmit --pretty false` (currently 22 errors).
- node (only to see the shared-fixture errors, which also appear there): from packages/node: same command; look only at lines starting `../../tests/fixtures/`.
(tsconfig.typecheck.json is a new non-composite typecheck config; it is correct, don't change it, or tsconfig.json / tsconfig.build.json. Root package.json was just given workspace links for @ts-drp/{blueprint-catalog,control-plane,keychain,live-journal,message-queue,types} so root fixtures resolve those.)

Current error files: storage-node tests/phase-2l-c-node-issuance-red.test.ts, tests/phase-3a1b-p4-node-live-journal-red.test.ts, tests/r8-source-custody.test.ts, tests/retirement-image-cas.test.ts (2 left at ~3323/3346: the `drain` spread; the file already got a `createRetirementStore`/`succeed` helper and a `const control = complete.control` binding from me — keep those), tests/signing-native.test.ts, tests/fixtures/declaration-discovery-child.ts (TS1378 top-level await — check how this child is executed; a `void (async () => {...})()` or similar is fine only if semantics are identical, otherwise consider whether it should be ESM-typed), and shared root fixtures ../../tests/fixtures/phase-6a-v3/creator-adoption-contract.ts, ../../tests/fixtures/phase-6b/differential-exit-contract.ts. Run the commands for the real list.

#### Rules (these matter more than reaching zero)
- Never weaken a test: don't delete/loosen assertions, don't skip tests, don't add `@ts-ignore`/`@ts-nocheck`, don't widen to `any`. Don't add files to tsconfig exclude lists.
- Where a test deliberately passes type-invalid input to prove a runtime refusal (e.g. signing-native.test.ts `raw = Object.freeze({objectId:"forged",epoch:0})` passed to adapter.commitQc), use a precise cast at that argument (`raw as never`) with a short comment that it's deliberately forged.
- Brand types (StorageObjectId, GenerationId, ClosureDigest, HeadRevision, BlobDigest, GenerationRef...): cast at the construction site, or use existing `parse*`/fixture helpers (tests/fixtures/phase-6b/ahe-reclamation-contract.ts has e.g. `d109cClosureDigest`, `d109cGenerationId`; I added `d109cClosureDigest` and typed `d109cNoHead` there earlier — follow that pattern).
- Optional methods that the concrete implementation always provides: narrow once via a small runtime-checked helper (throws if absent) rather than sprinkling `!`.
- Narrowing lost in closures: bind the narrowed value to a `const` after the guard.
- Fixture functions with implicit-any params (TS7006): give them the real parameter types from the port they implement.
- If fixing types would require inventing semantics (API drifted in a "red" test), report rather than guess.
- Match the surrounding code style (tabs, comment density; some files use a dense one-line style — keep it).
- Shared fixtures are imported by several packages' tests: after editing them, also confirm no NEW errors appear in the typecheck of packages/node, packages/storage-browser and packages/storage (same command in those dirs) — compare error lines that reference the fixture before vs after.

#### Verification (required)
1. Before editing, record a baseline: from the repo root run `node_modules/.bin/vitest run <each test file you will touch, plus the tests that import the shared fixtures you touch (grep for them)> --exclude ".claude/**" --no-coverage` and save per-test pass/fail (machine is heavily loaded; 10 s timeouts happen — rerun a flaky failure once). Some are "red" files with pre-existing failures; fine.
2. After editing: storage-node typecheck 0 errors, no `../../tests/fixtures/` errors in node's typecheck, and re-run the same vitest files: no test that passed in baseline may fail now.
3. `node_modules/.bin/prettier --check <files you touched>` from repo root: keep files that were prettier-clean before clean; don't reformat files that weren't.

#### Report back (in your final reply, concise)
- Per file: what the errors were and how you fixed each category (1–2 lines each).
- Anything deliberately left (with evidence) and why.
- Final error counts and the before/after vitest pass/fail per touched/importing file.
- `git diff --stat` of the files you touched.

### Report returned by the agent

_No final report: the run was interrupted or ended without one; see the outcome above and the working documents._
