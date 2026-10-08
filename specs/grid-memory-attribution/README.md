# Grid memory attribution

## Next Agent Prompt

The bounded attribution pass and final unprofiled diagnostic are complete;
memory acceptance remains open. The confirmed growing owner was Vitest's
expected-rejection callback registry, not a product lifecycle leak. Scalar
assertions eliminate that path; original fixture callbacks remain bounded.
Current persisted database subgraphs explain most measured snapshot growth.
The full rerun passed correctness, recovery and final cold reopen, with exact
source custody and matching epoch digests. Aggregate owned-byte slope improved
but still exceeds its reference. See the [evidence report](../../.logs/grid-memory-attribution/summary.md)
for measured deltas, remaining unexplained growth, review scope and preserved
failures; it is the canonical home for run-specific results.

The next action is to attribute the remaining non-database graph-growth delta
from the preserved paired snapshots before authorizing another cleanup or run.
Do not modify historical evidence or change heap limits, assertions, identities,
retention policy or memory thresholds to obtain acceptance.

- [x] Verify shared workload and scalar capture contract; collect one bounded run.
- [x] [Attribute](slices/02-attribution.md) the confirmed growing owner and persisted subgraphs; report residual uncertainty.
- [x] [Verify](slices/03-verification.md) confirmed fixes and the unchanged full workload.

## Ownership and evidence

One test-only runner owns workload assertions. Fixed profiling and unprofiled
entrypoints consume it; they must not become parallel workload implementations.
The profiler owns only scalar summaries and file handles. Storage census reads
existing physical rows through readonly cursors, closes its connections, and
releases its frame before GC. No historical strong-owner registry is permitted.
Expected failures are asserted from a scalar rejection result: handing the error
or its promise to an async matcher can retain its lazy stack and room context in
the test-end callback registry. The causal control pins this installed-framework
behavior. Bounded original projection callbacks remain explicit harness overhead.

Logical payload bytes describe stored content, not V8 retained size. Array-buffer
memory is included in external memory; RSS is a separate process envelope.
Never sum overlapping memory categories or subtract serialized bytes from heap.
Current-owner census cannot prove that retired owners are unreachable.
Returning a room is not a startup-recovery completion signal. Profiling joins the
original room-owned startup promises before collecting owner scalars or opening
census transactions; it does not issue, retry, drain, or close anything to obtain
a measurement. The weak-key diagnostic lookup cannot own historical sessions.
This preparation is absent from the unprofiled entrypoint. Its scheduling and
sampling differences must remain explicit when comparing diagnostic samples.
The post-reopen guard does not apply to final accounting: ordinary issuance can
legitimately add causal-join controls after the initial author fences.
The fixture inventory includes the creator's primary seal-vote/evidence database
as well as each peer's related storage databases. Queue-manager depth is not yet
exposed; gate-presence counts must not be interpreted as queue depth.

On the pinned Node 22 toolchain, V8's snapshot readable emits `end` without
`close`. Generic `pipeline` therefore waits indefinitely; the recorder uses the
destination's `finish` event followed by fsync and descriptor closure. The failed
smoke and successful corrected smoke are preserved separately. This changes
instrumentation completion tracking, not product lifecycle cleanup.

The analysis helper uses isolated, pinned MemLab rather than loading heap graphs
into the workload. Its small ownership control verifies exclusive/shared payloads,
strong paths in the presence of weak references, and live/dead-key ephemerons.
Top-node reports guide investigation; they are not exhaustive leak attribution.

The causal chain is: shared capture contract → bounded snapshots → root-path
attribution → confirmed-owner RED/GREEN → unprofiled full verification.
Profiling pauses and allocates; its timing is not acceptance evidence. Quarantine
retention is a hypothesis until the stored rows and actual heap paths agree.

## Review boundaries

Review assertion/lifecycle equivalence and instrumentation retention before the
bounded run. Review root-chain evidence before authorizing any cleanup. Keep
regression authors separate from production fix authors, then independently
review the integrated fix before the full diagnostic. No broad governance work
or unrelated campaign is a dependency.

The primary API references are [Node V8](https://nodejs.org/docs/latest-v22.x/api/v8.html),
[process memory](https://nodejs.org/docs/latest-v22.x/api/process.html#processmemoryusage),
and [HeapProfiler](https://chromedevtools.github.io/devtools-protocol/v8/HeapProfiler/).
