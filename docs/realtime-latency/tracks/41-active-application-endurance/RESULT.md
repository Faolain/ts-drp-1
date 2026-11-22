# Active application endurance

The completed **PRE-PERF300-02** campaign ran the shipped Canvas, Grid and Chat
compositions on native SQLite through 300 successor transitions each. Every app
accepted 3,000 operations without a rejected issue attempt, compared exact peer
state every epoch, and reopened both peers from their actual native files at
epoch 150. The [manifest](evidence/pre-perf-300-02/manifest.json), compressed
per-epoch records, test logs and exact source patch preserve that result.

| App | Completed epochs | Accepted operations | Test duration |
| --- | ---: | ---: | ---: |
| Canvas | 300 | 3,000 | 2,366.33 s |
| Grid | 300 | 3,000 | 1,700.67 s |
| Chat | 300 | 3,000 | 2,639.59 s |

The source is `6f414a258998a9da913e638b22a3891241e88829` plus patch SHA-256
`25f03f5aad064464da5416fac6e2e337b830f7cae11f1768e6c7be66e3187449`.
It includes F1/F2, quiet-room repair, H5 and the earlier recovery work, but predates
the retained-replay lifetime fix and later capacity/rejoin changes. These results
must not be attributed to that later combined source.

## What the workload establishes

Two writers each issue two initial operations per epoch. A further four recipient
writes overlap creator seal/adopt and recipient install; each peer also writes
while native maintenance runs. The transport deliberately loses first copies and
replays durable published bytes explicitly. Each app accounts for 600 dropped
source digests through exact acceptance or all durable replacement chunks. Live
settlement entries must retain every referenced original and replacement row.
Canvas checks additive accepted-work conservation, Grid checks the last value of
every bounded slot, and Chat adds an independent whole-window retention oracle
bound to each authenticated successor base.

This schedule observed 598 remote acceptances during maintenance in each app and
**zero during rollover**. Issue-call completion therefore does not establish
receiver progress during rollover. The driver is not an automatic room/network
repair test and carries no ephemeral traffic. Continuous high-rate operation,
real networking, browser WebRTC, rendering and frame-rate claims need separate
evidence.

All three processes ran concurrently on an Apple M1 Max with ten cores; starting
load averages were 7.95/11.30/13.30. Timing distributions in the summaries describe
that workload and host contention, not an isolated latency benchmark.

## Storage evidence and its limit

Retained issuance rows stabilize at 18 for the creator and 54 for the recipient;
both retain seven journal scopes and one settlement plan. Each app ends with 43
physical files. Primary-file totals are constant across the final 25 epochs.
Every actual SQLite file is counted, including snapshot dependency files and
external floor authorities; WAL and shared-memory bytes are reported separately.
Census connections are read-only and issue no checkpoint, vacuum or truncation.

Whole-directory physical totals are **not flat**: all final 25 samples differ,
with roughly 989–993 KB of additional WAL data across that interval. The
recipient signing and floor owners are still filling their ordinary WAL files
after reopen at 150. A read-only investigation of the same source found the
creator floor reaches the default 1,000-frame checkpoint high-water, while these
slower owners remain below it before reopen. Their bytes remain charged in the
result. A final campaign must reopen earlier, leaving more than 250 uninterrupted
epochs, or extend the horizon; manually checkpointing would erase the behavior
being measured.

## Earlier evidence and harness review

PRE-PERF300-01 ended when its owning agent turn cleaned up the child processes;
its completed prefixes were Canvas 156, Grid 221 and Chat 139. It is interrupted
evidence, not a product failure or a completed campaign. Its raw files remain at
`/private/tmp/active-endurance-preperf-300-01/`.

The earlier 18-epoch reopen smoke preserved exact state but selected create mode
for the suffixed issuance, journal and snapshot files. The corrected nine-epoch
smoke at `/private/tmp/active-endurance-census-smoke-05/` and this 300-epoch campaign
select explicit reopen mode on those actual files.

Independent review found the suffix-selection issue and a second harness defect:
a background stream rejection could remain unobserved while rollover was pending,
or cleanup could begin before that stream joined. The corrected driver observes
all branches immediately and joins them before propagating failure. Three focused
controls cover failed-stream/held-rollover, failed-rollover/held-stream and failed
maintenance with another native lull and writer still in flight. The original
driver reproduces assertion failures and an unhandled rejection; the correction
passes. This failure-handling correction is subsequent to the named campaign and
does not alter its recorded source.
