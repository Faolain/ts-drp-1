# Parent f5b retained counter-harness baseline correction

Signed/pushed tests-only commit `bc7d615b40c5125ed5b48ff90d0be64dcdca4b15` changes only `executableHistoricalIssuanceCounter` in `tests/phase-6b-d110c-0c1f5b0d-reclamation-red.test.ts`. Test SHA-256: `b3e4eb073dfd3e660703957573dbfadfe8e2989396f1d77041632614edaa5c20`. This is prospective preservation of an existing retained harness, not a new causal RED, reopened f5b0d slice, or parent production acceptance.

## Exact repair and source attribution

The helper dynamically imports the existing real `resolveVerifiedCreatorHistoricalIssuance` export from `packages/node/src/internal/creator-transition-advance.js` and supplies it as the fourth parameter to its existing Function evaluation. The parameter is typed as the actual resolver and receives that callable directly. There is no stub, fabricated capability/identity, additional fixture, production extraction/refactor or API change.

Stopped parent gate 07 failed before the boundary assertions because only three intrinsics were bound and the extracted patched counter referenced this real resolver. Its complete observed 19-total/18-pass/1-ReferenceError result remains immutable in the 137-entry stopped evidence root, alongside the 168-total/167-pass/1-failure retained stop. No prior result is relabeled.

The actual resolver uses private WeakMap custody and returns undefined for absent/foreign capability. The preserved patched counter calls it and applies one maxEpochVertices window when admissionEpoch is absent, three only when present. The signed baseline counter retains its direct one-window implementation and does not call the resolver. Both complete counter declarations and the byte-identical real resolver are captured in custody sourceAttribution. Consequently this isolated run verifies baseline compatibility and loading of the real resolver; it does not replace the later gate against the dirty parent counter.

All bytes outside the extraction helper match signed parent `3026575608479da88b707ece8ae5dcaf48802f56`, including 10 other top-level helper functions and every assertion. The legacy control still accepts exactly 8,192 distinct rows, accepts duplicate sequence 8,191 without growth and rejects sequence 8,192 (the 8,193rd distinct row). The other 18 cases, titles/counts, fixtures, parent scalar/segmented/checkpoint tests, thresholds and production remain unchanged. Root inspected and accepted the helper-only diff before signing. No design/code contradiction or scope expansion was found.

## One independent baseline execution

A fresh sparse checkout at `/tmp/d110c-f5b-retained-counter-MFlKNz/checkout` was detached at the signed/pushed test commit. Independent `pnpm install --offline --frozen-lockfile --ignore-scripts` and full `pnpm build:packages` passed before collection or execution. No pending eight-owner GREEN patch, copied dist/node_modules, or diagnostic configuration was applied. Before/after identity checks show clean tracked source and unchanged source/runtime/config hashes; dependency realpaths are inside the isolated installation. Node v22.15.0 and pnpm 10.24.0 are recorded.

Exact 19-case collection matched the stopped gate-07 file/title multiset. The matrix and command were frozen before execution: one relative test-file argument, `--no-file-parallelism --coverage.enabled=false --reporter=json`, and the fresh output path in focused-command.json. There was no test-name filter or broadened selection. Matrix SHA-256: `f075265af61bbff440e0bd5709d6758f7d3bd076b60fcbda601b8c8dc64490de`.

The sole run returned status 0 and **19 total / 19 passed / 0 failed / 0 skipped**, one exact file, success true. Every failure-message array and suite message is empty; there is no testExecError, unhandled, loader, fixture, timeout or selection anomaly. Complete raw reporter, stdout, stderr, command/status, all selected names and result records are preserved. The ordinary Node experimental SQLite warning is retained in stderr and not misclassified as a failure. Reporter SHA-256: `10d5c3ab50a653bd011cadffba7be9f2268692c20b948586921dc05ad6a6123c`.

Root independently reparsed the full focused.json and verified the exact 19-case multiset. Its first read-only inspection opened summary result.json as though it were the raw Vitest reporter; the missing testResults property exposed the mistake, and the corrected focused.json inspection passed. No runtime rerun or source edit resulted.

| Retained case | Outcome |
| --- | --- |
| pins the f5b0d boundary and hands non-issuance scope retirement to D.110c-c | pass |
| installs one storage-neutral authenticated settled-prefix owner without relying on a missing import | pass |
| memory refuses a settlement-profile prefix when the durable plan is absent | pass |
| browser refuses a settlement-profile prefix when the durable plan is absent | pass |
| node refuses a settlement-profile prefix when the durable plan is absent | pass |
| memory refuses while the required fence link is incomplete | pass |
| browser refuses while the required fence link is incomplete | pass |
| node refuses while the required fence link is incomplete | pass |
| memory refuses an unlinked entry outside the selected prefix and deletes nothing | pass |
| browser refuses an unlinked entry outside the selected prefix and deletes nothing | pass |
| node refuses an unlinked entry outside the selected prefix and deletes nothing | pass |
| memory refuses manual review outside the selected prefix and deletes nothing | pass |
| browser refuses manual review outside the selected prefix and deletes nothing | pass |
| node refuses manual review outside the selected prefix and deletes nothing | pass |
| memory prunes one authenticated complete mixed-epoch pending/published prefix and replays monotonically | pass |
| browser prunes one authenticated complete mixed-epoch pending/published prefix and replays monotonically | pass |
| node prunes one authenticated complete mixed-epoch pending/published prefix and replays monotonically | pass |
| node rolls back both tables and the watermark when an authenticated prune crashes mid-transaction | pass |
| keeps creator-trusted-v1 historical issuance within one maxEpochVertices window | pass |

## Static and custody

Main test lint/format/syntax/scope/diff checks pass; isolated lint, format, exact collection and source-mapped TypeScript checks pass. This bounded program has zero target and zero external diagnostics. No package-wide typecheck, earlier package-diagnostic rebaseline or complete parent static GREEN is claimed.

All eight dirty production owners and full-index/binary patch remain unchanged at SHA-256 `245c2b251c5dfc9389c9732319c8e1b474cf2740252dff3d107320121e6564ed`. All 27 stashes match and all 86,522 protected paths still exist. Parent tests/oracles and the existing settlement-plan fixture are byte-identical. Stopped GREEN manifest (137 entries, SHA-256 `9ee19175cda3b5a1db33319c16478b3c01f3ea5c30db08a1d0a99566c3c4ef4c`) and the named prior design/RED manifests validate. Old evidence roots remain untouched.

No main-workspace runtime, parent causal RED/focused run, other retained gate, browser, campaign, long worker, subagent or model review ran. No post-run test edit or rerun occurred. Root owns the acceptance/status update; afterward the separate GREEN owner must run the same 19-case gate against the preserved patch and only then resume the remaining frozen gates. Already-passing focused and covered retained gates are not rerun for this helper correction.
