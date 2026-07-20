# Phase 06 Review: Opportunistic Relay Policy

Phase 06 implements the routing-backed relay policy and `/relay` decision lab
described by [slice 06](../slices/06-opportunistic-relay-policy.md). Public
relays remain optional overflow candidates. The owned DNSADDR relay remains the
ordinary fallback, and inability to obtain reservations from at least two
coarse operator groups is an explicit no-go for treating public relays as a
supported baseline.

## Candidate and reservation contract

`NodeRoutingClosestPeersSource` and `BrowserRoutingClosestPeersSource` are the
only routing-to-relay adapters. Both cap and deduplicate results before policy
work and preserve the routing origin, query digest, result index, and routing
source. The deterministic fixture implements the browser routing seam rather
than passing a hard-coded relay list directly to `RelayPolicy`.

Candidates remain untrusted until the policy dials them, inspects Identify
protocols, observes Circuit Relay v2 HOP support, and receives an accepted
reservation. HOP advertisement is recorded separately and cannot count as
acceptance. `decodeRelayReservationResponse` accepts only wire status `100`
(`OK`) with a live reservation and resource limits. It maps refusal, resource
limit, permission, connection, missing-reservation, malformed-message, and
unexpected-message statuses to typed outcomes. An HTTP/proxy/client throttle
is represented by `RelayTransportRateLimitError`; it cannot be misreported as
a Circuit Relay v2 status because the protocol has no `429` status or
retry-after field.

## One bounded lifecycle owner

One `RelayPolicy` state machine owns acquire, refresh, replacement, stop,
candidate and lifecycle-operation queue ceilings, concurrency, diversity,
transport profiles, owned fallback, attempted/retired identities, and release
of surplus reservations. Candidate collection, public reservation work, and
owned fallback consume one total deadline; fallback is clamped to the actual
remaining budget. A literal deadline races each dependency and the caller
abort signal, so a dependency that ignores cancellation cannot hang either a
candidate attempt or the total lifecycle. The raced operation always has a
rejection sink, preventing a cooperative late abort rejection from becoming
unhandled.

The policy rotates after dial failure, missing HOP, refusal, capacity,
transport throttle, expiry, control-connection loss, and relay loss during
signaling. Refresh occurs before expiry; a refused refresh is replaced.
`stop()` releases every owned reservation and retries tracked release failures.
Same-group racing reservations are released rather than silently violating the
configured two-group diversity invariant. If a valid configuration permits a
same-group surplus before diversity is met, a later new-group acceptance
replaces that surplus.

Routing output is untrusted. Malformed candidates are skipped and recorded as
typed, sanitized attempts; raw observations have an independent cap, and a
classifier failure collapses conservatively to one `unknown` group rather than
deriving fake diversity from Peer ID text. Multiaddr transport matching parses
protocol components instead of using substrings.

The broad browser profile permits WSS, WebTransport, and WebRTC Direct
candidates; the conservative profile permits WSS only. After bounded public
exhaustion, owned DNSADDR fallback succeeds only with live DNS evidence. Stale
fallback evidence produces a typed exhausted outcome rather than a misleading
success.

## Deterministic decision evidence

The browser fixture covers mixed outcomes, all-refused exhaustion,
stale-fallback exhaustion, and transport-profile filtering. Its visible
expected/actual panel contains eight matched assertions and explicitly reports
that raw Peer IDs are absent. Seeded tests cover 50%, 75%, and 90% undialable
candidate populations. Other regressions cover both closest-peer adapters,
every wire status, malformed resource limits, HOP-without-reservation,
non-cooperative per-candidate and total deadlines, caller abort during
fallback, malformed candidates, classifier failure, connection loss during
signaling, concurrency and surplus replacement, lifecycle queue pressure, live
and stale DNSADDR fallback, refresh, replacement, stop, and configuration
limits.

The implementation was checked against installed
`@libp2p/circuit-relay-v2@4.2.8` source without public egress. Its reservation
store opens `/libp2p/circuit/relay/0.2.0/hop`, writes `RESERVE`, accepts only
`OK` plus a reservation, tracks expiry/refresh and connection closure, and
defaults reservation completion to five seconds with concurrency one and queue
length 100. The spike owns stricter explicit bounds rather than depending on
those defaults.

## Browser and performance evidence

