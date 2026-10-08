# Parent f5b checkpoint-link oracle tests-only RED

Accepted causal RED, not production GREEN. Tests-only signed/pushed commit `f83764c5a141972f13870168eb5b9a758cd92e1c` changes exactly one domain literal at `F5B_64_ADJACENT_CHECKPOINT_LINK` in `tests/phase-6b-d110c-0c1f5b-integration-red.test.ts`. The resulting test SHA-256 is `3eaf77c0438df09af30509c839531e78576a5fe6e88c70ea2983ee997807c885`. Root independently inspected the exact one-line diff before signing and isolated execution.

## Closed contract and exact correction

The expectation now independently hashes `priorCheckpoint.bytes` under the existing storage blob domain `ts-drp-storage/blob/v1`. It does not read the product's actual priorCheckpointDigest, delegate the assertion to the production reference helper, or accept either digest. No import, comment, other assertion/token, title, helper, fixture, workload, threshold, timeout, configuration or production change was made. A whole-file equality check proves all bytes outside that exact literal replacement are unchanged relative to signed parent `1a938c6189ec515b6cba0ba378e73e80f0803504`. The 25 other top-level functions, scalar case-25 correction and genuine segmented assertions remain identical.

Signed `b926a60658b7ce244f4ef159d634077e0cba3b49` already installed `openedProposed.identity.priorCheckpointDigest === current.ref.digest`. Current stopped production retains this predicate. Candidate refs are created and validated by storage digestBlob; storage values.ts uses `ts-drp-storage/blob/v1` over exact signed-record bytes. The codec's `ts-drp/creator-author-settlement/v1` domain signs a canonical preimage excluding detachedAuthoritySignature. The former expectation applied that signature domain to the whole signed record, matching neither contract. The design delegates adjacency to bounded advance and does not override this closed candidate-reference contract. No remaining design/code contradiction or production hash/authority change is required.

`source-contract.json` records the signed predicate, current predicate, storage and codec excerpts/hashes. A bounded sweep of both parent test files and their fixture folder confirms only the corrected occurrence. Accepted design/pre-review and all named stopped/RED manifests were read and verified before editing; no rereview was invoked.

## One clean isolated run

One new sparse checkout at `/tmp/d110c-f5b-checkpoint-link-red-m2McIC/checkout`, detached at the signed test commit, independently installed dependencies with `pnpm install --offline --frozen-lockfile --ignore-scripts`. Its full `pnpm build:packages` source build passed before test collection. No partial eight-owner GREEN patch, copied dist/node_modules, diagnostic Vite config or runtime overlay was applied. Clean tracked source, source/runtime/config hashes and independent dependency realpaths were verified before and after execution; Node v22.15.0 and pnpm 10.24.0 are recorded.

The exact accepted two-file `-t` command and new JSON reporter path were frozen in `focused-command.json` before the sole execution. `matrix.json` SHA-256 is `c8b787080d810e33ee4e1fecc4fbd7b660bd6ef69f0bcc8f77475833de05e33c`. Selected titles/tokens/statuses are identical to the accepted scalar matrix. No filter, coverage, file parallelism, timeout or configuration override was added.

Vitest returned status 1; the causal validator returned status 0: **45 total across two files (24 + 21), 28 active, 23 exact causal failures, 5 passing controls, 17 intentional skips**. The 23 failure-message records are exactly 19 successor-codec, one wide ACL canonical-item-limit at migrationInviteAuthority, and the three inherited P2 tokens. Zero extra soft failures, missing/repeated titles, changed-token, loader, fixture, timeout or top-level anomalies. Full reporter SHA-256: `32b4bd2c4fdab0c66cee28cfc17def5598da251da8527bf7f37ce35297395531`. Complete reporter, stdout/stderr, results, all selected names and failure messages are retained; independent-audit.json reparses the entire saved reporter without executing tests again.

The pre-codec RED does **not** reach the corrected adjacency assertion. It proves the correction preserves the frozen causal matrix and isolation, not that the wide continuation is GREEN. Full parent GREEN must physically prove the corrected assertion and all remaining exact accounting across three genuine 64-writer transitions.

