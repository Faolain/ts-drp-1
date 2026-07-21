# Slice 04: Public-Only Grid Canary

## Contract unlocked

The full public-only chain either synchronizes the real grid or produces a
stage-specific no-go without fixture fallback.

## API seam

Add a small public-only coordinator that supplies provider discovery to the
existing production-shaped grid data plane. Do not adapt untrusted DHT results
into signed registry records and do not duplicate the grid/object/direct-byte
oracle.

## Runnable surface and verification

With only namespace/object ID shared, prove in order: delegated provider
discovery, provider-derived dial, DRP connection, GossipSub mesh, initial sync,
bidirectional convergent mutations, unique WebRTC correlation, non-relay direct
candidate pair, and increasing sent/received direct bytes.

Remove the selected public relay after direct upgrade and record whether the
direct connection survives and whether a replacement reservation is obtained.

Run the dedicated Playwright canary, screenshot the sanitized milestone view,
run `screenshot-critique`, then focused tests, package/workspace typecheck,
lint, Grok, and Kimi review.

## Feedback that changes this slice

Whether relayed grid synchronization without direct upgrade is an acceptable
partial success. Default: it is not full success.
