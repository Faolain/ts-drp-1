# D.110c-a final-review correction ledger

Reviewed GREEN: signed/pushed `a923c7d2b8d2d2a5c58725a467d8e33f43db7c73`.

## Review result

- Grok 4.6/high initial runner was service-cancelled after 330.136 seconds. The exact session `01a06272-94a7-7f82-b385-f640f0c3f403` was resumed, completed, and returned `APPROVED`, P0=0/P1=0/P2=3.
- Direct `kimi-cli` reached the provider and returned 401 `invalid_authentication_error`, so that attempt is honestly `NO_VERDICT` and did not inspect the implementation.
- Opus xhigh session `f0480f5a-8a6a-4eb2-8f22-3cf86c1ac52e` returned `CHANGES_REQUIRED`, P0=0/P1=1/P2=3. Its sole P1 was accepted: the plan made the hostile-carrier and epoch-refusal matrix mandatory, but the original focused fixture did not execute it.

## Narrow correction

Only the D.110c-a focused test/fixture and one tests-only child are changed. No production source, API, dependency, wire/schema, workload, threshold, or campaign behavior changes.

- Seven carrier mutants (`root-inconsistent`, `size-inconsistent`, `missing`, `malformed`, `reset`, `cross-room`, `earlier-epoch`) begin from genuine close evidence, pass through the real commit/activation owners, and are refused by the real close binder with exact `CREATOR_CLOSE_UNAVAILABLE` before room-head or durable-head mutation.
- The successful path still performs the genuine epoch 0→1 adoption/activation and epoch 1→2 close.
- A fresh isolated child installs the existing private close-registration resolver seam and proves `Number.MAX_SAFE_INTEGER` is refused at bind with exact `CREATOR_CLOSE_UNAVAILABLE` before stores, seal, snapshot, or generation staging.
- Existing retained Phase-5e successor-trust mutants continue to prove skipped/substituted successor epochs fail with exact `EPOCH_GAP`; D.110c-a also retains the production post-open identity assertion before generation staging. No upstream protocol mock was added merely to make that defensive assertion reachable.
- Canonical decoding destroys JavaScript reference aliases. The existing copied-snapshot assertion plus retained `CompactMerkleAccumulator.fromSnapshot` hostile/alias tests remain the executable alias-ownership proof; no impossible on-wire alias identity is claimed.

## Commands and results

- Fixture TypeScript project: status 0.
- First corrected focused command: reporter `success=true`, one file/one test passed; shell status 1 only because the command mistakenly enabled the repository-wide coverage threshold. This was a command-wrapper diagnostic mistake, not a test failure.
- Corrected exact focused command with `--coverage.enabled=false`: status 0, one file/one test passed.
- Retained 16-file Vitest command: status 0, 34 reported suites, 128/128 tests passed.
- Exact-owner ESLint, Prettier, fixture TypeScript project, and `git diff --check`: status 0.

Diagnostic focused reporter, final focused reporter, retained reporter, and
resumed Grok terminal SHA-256 values are respectively
`13695b5b6fc310134fad6764b539e7f226e7da6509718abe8e1296de6496c3e4`,
`8ca49f19450bc478820b80785723061e91204328e1bf79cd7c4e3a59c386f8c4`,
`37d3f879245ea1776a3d39f89801af17c83ddc28c98cbb86223a8d265d1082d3`,
and `df1e8e251f516a1ec689bcaa2e891329351e2c11441bb1d10b5ee42ef2013951`.

The correction requires the single permitted confirmation because executable test acceptance changed. No additional Fable run is authorized or used as a D.110c-a gate.
