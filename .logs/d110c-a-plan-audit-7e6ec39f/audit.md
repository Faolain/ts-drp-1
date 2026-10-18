# D.110c-a bounded repeat-close source audit

Audit anchor: signed/pushed D.110c-0b0 closure
`7e6ec39f7ecebee3eab630e90e9c08b964752afe`.

## Demonstrated seam

1. `packages/node/src/creator-close.ts` always calls
   `deriveCloseSetHistoryCommitment()` with a newly empty
   `CompactMerkleAccumulator` snapshot. That is correct only for epoch 0. A
   genuine adopted epoch-1 anchor already authenticates a nonempty history root
   and size, so its real repeat close fails the compaction verifier with
   `INVALID_ANCHOR` before seal/QC production.
2. The required accumulator is not absent from durable product state.
   `packages/node/src/creator-adoption.ts` stores the genuine first close's
   `historySnapshot` as `compactHistory` in the authenticated successor
   projection. `packages/node/src/v3-live.ts` authenticates that projection's
   object, epoch, anchor, blueprint, parameters, profile, signer set, catalog,
   vertex count, byte charge, digest, closure membership, and current trust, but
   does not validate or retain `compactHistory` in the private prepared/live
   registration.
3. The existing private creator-close registration is already the narrow owner
   seam. A genuine creator successor activates as `mode:"genesis-active"`, has
   latched ACL authority, strict AHE storage, an authenticated current trust and
   anchor preimage, and can satisfy `creatorCloseRegistration()`. No new root
   export, wire field, store, dependency, or product API is needed to carry a
   validated accumulator snapshot from that registration into creator close.
4. The exported `CreatorLiveCloseResult` and the object returned by
   `bindCreatorLiveClose()` still hardcode `epoch:0` and `successorEpoch:1`.
   Repeat close therefore requires the already-declared public-contract widening
   to safe nonnegative numbers with the exact relation
   `successorEpoch === epoch + 1`. The key roster and epoch-0 runtime values can
   remain unchanged.
5. Same-handle duplicate close and stale predecessor-handle refusal already have
   real owners: `closeTask`, terminal lifecycle state, the per-plane `bindings`
   weak map, the private claimed-registration set, and source terminalization.
   D.110c-a must retain and mutate-test those paths rather than add a parallel
   lock or registry.
6. Product custody is deliberately later. After hot adoption, the application
   still retains the predecessor close handle and does not bind the successor
   handle. D.110c-b owns that rebind and the room-facing 1→2 adoption loop.
   D.110c-a may bind the genuine adopted plane directly through the existing
   Node API in its focused fixture, but it may not modify `examples/v3-room` or
   claim the product loop closed.
7. A creator close swaps an AHE generation to a complete pending-adoption head;
   it does not install the application/account room-head floor. The existing
   D.110c-0b0 begin/commit/reread law remains owned by product adoption. The
   D.110c-a fixture must prove the floor remains at the active adopted epoch
   while the next close is merely pending; D.110c-b later advances it before
   activation.

## Selected narrow construction

- Add one private, copied `previousHistorySnapshot` member to the installed
  creator-close registration.
- For epoch 0, accept only the canonical empty accumulator whose root and size
  equal the authenticated genesis anchor.
- For epoch N greater than zero, require the exact `compactHistory` member from
  the authenticated current projection. Restore it through the existing
  `CompactMerkleAccumulator`, require its root and size to equal the
  authenticated current anchor, and copy its peaks before exposing the private
  registration.
- Pass that copied snapshot to the unchanged compaction verifier. Do not add a
  second history implementation or trust a projection merely because it is
  self-consistent.
- Widen only the two existing result field types and derive their runtime values
  from current and successor trust. Refuse unsafe overflow before staging or
  terminalization.

If this construction requires product source, a wire/schema/version change, a
new package export, a dependency, a threshold change, a new durable owner, or a
different authority assumption, D.110c-a stops and reslices before production
edits.
