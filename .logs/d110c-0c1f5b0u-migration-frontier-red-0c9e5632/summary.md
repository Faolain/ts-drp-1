# D.110c-0c1f5b0u migration activation frontier corrective RED

Tests-only correction: signed/pushed `0c9e56321ea770259c90afe0e2d99d3569320ea7`, atop the accepted plan amendment `9d1278d8a4bec1d7083ecd0037501c5e0ce85c08`. No production change or successful settlement-profile activation is claimed.

The existing migration test still requires startup recovery, queued issue and rehearsal to fulfill. It now requires activation to settle at the current pre-frontier refusal: parent `v3 room migration activation failed: terminal-rejected`, with the exact admitted-sink rejection `v3 room rebase outbox failed: record-rejected`. A selected-test-only transparent sink observer records and rethrows the original exception. Other tests retain the original sink. Existing timeout and at-most-one-owner assertions remain; explicit close additionally requires zero active owners. Successful authenticated-frontier activation remains parent f5b work.

## Isolated causal execution

One fresh detached checkout at the test commit: `/tmp/d110c-f5b0u-migration-frontier-red-VknOZP/checkout`. Overlay: the historical rejected seven-path candidate, SHA256 `1239cf2d5fbbc6e40eebdae4365ba7b8843af1d22586851548a1f995025684c9`, reproduced from the prior migration RED. This is intentionally not the current nine-path GREEN candidate. `identity.json` records both independent source sets and their hashes.

The recorded commands performed offline frozen install, fresh workspace builds, exact one-test/one-file listing, then exactly one selected focused invocation:

```sh
pnpm exec vitest run tests/phase-6b-d110c-0c1f5b0u-room-runtime-red.test.ts -t "queues migration rehearsal" --coverage.enabled=false --reporter=json --outputFile=/Users/aristotle/Documents/Projects/ts-drp-1/.logs/d110c-0c1f5b0u-migration-frontier-red-0c9e5632/reporter.json
```

All setup/build/list commands exited 0. Commands used Node v22.15.0 with `NODE_OPTIONS=--max-old-space-size=8192`, as in the preceding isolated RED setup; this changes no test timeout or product memory contract. Focused command exited 1 without a signal, 2026-09-05T05:57:25.619Z to 05:57:28.511Z. Selected test duration: 512.572 ms. Full reporter: one failed selected test, eight skipped, zero passed, one file. Vitest's aggregate suite counter includes both the file and describe block; it is not a file count. Exact-owner ESLint, Prettier check, and diff check are separately recorded in `static.json`; the isolated package build above supplies the production build/typecheck evidence for this tests-only correction.

The complete four soft failures are:

- `D110C_0C1F5B0U_QUEUED_ISSUE_NOT_RECOVERED`: queued issue rejected instead of fulfilling.
- `D110C_0C1F5B0U_MIGRATION_DID_NOT_RESUME`: rehearsal rejected instead of fulfilling.
- `D110C_0C1F5B0U_MIGRATION_ACTIVATION_BOUNDARY_DIFFERS`: the earlier rejection did not reach the later exact activation refusal.
- `D110C_0C1F5B0U_MIGRATION_FRONTIER_CAUSE_DIFFERS`: no sink rejection was recorded, because the older implementation never reached that frontier.

Thus the pre-GREEN recovery/rehearsal defect remains causal. This run does not demonstrate that the current GREEN candidate reaches the frontier. No loader/import, timeout, fixture-authority, or other unexpected failure occurred. At-most-one-owner and explicit close-to-zero checks passed. No retry or additional workload was run.

## Custody and remaining work

`validate.mjs` checks the exact complete failure matrix, selected title/file, skipped and unexpected counts, top-level errors, six command results, one focused invocation, the signed test bytes, historical overlay, current nine-path candidate, and all 27 stash identities. `manifest.sha256` excludes itself and covers every other evidence file.

The current production candidate remains byte-for-byte at combined SHA256 `4296998368a87e11c7be6fcc8da05583c37d485c96b8f7b1917dd500a7839f61`. No protected path or stash was edited or removed. Existing consumed invocation identities and prior immutable evidence are unchanged. No reviewers were run. GREEN owner must now run the corrected expectation against the current candidate under the existing reviewed gates; no parent-f5b activation capability is inferred.
