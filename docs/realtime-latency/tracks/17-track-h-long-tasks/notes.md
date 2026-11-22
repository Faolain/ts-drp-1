# Track H working notes (not REPORT.md)

Paired traced bench lt-p (1 pair, LULL=1, TASK_TRACE=window), base lt-base2 vs fix lt-fix4
(lt-fix4 = final patch + a generationId-keyed priority memo since removed for a source-shape test; ~1% of task A).

| window (creator unless noted) | base max / >16 / >50 | fix max / >16 / >50 |
|---|---|---|
| seal t4 | 28.0 / 1 / 0 | 18.2 / 1 / 0 |
| adoption t4 | 46.8 / 3 / 0 (16.8, 46.8, 43.5) | 41.4 / 3 / 0 (17.2, 41.4, 24.2) |
| install t4 (recipient) | 9 / 0 / 0 | 9 / 0 / 0 |
| pool maintenance lull t5 | 36.8 / 1 / 0 | 20.2 / 1 / 0 |
| recipient lull t5 | 12 / 0 / 0 | 12.6 / 0 / 0 |
| ordinary moves t5 | 6 (creator) / 2 (recipient) | 6 / 2 |

Totals t4: seal 411.0 vs 485.3; adoption 723.7 vs 985.6 (busy 541 vs 537); install 475.6 vs 555.8; lull t5 2920 vs 4296.
issue creator p50 96.0 vs 93.3; recipient p50 45.7 vs 43.1; remote accept p50 74.6 vs 65.4, p95 140.6 vs 120.3.
