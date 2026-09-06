# Accepted causal matrix

| Class | Count | Result |
| --- | ---: | --- |
| Selected | 39 | exact original + corrective files |
| Passed | 25 | controls and already-GREEN obligations |
| Product-causal RED failures | 14 | expected, unchanged roster |
| Skipped/todo | 0 | none |
| Top-level errors | 0 | none |

The published-row RED still fails after removing the nonexistent
`publishState` fields, proving that the intended production-visible sequence-
zero behavior—not a response-shape mismatch—remains missing. The legacy join
RED still receives sequence one with the exact digest but empty intents, so it
continues to detect the candidate production regression directly.

