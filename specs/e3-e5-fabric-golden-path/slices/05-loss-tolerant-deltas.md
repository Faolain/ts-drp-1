# Slice E4-03: Loss-Tolerant AOI Projection

## Reconciliation

Signed E4-01 (`f57afdd3`) established deterministic nearest-32 selection and a
fixed 514-byte AOI batch. Signed E4-02 (`55d8eecf`) established authorized,
connected-recipient targeting and routed-byte accounting. Neither commit added
generation, keyframe, delta, chunk assembly or recovery state. They are
prerequisites for this slice, not its closure.

## Contract

Losing one unreliable entity packet cannot poison all later projection. The
receiver either applies a complete state transition or waits for a bounded
keyframe without partial mutation.

## API seam

Add one sender/receiver projection owner to `@ts-drp/ephemeral`; do not create a
second AOI package or authority. Every packet binds generation,
batch ID, sequence, base keyframe ID/sequence, keyframe flag, chunk index, chunk
count and bounded entity records. Deltas refer to the latest completely
installed keyframe rather than the immediately prior delta. Emit a complete
bounded keyframe at least every 30 batches at 30 Hz. Split packets below the
effective payload capacity exposed by the existing E3 route; do not copy the
routed-envelope constant into the projection owner.

The receiver buffers a bounded batch and applies it atomically only after every
chunk arrives with identical generation, batch, base, kind and chunk-count
metadata. A missing or inconsistent chunk leaves projection unchanged and waits
for the next bounded keyframe. Cap simultaneous assemblies, chunks, aggregate
bytes and assembly lifetime; expire stale partial batches deterministically.
The codec owns batch/chunk ordering, deduplication and replay within the current
E2 authority generation; it does not depend on the ephemeral latest-wins
watermark. E2 remains the sole admission authority. The zone supplies only the
current authenticated authority generation and already-authorized bytes; the
projection owner cannot authorize a sender or recipient.

Reject missing bases, stale generation/sequence, duplicate entity handles,
malformed/truncated records, unsafe coordinates and over-limit batches. A
rejection does not mutate receiver state.

## Wire and resource contract

Version 1 uses a 25-byte big-endian header followed by fixed 17-byte records.
The header is `version:u8`, `kind:u8`, `generation:u32`, `batchId:u32`,
`sequence:u32`, `baseKeyframeId:u32`, `baseKeyframeSequence:u32`,
`chunkIndex:u8`, `chunkCount:u8`, `recordCount:u8`. Kind 1 is keyframe and kind
2 is delta. Each record is `operation:u8`, `entityId:u32`, `entitySequence:u32`,
`x:i32`, `y:i32`; operations are upsert 1 and leave 2, with canonical zero
coordinates for leave. Integers are bounded and no ambient JSON, typed-array
coercion or host endianness is authority.

At most 32 chunks, four simultaneous assemblies, 32 KiB buffered bytes and one
second of assembly lifetime are retained per receiver. A keyframe binds itself
as its base. These limits are protocol constants exported by the sole owner.
The sender output is a detached packet list; receiver state and returned
snapshots are detached from caller-owned carriers.

## TDD and acceptance

The tests-only RED owns exactly these new paths:

- `packages/ephemeral/tests/aoi-projection-e4-03-red.test.ts`;
- `tests/e4-03-zone-aoi-recovery.pw.ts`;
- `playwright.e4-03-zone-aoi-recovery.config.ts`.

Only the absent production owner fails in RED; the full semantic matrix and
browser recovery case are dormant until GREEN. GREEN may change only the new
`packages/ephemeral/src/aoi-projection.ts`, the existing ephemeral public index,
the zone composition, renderer and workbench HTML. It must not change network,
node, durable-room or RED-test owners.

Fuzz malformed bytes and deterministic 30% loss/reordering schedules. Prove
keyframe recovery, enter/update/leave behavior, permutation determinism, exact
packet cap, lost first/interior/last chunk, conflicting batch metadata, bounded
stale cleanup, and no partial mutation. Target: <10 seconds.

The browser control uses three genuine zone clients and the existing raw route.
It proves one observer waits without partial mutation after deterministic loss,
then converges on the next complete keyframe; a nonrecipient remains unchanged,
movement/AOI contributes zero durable vertices, and a durable `placeBlock`
control still converges after reconnect. This is recovery evidence, not the
full 128-entity bandwidth claim.

## Human surface

Show receiver generation, base and last sequence plus a visible “waiting for
keyframe” state in the existing workbench. Run screenshot critique and the
non-blocking preview window; visual polish is not the slice variable.

## Must stay green

AOI selection, E3 authority/transport, and zero durable movement.

## Feedback that changes this slice

Only evidence that the keyframe cadence or packet cap cannot meet the later
bandwidth target.
