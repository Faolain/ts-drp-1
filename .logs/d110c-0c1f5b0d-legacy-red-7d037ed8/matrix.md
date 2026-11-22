# Causal matrix

| Case | Expected legacy contract | Current RED result | Meaning |
| --- | --- | --- | --- |
| Distinct sequences 0 through 8,191 | all accepted | pass | The existing function admits one complete `maxEpochVertices` window. |
| Duplicate sequence 8,191 | accepted without increment | pass | Duplicate accounting remains idempotent. |
| New sequence 8,192 | refused | fail: returned `true` | The rejected GREEN's global `maxEpochVertices * 3` behavior expands `creator-trusted-v1` beyond its frozen one-window bound. |
| Other retained reclamation cases | unchanged | 18 total focused passes including controls | The corrective RED introduces no second causal failure. |

The complete reporter is `focused.json`. The sole failure carries exact token
`D110C_0C1F5B0D_LEGACY_HISTORICAL_SCAN_EXCEEDS_ONE_EPOCH_WINDOW`.

This matrix is deliberately unit-level. It does not claim that an 8,193-row
genuine recovery path is reachable before parent f5b settlement integration.
