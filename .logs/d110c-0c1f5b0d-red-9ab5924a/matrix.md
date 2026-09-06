# Causal matrix

| Cases                                         | Existing result | RED meaning                                                                                    |
| --------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------- |
| Exact D.110c-c handoff roster                 | 1 pass          | Journal, snapshot, seal-evidence and AHE scope retirement stay out of f5b0d.                   |
| Storage-neutral authenticated owner           | 1 failure       | The four maintenance owners do not yet implement `pruneAuthenticatedSettledPrefix`.            |
| Absent durable plan                           | 3 failures      | Memory, browser and Node legacy pruning delete instead of returning `ISSUANCE_RETRY_REQUIRED`. |
| Null fence / incomplete required plan state   | 3 failures      | All three stores delete instead of returning `ISSUANCE_RETRY_REQUIRED`.                        |
| Unlinked entry outside selected prefix        | 3 failures      | The existing range-local plan gate ignores a globally incomplete plan.                         |
| Manual-review entry outside selected prefix   | 3 failures      | The existing range-local gate ignores unresolved manual review.                                |
| Complete mixed-epoch pending/published prefix | 3 failures      | The old API rejects the first prior-epoch row; authenticated terminal pruning is absent.       |
| Node mid-transaction deletion fault           | 1 pass          | Both row tables and the watermark roll back; no partial deletion survives reopen.              |
| Real production cleanup invocation            | 1 failure       | `v3-live.ts` has no authenticated settled prune behind `planClosedEpochCleanup`.               |
| Remove raw one-epoch historical cap           | 1 failure       | `countHistoricalIssuanceRow` still compares directly to `maxEpochVertices`.                    |
| Install bounded replacement cap               | 1 failure       | The scan has neither rollback-window multiplication nor a settled-watermark start.             |

Total: 21 selected, 2 passed, 19 failed, 0 skipped. The full reporter result is
`focused.json`.

The plan failures use the frozen expected code `ISSUANCE_RETRY_REQUIRED`. The
current implementation succeeds, so the captured error code is `undefined`.
The successful-prefix failures throw the current exact diagnostic `selected
issuance row belongs to another epoch`. The production and recovery failures
carry the exact D.110c-0c1f5b0d assertion tokens recorded in the test.
