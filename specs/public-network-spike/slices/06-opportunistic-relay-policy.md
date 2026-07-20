# Phase 06: Opportunistic Relay Policy

## Contract

Routing candidates are bounded, dialed, identified, and reserved with HOP
advertisement measured separately from reservation acceptance. Refusal,
timeout, expiry, or connection loss rotates candidates and ultimately reaches a
typed fallback or exhausted state.

## API seam

`RelayCandidateSource`, `RelayInspector`, `RelayReservationClient`,
`RelayPolicy`, and `DnsaddrFallback`. One state machine owns acquire, refresh,
replace, diversity, caps, and terminal outcomes.

`NodeRoutingClosestPeersSource` and `BrowserRoutingClosestPeersSource` are the
only routing-to-relay adapters. Both preserve candidate provenance and use the
Phase 02/03 seams; fixtures implement those routing seams rather than injecting
hard-coded relay lists into `RelayPolicy`.

## Runnable artifact

The `/relay` lab visualizes candidate → dial → Identify → HOP → reservation →
refresh/replacement/fallback with status, latency, limits, and expiry.

## Verification

- Accept, refuse/full, rate-limit, unsupported HOP, dial timeout, expiry,
  renewal, control-connection loss, relay loss during signaling, and stale
  DNSADDR fixtures.
- Seeded 50%, 75%, and 90% undialable candidates and all-refused exhaustion.
- WSS-only versus WSS + WebTransport + WebRTC Direct profiles.
- Reservation concurrency, queue, per-candidate, total deadline, diversity, and
  owned fallback bounds.
- Actual reservation status is decoded; HOP support alone cannot pass.
- Local and opt-in public tests prove both closest-peer adapters feed the real
  policy and record source/query/result provenance.
- Dedicated browser tests, screenshots, and screenshot-critique.
- Run the every-phase review and quality gate.

## Must stay green

Public relays are overflow only during the spike; owned relay behavior remains
runnable and ordinary CI uses local fixtures.

## Feedback that changes this phase

Required reservation count/diversity, fallback deadline, or supported transport
profiles changes the state machine inputs, not phase-specific branching.
Baseline consideration requires at least two coarse operator/ASN groups in the
campaign; inability to establish aggregate diversity is an explicit no-go for
baseline but does not block the overflow verdict.
