# Longer-horizon growth and retention

Distinguish three questions: which persisted stores grow, whether their retention
matches an actual policy, and whether the smaller non-database representation
growth continues after warm-up. A store or closed-epoch label alone cannot
establish deletion eligibility. Keep logical content, heap-graph ownership and
process counters as separate ledgers.

## Bounded contracts

First audit the preserved census by store, epoch and retention state. Reconcile
signed row/content changes, preserve unknown and shared classifications, and
follow the largest growing stores to their policy and maintenance code. Do not
implement cleanup from an aggregate slope.

Next extend the existing profiler with one immutable capture plan. The shared
workload accepts the longer target without changing its body or assertions.
Plan-derived boundaries own capture selection, recorder start/stop, terminal
validation and completion. The original shorter plan remains unchanged.

The primary longer capture disables allocation recording and optimization
tracing. Its snapshot schedule includes a warmed baseline, the old horizon and
two equal late intervals; ordinary post-GC counters and readonly census remain
available at each transition. This reduces instrumentation but does not make
the capture uninstrumented. Compare windows within this run, never subtract
historical captures as if they were interchangeable.

A distinct post-workload idle observation follows the final cold-reopen
assertions and precedes test cleanup. It only waits and measures after GC; it
does not close rooms, issue, retry, prune or clear observers. Label the changed
ownership scope explicitly: post-return samples are not additional transitions
and are not part of the transition growth regression. No claim of universal
background inactivity follows from waiting alone.

## Verification and outcome

Pin default-plan behavior, longer ordering/terminal/completion, invalid targets,
capture-once, recorder endpoint cleanup, idle ordering/failure and scalar-only
ownership. Retain startup, custody, snapshot-error and workload-equivalence
controls. Independently review the integrated instrumentation before the full
run. Preserve original runtime, heap limit, identities, retention policy and
thresholds, and retain failed/partial evidence without relabeling it a pass.

After a valid bounded run, verify artifact and source custody, compare all
adjacent heap partitions and equal-width late slopes, and reconcile census
changes against the policy audit. Report sustained growth, deceleration or an
observed finite plateau separately for each owner/representation. None proves
eventual boundedness or memory acceptance. Any confirmed lifetime violation
requires a separate causal regression and reviewed fix.
