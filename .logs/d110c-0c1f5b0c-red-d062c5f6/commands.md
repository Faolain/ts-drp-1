# Commands and results

All commands ran from
`/Users/aristotle/Documents/Projects/ts-drp-1` unless stated otherwise.

## Accepted focused RED

```sh
pnpm vitest run /Users/aristotle/Documents/Projects/ts-drp-1/tests/phase-6b-d110c-0c1f5b0c-room-red.test.ts --reporter=json --outputFile=/tmp/d110c-0c1f5b0c-room-red-accepted.json
```

Expected nonzero RED. The reporter records `success=false`, one selected file,
nine tests, one pass, eight failures, and zero pending tests. See
`focused-vitest.json` and `matrix.md`.

## Mechanical checks

```sh
pnpm exec eslint /Users/aristotle/Documents/Projects/ts-drp-1/tests/phase-6b-d110c-0c1f5b0c-room-red.test.ts
pnpm exec prettier --check /Users/aristotle/Documents/Projects/ts-drp-1/tests/phase-6b-d110c-0c1f5b0c-room-red.test.ts
git diff d062c5f6^ d062c5f6 --check
```

All three exited 0. Their stdout/stderr streams are retained separately.

```sh
git diff-tree --no-commit-id --name-only -r d062c5f6
```

Printed exactly:

```text
tests/phase-6b-d110c-0c1f5b0c-room-red.test.ts
```

```sh
shasum -a 256 -c manifest.sha256
```

Run in `.logs/d110c-0c1f5b0r-design-3a156aca`; exited 0 and verified
`design.md`, `pre-review.md`, and `next-prompt.md`.

## Rejected fixture diagnostics

Before the single accepted causal result, four reporters exposed test-fixture
defects. They are preserved to distinguish harness correction from product RED:

1. `diagnostic-01-invalid-parameters.json`: the fixture supplied non-canonical
   one-byte parameters and all nine tests stopped at canonical decoding.
2. `diagnostic-02-node-mock-resolution.json`: the Node mock did not intercept
   the room's resolved import and trust-open failed before orchestration.
3. `diagnostic-03-storage-mock-resolution.json`: the storage mock did not
   intercept the room's resolved import and the harness attempted real
   IndexedDB initialization.
4. `diagnostic-04-assertion-dereference.json`: orchestration was reached, but
   one RED assertion dereferenced an absent `planEffect` instead of asserting
   its absence directly.

Each fixture defect was corrected without production changes. Only
`focused-vitest.json` is the accepted causal RED.

