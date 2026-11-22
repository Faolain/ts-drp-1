# D.110c-0c1f5b0b canonical legacy-control RED

Signed tests-only commit `4543b9575add610532142f80d90fbf00886972db`
adds the established singleton-intent metadata (`operationCount: 1` and
`operationIndex: 0`) to the retained legacy `creator-trusted-v1`
`causalJoin` expectation. No production, plan, dependency, settlement-profile,
or timeout behavior changed.

The Phase-3g retained file ran once on the unchanged production baseline. It
selected 14 tests: 13 passed and exactly the canonical legacy `causalJoin`
case failed because current production returned an empty intent list. There
were no missing imports, missing exports, setup failures, skips, or top-level
errors.