`/relay` visualizes candidate → dial → Identify → HOP → reserve, followed by
refresh, replacement, fallback, or terminal exhaustion. Status, latency,
expiry implications, concurrency, queue, diversity, deadline, and transport
limits remain visible. Chrome inspection found zero console errors and no
horizontal overflow at 1,440 and 390 CSS pixels. The final desktop page was
3,638 pixels high and the mobile page was 7,743 pixels high. The instrumented
fixture render was about 1 ms. The bounds panel is rendered from the result
payload and shows the fixture's actual limits: 6 candidates, 2 concurrent
reservations, 1 per operator group, 100 ms per candidate, 500 ms total, and
100 ms owned fallback.

The durable Chrome Performance flame-chart source is
`.network-spike-raw/phase-06/chrome-relay-load-trace.json.gz`. Its reload
contained 1,589 events with 78.2 ms TTFB, 107.5 ms DOM content loaded,
112.2 ms load, and zero CLS. The largest trace slices were module evaluation
at 5.6 ms, navigation commit at 3.9 ms, response/parser work at 2.8 ms, and
layout at 1.6 ms. No browser long task or layout instability was observed.

Final screenshots:

- `.network-spike-raw/phase-06/relay-desktop-v3.png`
- `.network-spike-raw/phase-06/relay-mobile-v1.png`

The first unprimed visual review rejected a misleading double-negative raw-ID
label and a wrapped `reserved ×2` terminal line. The label now reads `Raw Peer
IDs present` with expected/actual `false`, and the terminal layout no longer
wraps. A fresh unprimed review returned `ACCEPT`; its only non-blocking note was
low contrast in the smallest metadata at full-page scale. After the bounds
correction, another fresh unprimed review also returned `ACCEPT` with the same
minor note.

## Adversarial review

The initial read-only Kimi review returned `BLOCK` with four blocking findings:
the UI displayed default rather than fixture bounds; owned fallback could
restart a deadline after public search; malformed routing output could throw
past typed terminals; and synthetic HTTP `429`/retry-after fields were
presented as Relay v2 wire semantics. The correction binds the UI to exported
fixture limits, applies one total budget, sanitizes and records invalid
candidates, and separates transport throttling from the wire decoder.

The initial read-only Grok review returned `BLOCK` with three blocking
findings: a valid `maxPerOperatorGroup > 1` configuration could fill the
reservation count with one group and then reject a diversity-restoring
candidate; a raced dependency lacked a late-rejection sink; and total-budget
expiry was labeled as caller abort. The correction replaces same-group
surplus, attaches the rejection sink, and reserves `aborted` exclusively for
the caller signal.

Both reviewers also identified non-blocking hardening opportunities. The
implemented dispositions add fallback-abort typing, conservative operator
classification, parsed multiaddr transports, malformed resource-limit
rejection, a 32-operation lifecycle queue, bounded raw observations, refresh
evidence that does not fabricate HOP inspection, and tracked release failures.
Kimi's follow-up returned `VERDICT: ACCEPT`; it left only three non-blocking
nits: no dedicated release-retry test, an aborted refresh retains existing
reservations until `stop()`, and the fixture-only display labeler still uses
known-string matching. Grok's follow-up returned `VERDICT: ACCEPT`. After the
lint-only cleanup, both reviewers ran one final read-only confirmation and again
returned `VERDICT: ACCEPT`.

## Verification

- Relay focused gate: 43/43 passed.
- Complete network-spike package: 10 files and 136 tests passed.
- Relay module: 93.24% statement, 81.15% branch, and 91.07% function coverage;
  relay fixture: 99.19% statement coverage.
- CLI fixture: eight deterministic expected/actual assertions matched; no raw
  Peer ID was emitted.
- Production Vite build: 527 modules, 826.80 kB JavaScript (260.53 kB gzip)
  and 53.03 kB CSS (10.87 kB gzip). The aggregate multi-workbench chunk warning
  is non-blocking.
- Repository `pnpm typecheck`: passed across all workspace projects.
- Repository `pnpm lint`: passed with 71 baseline warnings and no errors.
- Phase 06 browser gate: 12/12 passed across Chromium, Firefox, and WebKit.
- Complete browser project: 75/75 passed across Chromium, Firefox, and WebKit.
- Repository functional gate and isolated performance-contract disposition:
  90/90 files and 704 tests passed with 2 skipped, plus 8/8 isolated performance
  contracts. The first single-process aggregate run passed 90/91 files and
  failed only two elapsed-time assertions after sustained stress: 224 ms
  against 200 ms and 2.30 s against 1.00 s. With no competing suite, the same
  measured operations took 7 ms and 123 ms. The complete functional log is
  `.network-spike-raw/phase-06/repository-functional-gate.log`; aggregate
  statement coverage was 88.05%.
- No public-network request was made.
