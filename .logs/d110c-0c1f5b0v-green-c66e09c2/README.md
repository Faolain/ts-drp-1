# D.110c-0c1f5b0v tests-plus-contract-comments GREEN

Signed/pushed GREEN: `c66e09c2937eaf54853340a8c4c0907c0c986162` (`G`).
Source tree: `d19a1946d1dde3d3427f592b468fe8a71f550fc6`.
Parent accepted plan/review: `c938038298b912875f2a8e7b717256fb34370df6`.
Causal RED: `488a22a6d33392ee2d6640761b3510ff253f4e07`, evidence `692b4add244cd128c215f29bd645dc62ee68285e`.
Plan-review evidence `.logs/d110c-0c1f5b0v-plan-review-1a4906a9/` was read and all 17 manifest entries validated before edits. Its empty P0/P1 union and five adopted P2 dispositions govern this correction. No reviewer was invoked here.

## Contract and causal closure

The same real room still genuinely closes/adopts, issues two separate above-snapshot vertices, fails on callback 2, releases its active owner/transport, and authentically cold-reopens. No test authority or durable room data is substituted. External notification attempts are explicitly `[d1]` after rejection and `[d1,d1,d2]` after reopen. The renamed tokens do not claim atomic or exactly-once external effects.

Canonical application-state bytes, exact message IDs, room authority and one-owner custody remain unchanged. The test now directly opens the existing browser issuance store, reads the exact lineage and every sequence through the unallocated next row before failure, after failure and after recovery, and compares them exactly. It independently pins the two real signed preimages, signatures, digests and author sequences, plus exact next sequence. A reissue cannot hide behind projection deduplication. The successful second attempt's authenticated projection-base and validated application-state events must precede its first callback. Existing first-callback sink/commit failure and ordinary successful replay controls remain.

The production changes are exactly two five-line JSDoc additions, beside `CreateV3RoomSessionInput.onAcceptedVertex` and `V3AdmittedVertexSink`. Source audit removes only those exact comments and recovers the exact baseline bytes. Parser-derived tokens and comment-free ASTs match; no runtime/type/export/schema/API shape/order/authority behavior changed.

The retained source test inventories every current callback property in production `examples/**/src` and `packages/**/src`. There are six: grid and v3-chat no-ops, room redirect forwarding/buffering, `acceptTarget`, reopened-target reconstruction, and rehearsed-target record reconstruction. It pins the collector bodies and existing canonical evidence/state checks. None requires a durable exactly-once external effect. A future consumer requiring one must stop/reslice into the separately reviewed effect/receipt transaction port.

## Gates and evidence interpretation

Every captured command has literal cwd/argv/start, complete stdout/stderr, PID and finish/status. JSON reporters retain all assertions and soft failures.

- Focused successor replay + contract inventory: local 6/6; isolated 6/6, zero skips/failures.
- Source-governance selected AST oracle: local and isolated 4/4; eight unrelated tests skipped by the explicit selector, then all 12 executed in the retained matrix.
- Retained room/recovery/creator-close/successor/active-owner selection: 15 files, 123 tests, 104 pass and 19 inherited failures locally and isolated, zero skips. Exact inherited failure-name/token sets are checked automatically against prior signed GREEN evidence. These failures are not claimed as passes: 18 stale mocked-room canonical-parameter failures in `phase-3g-v3-room-rebase-red.test.ts`, and one unsupported-cold-composition expectation in `phase-6a-creator-successor-product-red.test.ts`. No new failure appeared.
- Affected room and Node builds pass locally; clean `pnpm build:packages` freshly builds all 40 selected packages including room and Node.
- Room typecheck passes. Node typecheck retains precisely the same 13 error headers as prior GREEN/baseline (worker-host test rootDir/project inclusion, missing mocked route emit, compact-history test configuration). Local and isolated normalized headers match exactly. No typecheck failure is relabeled green.
- Exact-owner ESLint/Prettier, diff checks, exact-comment/token/AST source audit pass locally and isolated.
- Protected path content and all 27 stash identities remain unchanged in the main workspace. No campaigns, long workload, preflight, reviewers or subagents ran.

Initial diagnostic attempts are retained honestly: the first focused command could not resolve a newly added tests-side bare storage-browser import, so only the two source tests ran. The test import was corrected to the existing source module; no package dependency changed. Initial format/lint diagnostics were corrected before commit. An initial standalone TypeScript scanner did not rescan template literals and misclassified the added JSDoc as template content; this was a diagnostic mistake, not a code failure. The corrected audit uses parser-derived terminal tokens and an independent exact-comment-removal check.

## Exact clean-environment proof

`/tmp/d110c-f5b0v-green-LLxy4p/checkout` (physical `/private/tmp/...`) is a fresh `git clone --shared --no-checkout` followed by detached checkout at exact signed GREEN. Only Git objects are shared; there is no source/fixture/dist/node_modules overlay. The pristine check records clean tracked state, exact source/tree/lock hashes and no node_modules or package/example dist directories.

Commands: `pnpm install --offline --frozen-lockfile --ignore-scripts`; `node scripts/ensure-native-deps.mjs`; `pnpm build:packages`; then the exact focused, governance, retained and static commands in `commands/*/command.json`. Node `v22.15.0`, pnpm `10.24.0`, lock SHA256 `56e8b9b56d7e76d4651daec66b6ff8c0bc8150ce9fab588b97b1887f417d1251` are recorded. The normal native-dependency helper installed the locked node-datachannel prebuild; no dependency version or source changed. Resolved workspace imports point physically into this new checkout and match freshly built/main artifact hashes. Final clean-checkout source/status validation proves no tracked mutation after the gates.

## Custody and remaining boundary

GREEN was committed with `git commit -S --only` the four changed test/comment owners and pushed to `codex/phase3a1b-p6-golden-path`; signature and remote equality are captured. This evidence is a separate self-excluding manifest checkpoint. Final formal review/plan closure remains parent-owned. Parent f5b still owns authenticated settlement frontier/checkpoint integration, successful settlement close/adoption and the 64-writer repeated-room gates. This checkpoint does not reopen prior evidence or claim those gates.
