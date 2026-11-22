# Grid memory attribution

## Next Agent Prompt

The subsequent [native-browser lifecycle audit](../grid-memory-production/lifecycle-audit.md)
is now the starting point for retention work. It establishes the missing
whole-storage retirement contract and the local snapshot-expiry recovery boundary;
the earlier heap/backend distinction does not resolve those product concerns.

The [longer-horizon investigation](slices/05-growth-horizon.md) has completed its
extended capture, retention audit and separate post-return idle observation.
Start from its [canonical outcome](../../.logs/grid-memory-attribution/capture60-growth/outcome.md),
which distinguishes sustained database accumulation from the smaller uneven V8
remainder and RSS reclamation. Any follow-up cleanup must first establish the
retention/recovery eligibility contract; a store name or closed-epoch label does
not authorize deletion. Memory acceptance remains open. Preserve historical
evidence and workload/retention/acceptance invariants.

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

The follow-up [provenance slice](slices/04-residual-provenance.md) now has a
completed fresh sampling capture on the original runtime. Its
[canonical outcome](../../.logs/grid-memory-attribution/capture30-allocation-sampled/outcome.md)
reconciles the new complement, identifies representative compiled functions and
V8 metadata retaining paths, and separates statistical allocation-stack leads
from exact heap ownership. The code/metadata-dominated pattern is reproduced;
eventual reclamation and a new lifecycle defect are not established. Exact
tracking failed or was interrupted; those preserved attempts are linked from
the outcome, not treated as accepted captures. Sampling IDs cannot be joined to
snapshot objects. Do not turn its function estimates into exact residual-byte
attribution or compare separate captures by numerical subtraction.
Keep the project's default runtime unchanged.
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
Profiling pauses and allocates; its timing is not acceptance evidence. Stored
rows and heap ownership must agree before attributing growth; neither alone
establishes cleanup eligibility under the actual retention/recovery policy.

## Review boundaries

Review assertion/lifecycle equivalence and instrumentation retention before the
bounded run. Review root-chain evidence before authorizing any cleanup. Keep
regression authors separate from production fix authors, then independently
review the integrated fix before the full diagnostic. No broad governance work
or unrelated campaign is a dependency.

The primary API references are [Node V8](https://nodejs.org/docs/latest-v22.x/api/v8.html),
[process memory](https://nodejs.org/docs/latest-v22.x/api/process.html#processmemoryusage),
and [HeapProfiler](https://chromedevtools.github.io/devtools-protocol/v8/HeapProfiler/).
