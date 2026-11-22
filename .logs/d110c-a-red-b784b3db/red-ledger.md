# D.110c-a deterministic RED ledger

Base: signed/pushed `b784b3db724002f053d05d7c40024f21fb297126`.

## Runtime RED

Command (executed once):

`pnpm exec vitest run tests/phase-6b-d110c-a-repeat-close-red.test.ts --reporter=json --outputFile=.logs/d110c-a-red-b784b3db/runtime-vitest.json`

- The reporter selected exactly one result file and one test. The JSON reports one passed test, zero failed/pending/todo tests, zero failed suites, and `success:true`.
- The genuine retained path created epoch 0, issued work, closed/adopted/activated epoch 1, issued and published post-adoption work, then called the real epoch-1 close exactly once.
- The asserted first terminal cause was exactly `LinearizationError`, code `INVALID_ANCHOR`, message `previous history snapshot does not match the authenticated anchor`.
- The exact durable head and references were unchanged. Status moved from active to sealed without terminal authority loss. The adoption probe remained `sealed-live-unavailable`; the caller-held room head remained epoch 1; replacement activation count and provider presence remained zero.
- Runtime imports were asserted as the source `packages/node/src/creator-close.ts` and refreshed built `packages/storage-node/dist/src/index.js`; Node identity equaled `process.version`.
- Shell status was 1 solely because the root Vitest configuration applied its global 70% coverage threshold to this one-file focused selection (17.42%). The reporter JSON itself is semantically successful and contains no test failure. The genuine path was not rerun to cosmetically change this unrelated epilogue.

## Type RED

Accepted command:

`pnpm exec tsc --project tests/fixtures/phase-6b-d110c-a/tsconfig.json --pretty false`

The accepted diagnostic set is confined to the frozen exported shape: the two fields are not exactly `number`, the genuine 1→2 assignment is rejected by the literal epoch, and later epoch 3 is rejected. The exact key roster and epoch-0 compatibility compile.

An earlier diagnostic invocation was invalid because the new private config accidentally enabled `exactOptionalPropertyTypes`, creating unrelated Node-source errors. That tests-only config mistake was removed; it is preserved in `typecheck-invalid-config.txt` and is not classified as a code failure or accepted RED.

## Scope

Only the new focused test and private fixtures/config changed. Production, examples, dependencies, wire/schema, thresholds, and completed evidence are untouched. The demonstrated product owner remains the empty `previousHistorySnapshot` in `packages/node/src/creator-close.ts`; the authenticated prior accumulator already exists in the adopted projection.
