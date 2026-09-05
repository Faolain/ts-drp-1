# Final retained RED matrix

| Gate | Selected | Passed | Failed | Skipped | Exit | Disposition |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Baseline Phase-3g file | 14 | 13 | 1 | 0 | 1 | causal RED on empty intents |
| Prior candidate GREEN | 14 | 13 | 1 | 0 | 1 | superseded stale completion expectation |

Baseline RED failed only at the exact response assertion because production
returned `intents: []`. The expected author, author sequence 1, authenticated
source digest, logical time, `causalJoin` operation, operation count 1, and
operation index 0 remain pinned.

The prior candidate-GREEN reporter reached the completion assertion after
satisfying that exact intent shape. Its actual completion was `undefined`,
which is the accepted fixture contract because nonempty intents are not passed
to `completeRebaseSource`.
