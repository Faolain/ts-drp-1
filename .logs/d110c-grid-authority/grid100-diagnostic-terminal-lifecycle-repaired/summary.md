# Completed grid diagnostic; memory acceptance remains open

The run completed naturally with exit zero, exact source custody and no remaining
processes. The [command](./command.json) fixes the inputs and unchanged limits;
the [terminal status](./status.json) and [raw telemetry](./stdout.log) are the
authoritative evidence. Elapsed wall time was 1,553,910.940541 ms.

All diagnostic correctness/recovery assertions passed: 64 active writers,
100 genuine transitions, 6,464 contributions across the initial and successor
epochs, 200 recovered sources, ten creator restarts and final cold reopen.
The final reopen preserved exact world/authority and issued/published nothing
twice. The final world was 10,403 bytes; 394 durable issuance rows remained.
The last ordinary transition had 395 rows, followed by final accounting with no
retained recovery sources or observer commits. There were 101 memory samples.

## Memory boundary

| Measurement                       | Bytes or bytes per sampled epoch |
| --------------------------------- | -------------------------------: |
| Peak heap used                    |                      188,036,400 |
| Peak array buffers                |                      168,161,346 |
| Peak heap plus array buffers      |                      354,150,122 |
| Peak RSS                          |                      979,697,664 |
| Final heap plus array buffers     |                      351,417,433 |
| Last-32-sample heap slope         |               781,111.1715542522 |
| Last-32-sample array-buffer slope |             1,476,810.5163123168 |
| Last-32-sample owned-byte slope   |              2,257,921.687866569 |
| Reference owned-byte ceiling      |                      512,000,000 |
| Reference slope limit             |                          165,161 |

Every sample followed GC. The reference owned-byte ceiling was not exceeded;
the slope is about 13.67 times its reference. This is explicitly **not memory
acceptance**. RSS is a different measure and is not compared to the owned-byte
ceiling. Aggregate process memory includes test-backend persisted data and
instrumentation; it cannot establish product-retained heap by itself.

The production snapshot quarantine retains data for 24 hours and sweeps at
scope opening. That is a source-grounded candidate contribution to this short
in-memory-backend run, not an observed allocation attribution. The next memory
check must separate persisted bytes from live product/harness retention.

The dependency repair removed a demonstrated terminal-transaction retaining
owner: at 22 transitions this run used 173,978,312 aggregate owned bytes,
versus 1,972,159,759 in the prior stopped attempt. Neither this comparison nor
the successful diagnostic supersedes the remaining memory-acceptance work.

After the run, only the independent lifecycle probe was converted to native
typed source and reverified. Its original source is preserved in the adjacent
untyped baseline archive. No workload/production input was changed by that
conversion, and this run's original command/status files are unchanged.
