# Slice E4-01: Loss-Tolerant Entity Deltas

## Contract

Losing one unreliable entity packet cannot poison all later projection. The
receiver either applies a complete state transition or waits for a bounded
keyframe without partial mutation.

## API seam

Add sender/receiver codecs to `@ts-drp/aoi`. Every packet binds generation,
batch ID, sequence, base keyframe ID/sequence, keyframe flag, chunk index, chunk
count and bounded entity records. Deltas refer to the latest completely
installed keyframe rather than the immediately prior delta. Emit a complete
bounded keyframe at least once per second at 30 Hz. Split packets below E3's
route-exposed `maxPayloadBytes`; do not copy the 1,200-byte routed-envelope
constant into the codec.

The receiver buffers a bounded batch and applies it atomically only after every
chunk arrives with identical generation, batch, base, kind and chunk-count
metadata. A missing or inconsistent chunk leaves projection unchanged and waits
for the next bounded keyframe. Cap simultaneous assemblies, chunks, aggregate
bytes and assembly lifetime; expire stale partial batches deterministically.
The codec owns batch/chunk ordering, deduplication and replay within the current
E2 authority generation; it does not depend on the ephemeral latest-wins
watermark.

Reject missing bases, stale generation/sequence, duplicate entity handles,
malformed/truncated records, unsafe coordinates and over-limit batches. A
rejection does not mutate receiver state.

## TDD and acceptance

Fuzz malformed bytes and deterministic 30% loss/reordering schedules. Prove
keyframe recovery, enter/update/leave behavior, permutation determinism, exact
packet cap, lost first/interior/last chunk, conflicting batch metadata, bounded
stale cleanup, and no partial mutation. Target: <10 seconds.

## Human surface

Show receiver generation, base and last sequence plus a visible “waiting for
keyframe” state in the existing workbench. Run screenshot critique and the
non-blocking preview window; visual polish is not the slice variable.

## Must stay green

AOI selection, E3 authority/transport, and zero durable movement.

## Feedback that changes this slice

Only evidence that the keyframe cadence or packet cap cannot meet the later
bandwidth target.
