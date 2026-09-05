# Root read-only reporter check correction

The first root raw-reporter audit incorrectly expected per-assertion status
`pending` for the 17 filtered tests. Vitest records those assertions as
`skipped`, while the summary field is named `numPendingTests`. The check exited
1 with `Error: matrix`; it did not execute a test or find a code/evidence
failure. Direct inspection found two files, 45 assertions, 5 passed, 23 failed,
17 skipped, and summary numPendingTests=17. The corrected audit uses the actual
per-assertion schema and otherwise preserves its checks. The test was not rerun.
