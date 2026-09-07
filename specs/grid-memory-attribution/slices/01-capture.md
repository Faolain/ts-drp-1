# Capture contract

Extract the complete assertion-bearing grid diagnostic into a test-only runner
with fixed 100/30 consumers. Preserve deterministic fixture identity, workload,
displacement/recovery and restart schedule. The epoch body returns scalar facts
before observational work starts; do not retain its current/checkpoint payloads.

The profiling hook runs after observer release and follower reopen, with readonly
database census completed before settled GC. Capture in the actual workload
worker at completed transitions 10, 20, and 30, exactly once each. Final recovery
accounting is a distinct observation, not a duplicate snapshot. Persist scalar
memory, storage and live-owner summaries each transition. Snapshot output must
stream to exclusive files, preserving partial artifacts on failure and recording
worker/runtime identity, hash and capture overhead.

Before capture, verify missing-GC failure, checkpoint selection, scalar-only
outputs, physical-row accounting, explicit unknown classifications, exclusive
files, and failure preservation. Audit unchanged 100-entrypoint assertions and
fixture lifecycle. The runnable artifact is a separate opt-in Vitest diagnostic;
never treat profiling timing or its memory peak as acceptance.
