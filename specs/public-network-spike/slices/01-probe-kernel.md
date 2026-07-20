# Phase 01: Deterministic Probe Kernel

## Contract

Every probe terminates with a typed outcome, ordered telemetry, and complete
cleanup under success, abort, timeout, malformed input, and dependency failure.

## API seam

`ProbeRunner`, injectable `Clock`, `RandomSource`, `FetchLike`, `Resolver`,
`Dialer`, `NetworkObservationSink`, one `AddressPolicy`, and discriminated
`ProbeEvent`/`ProbeResult` unions.

`ProbeEvent` must freeze event kinds for routing query/result counts, returned
address families, dial attempts/results, Identify protocol support, AutoNAT
reachability, relay candidate source/provenance, HOP support, reservation
accepted/refused/limits/expiry/refresh/replacement, registry
register/discover/freshness/validation failure, endpoint attempt/backoff,
time-to-first-reservation/DRP-peer/mesh/object, libp2p transport selection,
selected ICE candidate pair types, relayed/direct bytes, fallback, terminal
reason, resource samples, cleanup, and redaction.

## Runnable artifact

Replay fixture runs as JSONL and in `/evidence?fixture=all-refused`, including a
candidate-to-terminal-outcome timeline.

## Verification

- Fake-clock capped retry/backoff and abort tests.
- Address policy covers private/local/DNS-rebinding and WSS, WebTransport,
  WebRTC Direct, relay, TCP, QUIC, IPv4, and IPv6 families.
- Candidate deduplication and fast-rejection/multiple-address tests.
- Malformed, oversized, 50%, 75%, and 90% undialable fixtures.
- Telemetry ordering, redaction, resource-sample, and leaked-work tests.
- Schema coverage test maps every issue-listed telemetry item to exactly one
  event/report owner; later phases may not invent side-channel event shapes.
- Capture the browser view and run the parent README screenshot-critique gate.
- Run the every-phase review and quality gate.

## Must stay green

No public network access in tests; all existing tests and examples.

## Feedback that changes this phase

New required telemetry or failure classes change the shared event union here,
not ad hoc event shapes in later probes.
