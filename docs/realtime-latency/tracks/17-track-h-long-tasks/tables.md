## Runs

| run | bundle | status | test ms | load 1m before | load 1m after | trace tasks | trace max | issue p50 C/R | accept p50/p95 |
|---|---|---|---|---|---|---|---|---|---|
| r1-BASE | BASE | passed | 71216 | 30.66 | 21.83 | 119265 | 520.4 | 87.8/39.9 | 58.5/116.6 |
| r2-H | H | passed | 69174 | 21.83 | 19.24 | 117345 | 518.0 | 76.3/37.8 | 58.1/113.9 |
| r3-H | H | passed | 81626 | 19.24 | 30.63 | 119046 | 513.3 | 88.5/40.5 | 70.7/216.6 |
| r4-BASE | BASE | passed | 76867 | 30.63 | 42.22 | 119007 | 524.7 | 92.4/44 | 65.2/139.5 |
| r5-BASE | BASE | passed | 71506 | 42.22 | 29.88 | 120828 | 531.7 | 88.2/39 | 60.3/123.3 |
| r6-H | H | passed | 71080 | 29.88 | 37.71 | 116030 | 534.7 | 90.7/41.1 | 72.2/130.4 |

## Traced windows: total ms and long tasks (Track H method: renderer-main RunTask overlapping the window)

| window | metric | BASE runs | BASE mean | H runs | H mean | H - BASE |
|---|---|---|---|---|---|---|
| seal t4 (creator) | total ms | 667.1 / 461.9 / 670.7 | 599.9 | 418.4 / 682.3 / 437.1 | 512.6 | -87.3 |
| seal t4 (creator) | max task ms | 24.1 / 26.4 / 26.1 | 25.5 | 17.5 / 17.2 / 18.5 | 17.7 | -7.8 |
| seal t4 (creator) | tasks >16 ms | 1 / 1 / 1 | 1.00 | 1 / 1 / 1 | 1.00 | 0.00 |
| seal t4 (creator) | tasks >50 ms | 0 / 0 / 0 | 0.00 | 0 / 0 / 0 | 0.00 | 0.00 |
| creator adoption t4 | total ms | 645.0 / 728.7 / 783.6 | 719.1 | 688.8 / 682.5 / 733.6 | 701.6 | -17.5 |
| creator adoption t4 | max task ms | 42.4 / 43.2 / 58.3 | 48.0 | 37.7 / 36.7 / 40.3 | 38.2 | -9.7 |
| creator adoption t4 | tasks >16 ms | 2 / 2 / 3 | 2.33 | 3 / 2 / 3 | 2.67 | 0.33 |
| creator adoption t4 | tasks >50 ms | 0 / 0 / 1 | 0.33 | 0 / 0 / 0 | 0.00 | -0.33 |
| recipient install t4 | total ms | 375.9 / 541.9 / 429.0 | 448.9 | 553.3 / 497.8 / 422.7 | 491.3 | 42.3 |
| recipient install t4 | max task ms | 6.8 / 10.5 / 9.1 | 8.8 | 6.9 / 8.6 / 6.8 | 7.4 | -1.4 |
| recipient install t4 | tasks >16 ms | 0 / 0 / 0 | 0.00 | 0 / 0 / 0 | 0.00 | 0.00 |
| recipient install t4 | tasks >50 ms | 0 / 0 / 0 | 0.00 | 0 / 0 / 0 | 0.00 | 0.00 |
| creator lull t5 | total ms | 4028.6 / 3938.1 / 3657.0 | 3874.6 | 2745.9 / 3214.5 / 3095.5 | 3018.6 | -855.9 |
| creator lull t5 | max task ms | 42.2 / 36.0 / 38.6 | 38.9 | 26.5 / 21.2 / 21.5 | 23.1 | -15.9 |
| creator lull t5 | tasks >16 ms | 1 / 1 / 1 | 1.00 | 1 / 1 / 1 | 1.00 | 0.00 |
| creator lull t5 | tasks >50 ms | 0 / 0 / 0 | 0.00 | 0 / 0 / 0 | 0.00 | 0.00 |

## Pair deltas (H - BASE) on traced-window totals, ms

| window | pair 1 (r1-BASE vs r2-H) | pair 2 (r4-BASE vs r3-H) | pair 3 (r5-BASE vs r6-H) | mean of pair deltas | BASE spread (max-min) |
|---|---|---|---|---|---|
| seal t4 (creator) | -248.7 | 220.4 | -233.6 | -87.3 | 208.8 |
| creator adoption t4 | 43.8 | -46.2 | -50.0 | -17.5 | 138.6 |
| recipient install t4 | 177.4 | -44.1 | -6.3 | 42.3 | 166.0 |
| creator lull t5 | -1282.7 | -723.6 | -561.5 | -855.9 | 371.6 |

## All-transition totals (per-run mean over transitions; most transitions are outside the trace), ms

| window | BASE runs | BASE mean | H runs | H mean | H - BASE | pair 1 delta | pair 2 delta | pair 3 delta |
|---|---|---|---|---|---|---|---|---|
| seal t0-7 | 321.6 / 319.3 / 311.1 | 317.4 | 322.3 / 336.8 / 293.9 | 317.7 | 0.3 | 0.7 | 17.5 | -17.2 |
| adoption t0-7 | 561.9 / 620.0 / 580.5 | 587.5 | 545.5 / 617.6 / 596.4 | 586.5 | -0.9 | -16.4 | -2.4 | 15.9 |
| install t0-7 | 354.1 / 421.6 / 354.0 | 376.6 | 395.3 / 399.1 / 425.7 | 406.7 | 30.1 | 41.2 | -22.5 | 71.8 |
| lull t4-8 (maintained) | 3110.6 / 3091.2 / 3032.9 | 3078.2 | 2839.8 / 3332.0 / 2897.3 | 3023.0 | -55.2 | -270.8 | 240.7 | -135.6 |

## Secondary: gameplay latency and test duration (means)

| metric | BASE runs | BASE mean | H runs | H mean |
|---|---|---|---|---|
| testMs | 71216.0 / 76867.0 / 71506.0 | 73196.3 | 69174.0 / 81626.0 / 71080.0 | 73960.0 |
| issue_creator_p50 | 87.8 / 92.4 / 88.2 | 89.5 | 76.3 / 88.5 / 90.7 | 85.2 |
| issue_recipient_p50 | 39.9 / 44.0 / 39.0 | 41.0 | 37.8 / 40.5 / 41.1 | 39.8 |
| accept_p50 | 58.5 / 65.2 / 60.3 | 61.3 | 58.1 / 70.7 / 72.2 | 67.0 |
| accept_p95 | 116.6 / 139.5 / 123.3 | 126.5 | 113.9 / 216.6 / 130.4 | 153.6 |
