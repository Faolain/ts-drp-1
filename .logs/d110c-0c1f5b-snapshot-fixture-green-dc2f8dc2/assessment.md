# Snapshot-fixture GREEN handoff

The narrow fixture repair passes its main and independently source-built isolated gates. Source commit `2f09a52ce58e81000850d73594ca1f3ab4c9309a` is signed and pushed; only `tests/fixtures/phase-4b-v3/live-snapshot.ts` was committed. Its SHA-256 is `fddfff2be4f1913b7e27a1b20b82efbabee1fc07ea36efe0a0e467c8b1781864`.

The three authorized changes are an asynchronously rejecting `installEpochAnchor` mock with the exact unsupported-operation error and no mutation, the real settlement-plan method input type, and a non-null local `SettlementPlan` assigned and returned unchanged. The accepted RED test is byte-identical. Full-file reversal restores the original helper; emitted-code comparison permits only the rejecting method and equivalent local-plan assignment. Existing CAS, scope, revision, entries, plan effects, fake network, recovery helpers, imports, exports, and module initialization are preserved.

## Gates

| Environment | Focused | Eleven retained files | Selected strict compiler |
| --- | --- | --- | --- |
| Main | 1 passed | 118 passed | 0 diagnostics |
| Fresh isolated | 1 passed | 118 passed | 0 diagnostics |

All four runtime reports have exact frozen file/name multisets, zero failures, skips, todos, soft failures, suite errors, or snapshot changes. All runners exited 0 and reported quiescence. Full raw output, reporters, statuses, and validations are retained. Exact-owner lint, format, diff, source equivalence, and compiler matrix checks passed in both environments. The three previously inherited snapshot-fixture diagnostics are cleared in the selected parent two-root program plus the new focused test; this is not a whole-repository typecheck or a grid diagnostic waiver.

The retained roster is the actual collected 119-case set, not preliminary literal declaration counts. The seven direct recovery files and four approved indirect settlement files all ran. The unchanged genesis dispatch selects `installGenesis` for epoch zero without reading the added epoch installer; the focused test also exercises genuine epoch-zero recovery. Source-equivalence evidence covers unchanged shadow-driver call paths. The shadow comparison's eager 100-synthetic-close setup was not run and receives no runtime credit. No wide integration, browser, campaign, or consumed-memory workload ran.

## Independent source and custody

The isolated checkout is `/private/tmp/d110c-f5b-snapshot-fixture-green-YoEBmS/checkout`, pinned to the signed source commit plus only the exact pending eight-owner production overlay `6d0fd99cfcb383b82f3becae421b4691bb945639ef9d60b76e9968715df765cb`. Its own offline frozen install used ignored scripts; native preparation used the physical node-datachannel package directory, a fresh cache, and the locked official prebuild. Direct native import, full package source build, and fresh Node package-root import passed. All seven built owners were absent before build and then matched the main hashes. No host dist, node_modules, native binary, or cache was copied into the checkout.

Main compiler graph: 913 sources. Isolated graph: 532 physically local sources. All 532 common sources match; the 381 main-only sources are ancestor ambient declarations under `/Users/aristotle/node_modules`, with no missing workspace source or isolated-only source. Root-relocated options match. The complete ambient graphs are not claimed identical.

Final custody preserves all eight pending production owners, seven built owners, 27 stashes, 86,522 protected paths, and previously sealed manifests. `effective-test-fixture-hashes.json` merges final `testHashes`, final `fixtureHashes`, and the frozen runtime roster hashes into the current 95-file test/shared-fixture map. Together with eight production owners this is the 103-source isolated identity set. The helper's updated hash supersedes its prior baseline value.

## Disclosures and remaining scope

Read-only preparation initially guessed two absent historical recorder paths; existing files were located and reused. Those tool-only read errors were not product/static/runtime failures, and their full stderr was not captured by the command recorder. Preliminary literal declaration counts were not execution claims and were superseded by actual collection before runtime. All captured command statuses in this GREEN root are zero; no runtime was retried.

This handoff does not close the parent production slice. The separate grid diagnostic, four recorded registry/W0 runtime failures, combined parent obligations, browser controls, final signed-production isolation, and root-owned final review remain outside this repair. No plan or pending production file was committed here. Root owns evidence signing and acceptance.
