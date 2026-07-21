# Slice 01: Reusable Live Relay Client

## Contract unlocked

`RelayPolicy` can operate a real libp2p host without importing fixture-private
wire code.

## API seam

Promote the generic Identify/HOP/RESERVE/listener/release implementation from
`grid/fixture.ts` into `relay/libp2p-client.ts`. It implements the existing
`RelayInspector` and `RelayReservationClient`; it does not own selection policy.

Delete the duplicate fixture implementation after both the grid fixture and the
new public-only harness consume the shared client.

## Runnable surface and verification

- Against local real relay processes, distinguish HOP advertisement from
  accepted status `100`, typed refusal, malformed response, and timeout.
- An accepted reservation must produce a real circuit listen address with live
  expiry/limits; `stop()` must release it.
- Keep existing relay and grid tests green.
- Run focused tests, package/workspace typecheck, lint, Grok, and Kimi review.

## Feedback that changes this slice

Evidence that js-libp2p's public API already exposes the complete typed wire
contract without losing status, limits, expiry, or cleanup proof.