In the complete active matrix below, **codec** means `F5B_SETTLEMENT_PROFILE_SUCCESSOR_CODEC_REQUIRED`.

| Selected case | Exact outcome/token |
| --- | --- |
| snapshot oracle removes controls before Kahn while ACL vertices retain their ordering effect | pass |
| snapshot oracle preserves prior state atomic batch entry order and duplicate effects | pass |
| retains checkpoint-terminal open progress through cold recovery across three transitions | codec |
| composes 64 active writers with universal plan fence and exact state accounting across three transitions | canonical value exceeds item limit |
| case 1 withholds a distinct dependent author sequence until its delayed predecessor is settled | codec |
| cases 6-9 authenticate same-key removal and same-device and fresh-device readmission | codec |
| case 11 retains the hold across close and cold reopen until authenticated author-wide readmission | codec |
| case 12 scans the largest valid fence without burning another author space | codec |
| case 12 ignores a stale fence at or below the authenticated terminal boundary | codec |
| case 23 freezes only the equivocating author below a fence | codec |
| cases 4 15 16 preserve unpublished-fence custody | codec |
| cases 4 15 16 preserve delayed-replacement custody | codec |
| cases 4 15 16 preserve delayed-fence custody | codec |
| case 17 closes an authenticated null-boundary member without a fence or slot zero | codec |
| cases 19-21 retain displaced control and sole plan completion ownership | codec |
| case 24a rejects a stale local head without regressing the authenticated floor | codec |
| case 25 accounts exact surviving fence publication with committed=false | codec |
| case 25 accounts exact surviving fence publication with committed=true | codec |
| case 25 accounts exact surviving replacement publication with committed=false | codec |
| case 25 accounts exact surviving replacement publication with committed=true | codec |
| case 25 retains custody when bounded authenticated recovery cannot read durable truth | codec |
| case 13 prunes only beyond the fully retained authenticated rollback window | codec |
| case 17 retains the exact legacy v1 reentry guard source custody | pass |
| keeps the genuine v1 room issue, close, adoption and cold reopen control unchanged | pass |
| P2 non-hold same-message application failure retains generic activation mapping | F5B_P2_PRIVATE_HOLD_PROVENANCE_REQUIRED |
| P2 closed-session precedence is consistent for issue | pass |
| P2 closed-session precedence is consistent for rehearse | F5B_P2_CLOSED_PRECEDENCE_REHEARSE_REQUIRED |
| P2 closed-session precedence is consistent for activate | F5B_P2_CLOSED_PRECEDENCE_ACTIVATE_REQUIRED |

## Static, custody and limits of acceptance

Main and isolated test lint/format, syntax, exact one-literal scope, selected/all collection and test diff whitespace checks pass. Initial main lint completed successfully after the signed test commit while source remained unchanged; it passed before isolated cloning. Final main lint is captured independently. Target TypeScript diagnostics are zero; the three external live-snapshot diagnostics (TS2741, TS7006, TS2322) exactly match accepted scalar evidence and remain fully recorded, not a package-wide typecheck GREEN claim.

Initial read-only searches included nonexistent guessed storage/settlement module paths and returned rg exit 2; exact repository source discovery resolved them. One early signed-source line range did not contain the predicate; a bounded exact-text lookup found it at line 761 of b926a6065. Root's first read-only aggregate reporter inspection had an extra closing brace; its corrected inspection exited zero and independently verified the complete matrix. These inspection corrections changed no source/evidence and executed no test workload.

All eight stopped production hashes and full-index/binary patch remain byte-identical to the latest continuation custody. Patch SHA-256: `245c2b251c5dfc9389c9732319c8e1b474cf2740252dff3d107320121e6564ed`. All 27 stashes match the baseline and all 86,522 protected paths still exist. Test/oracle/helper custody is unchanged apart from the one authorized literal. Old evidence roots remain immutable. Design (3 entries), stopped continuation (61), accepted scalar RED (75) and accepted observer RED (63) manifests validate with their frozen hashes.

No test rerun, post-run test edit, production edit, parent GREEN/retained suite, long worker/campaign, model reviewer or subagent was executed. Root owns acceptance/status and any later parent GREEN authorization.
