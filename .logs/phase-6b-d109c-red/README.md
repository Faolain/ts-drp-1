# D.109c deterministic RED evidence

The accepted plan anchor is `7113f762daad7392878fea529c01dc9a6729ab04`.
The final focused Vitest run selected two files and 38 tests: six controls
passed, the exact shared and Node readiness assertions failed, and 30 semantic
tests skipped. The focused Chromium run selected one file and four tests: the
exact browser readiness assertion failed, three semantic tests skipped, no
test was flaky, and there were no top-level errors. The five-file retained
selection discovered 53 tests, selected and passed 15, filtered 38, and failed
none.

The first focused Vitest attempt is retained as an invalid diagnostic. Its
memory-facade control inspected prototype helpers as though they were public
facade keys, producing a third failure. The corrected source-shape assertion
checks the frozen 12-key public facade directly; the final focused run then
contained only `D109C_SHARED_MAINTENANCE_MISSING` and
`D109C_NODE_MAINTENANCE_MISSING`. This correction changed no product source or
semantic acceptance.

The Playwright reporter, stdout, stderr, `.last-run.json`, and the complete
failure attachment are retained below this directory. Product-source and
package/lockfile diff custody was clean. ESLint, Prettier, child syntax, and
`git diff --check` passed. The four authorized live export-census amendments
passed at RED. All nine new paths are tests, fixtures, or test configuration.

No retained campaign, reviewer, Fable invocation, collaboration subagent, or
production-source change occurred during RED. Protected paths remained
present, all 26 inherited stashes remained present, the fixed ports were clear,
and no conflicting ts-drp reviewer/test/profiler process was active.
