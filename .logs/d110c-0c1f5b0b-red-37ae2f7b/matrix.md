# Accepted causal matrix

| Class | Count | Result |
| --- | ---: | --- |
| Selected | 39 | exact two files |
| Passed | 30 | controls and already-GREEN obligations |
| Product-causal RED failures | 9 | expected |
| Skipped/todo | 0 | none |
| Top-level errors | 0 | none |

The nine causal failures are:

1. legacy causalJoin sink delivery and blueprint fold membership;
2. legacy join application-visible displacement under the genuine registered
   chat ABI;
3. legacy pending non-creator sequence-zero displacement;
4. settlement published non-creator sequence-zero displacement;
5. settlement issued/outbox mismatch corruption refusal;
6. terminal outcome-unknown latching;
7. typed refusal of non-array settlement-plan entries;
8. typed refusal of an accessor-backed settlement plan;
9. typed refusal of a settlement plan with a top-level extra key.

Both sequence-zero profiles execute as independent Vitest cases. The separate
creator-bootstrap control passes and selects sequence one by its distinct
authenticated digest, preventing a future fix from satisfying the RED by
blindly exposing or dropping every sequence-zero row.
