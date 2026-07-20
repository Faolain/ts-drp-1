# Phase 04: Signed Short-TTL Rendezvous Record

## Contract

A discovered record proves control of its Peer ID and passes strict freshness,
size, sequence, address, capability, and admission checks. It does not prove DRP
authorization.

## API seam

Canonical `SignedDrpRecordV1`, `RecordSigner`, and `RecordValidator`. The signed
payload binds an opaque versioned namespace, Peer ID/public key, bounded
multiaddrs or signed peer record, capabilities, monotonic sequence, issued time,
expiry, and signature.

## Runnable artifact

`record sign`, `record verify`, and `/record` show accepted records and stable
rejection codes for altered fixtures.

## Verification

- Public-key-to-Peer-ID binding and signature/canonical-byte tests.
- Replay/sequence, expiry/future/skew, forged, oversized, excessive address,
  unsupported capability, private/local address, and response-count tests.
- DNS is rechecked at dial time to mitigate rebinding.
- No private key material in events/evidence.
- Capture `/record` and run the parent README screenshot-critique gate.
- Run the every-phase review and quality gate.

## Must stay green

Existing keychain behavior and production network packages remain unchanged.

## Feedback that changes this phase

The selected admission model, namespace scope, or need for object-level
namespaces changes the signed payload before registry implementation.
