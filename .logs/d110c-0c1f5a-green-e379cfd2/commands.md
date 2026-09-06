# D.110c-0c1f5a GREEN command ledger

All commands ran from `/Users/aristotle/Documents/Projects/ts-drp-1` against
signed/pushed RED anchor `e379cfd2854cbcb9db117960388e311251c9f086` and its
tree `43d9b691eb4b3665ebd80ea9c7891c6146aa0524`, except for the explicitly
identified detached baseline diagnostic.

## Focused GREEN

The single focused invocation was:

`pnpm exec vitest run tests/phase-6b-d110c-0c1f5-foreign-author-close-liveness-red.test.ts --reporter=json --outputFile=.logs/d110c-0c1f5a-green-e379cfd2/focused.json`

The JSON reporter is semantically green: one selected file/title, one pass,
zero failures/pending/todo, `success: true`. The outer command status is `1`
only because the command omitted the established focused-run
`--coverage.enabled=false` switch, so Vitest applied the repository-wide 70%
coverage threshold to one file and reported 19.99%. The attempted timestamp
capture also used absent `/usr/bin/date`; this host provides `/bin/date`.
`focused-reconstructed-timestamps.json` records the reporter start and status
file time. The focused test was not rerun as a focused checkpoint.

After the final tests-only helper correction, the same RED-named file ran once
in its separately planned retained-control role with:

`pnpm exec vitest run tests/phase-6b-d110c-0c1f5-foreign-author-close-liveness-red.test.ts --coverage.enabled=false --reporter=json --outputFile=.logs/d110c-0c1f5a-green-e379cfd2/f5a-retained-red-named.json`

It exited `0` with the same exact one-file/one-title pass.

## Builds and static gates

The accepted required package chain exited `0`:

`pnpm --filter @ts-drp/protocol-v3 build && pnpm --filter @ts-drp/protocol-v3 typecheck && pnpm --filter @ts-drp/node build && pnpm --filter @ts-drp/example-v3-room build && pnpm --filter @ts-drp/example-v3-room typecheck && pnpm --filter @ts-drp/storage-browser build`

This includes the Protocol v3 public-entry audits. Two extra, broader
diagnostics were retained honestly: `pnpm --filter @ts-drp/node typecheck`
exited `2` on pre-existing worker-host rootDir, old WebRTC test-surface, and
compact-history config errors; `pnpm --filter @ts-drp/storage-browser
typecheck` exited `2` on pre-existing AHE asset alias/branding errors. The
production Node build and Storage Browser build both passed, and no unrelated
typecheck owner was changed.

Exact-owner Prettier, ESLint, and `git diff --check` were run over the four
changed TypeScript owners. `pnpm exec vitest list
tests/phase-6b-d110c-0c1f5-foreign-author-close-liveness-red.test.ts` listed
exactly the retained title.

## Runtime retention

The unchanged six-file f2/f4 command from the prior checkpoint ran with
`--coverage.enabled=false --reporter=json` and passed 41/41:

`pnpm exec vitest run tests/protocol-v3-creator-author-issuance-frontiers.test.ts tests/phase-6b-d110c-0c1f2-multi-author-frontier.test.ts tests/phase-6b-d110c-0c1f4-bootstrap-policy.test.ts tests/phase-6a-creator-successor-activation-red.test.ts tests/phase-6a-creator-adoption-red.test.ts tests/phase-6b-d110c-0c1a-retirement-checkpoint-red.test.ts`

The unchanged 20-file retained command was:

`pnpm exec vitest run tests/e5-01-v3-operation-admission-red.test.ts tests/phase-3a1b-p2-outbox-publication-contract.test.ts tests/phase-3g-v3-rebase-outbox-red.test.ts tests/phase-4b-v3-live-snapshot-composition-red.test.ts tests/phase-6a-creator-adoption-commit-red.test.ts tests/phase-6a-creator-successor-activation-red.test.ts tests/phase-6a-creator-successor-epoch-red.test.ts tests/phase-6b-ahe-reclamation-red.test.ts tests/phase-6b-d110c-0c1a-retirement-checkpoint-red.test.ts tests/phase-6b-d110c-0c1b-committed-issuance-red.test.ts tests/phase-6b-d110c-a-repeat-close-red.test.ts tests/phase-6b-d110c-b-hot-adoption.test.ts tests/phase-6b-issuance-retention-red.test.ts tests/phase-6b-runtime-reclamation-red.test.ts packages/storage-node/tests/phase-6b-ahe-reclamation-red.test.ts packages/storage-node/tests/phase-6b-issuance-retention-red.test.ts tests/protocol-v3-creator-author-issuance-frontiers.test.ts tests/phase-6b-d110c-0c1f2-multi-author-frontier.test.ts tests/phase-6b-d110c-0c1f4-bootstrap-policy.test.ts tests/phase-6a-creator-adoption-red.test.ts --coverage.enabled=false --reporter=json`

Its first result was 194/195 and exposed one tests-only regression: the new
registered-vertex fixture helper had permanently replaced
`fakeNetwork.gossipTopicFor`, so D.109d's later direct-retained route returned
false. The same exact title failed at the untouched RED anchor in a detached,
offline-installed worktree, proving the production GREEN was not causal. A
first restoration attempt happened before queued authentication and therefore
timed out under the full roster; that complete diagnostic is also retained.
The final helper keeps the synthetic classifier through authenticated
admission and restores it in `finally` before returning. A two-title targeted
fixture boundary passed, and the final unchanged retained command exited `0`,
20 files and 195/195.

## Browser compatibility

After confirming no ts-drp test/reviewer/profiler and no listener on ports
4174, 4175, 51000, or 51002, this command exited `0` with expected/skipped/
unexpected/flaky `2/0/0/0` and zero top-level errors:

`PLAYWRIGHT_JSON_OUTPUT_NAME=.logs/d110c-0c1f5a-green-e379cfd2/playwright-two-title.json pnpm exec playwright test --config packages/storage-browser/playwright.phase-6a-creator-successor-product.config.ts --project=chromium --grep 'D\.110c-0c1f4 exact configured bootstrap authority is required on epoch-N cold reopen|D\.110c-0c1f2 non-creator writer requires an authenticated historical frontier' --reporter=json --fail-on-flaky-tests`

No long campaign, D.110a invocation, dependency change, threshold change,
Fable run, or collaboration subagent was used.
