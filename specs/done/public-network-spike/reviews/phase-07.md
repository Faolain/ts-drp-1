# Phase 07 Review: Disconnected-Joiner Grid Demonstration

Phase 07 implements the two-browser grid proof described by
[closed decision record](../README.md). A creator and joiner run as
independent libp2p/DRP peers in separate browser pages. The join URL contains
only the opaque rendezvous namespace and grid object ID; it contains no creator
Peer ID, signed record, relay address, or bootstrap address.

## Real control plane and production data plane

The creator starts with `bootstrapPeers: []`, creates a short-lived signed
rendezvous record, registers it, and does not expose the join URL until the
signed relay record is registered. The joiner discovers and validates that
record through the registry abstraction. Relay candidates come from the real
`BrowserRouting` closest-peer adapter and retain delegated-routing provenance
before entering the Phase 06 `RelayPolicy`.

The browser fixture uses the Phase 01b host-construction seam while preserving
the production `DRPNetworkNode` message queue, GossipSub service, and object
data plane. Grid movement evidence is collected from actual `FixtureGrid`
mutation events observed on both peers; it is not synthesized from expected
coordinates. The successful trace contains both creator and joiner actors and
the two pages converge after additional interactive movement.

Production defaults remain unchanged. Loopback and insecure WebSocket
allowances are explicit fixture-only routing/address-policy options. The
production `allowInsecureLoopback` meaning remains endpoint-scoped.

## Reservation and exhaustion proof

Four local Relay v2 processes provide one selected relay, one replacement, and
two deliberately capacity-exhausted relays. `DRPNetworkNodeConfig` exposes the
Relay v2 server reservation ceiling, and the refusal fixtures set
`max_reservations: 0`.

The browser opens `/libp2p/circuit/relay/0.2.0/hop`, writes a real `RESERVE`
request, and decodes the wire response. Status `100` installs the reservation
listener; status `200` is recorded as a real refusal. Error-message matching
cannot satisfy either terminal. The success trace records one accepted
reservation. The exhaustion trace records two distinct HOP-capable
connections, two decoded status-`200` refusals, zero reservations, no WebRTC
proof, and owned-fallback initiation measured at the actual acquisition
milestone within five seconds.

## Anti-cheat, direct path, and relay loss

The host snapshot requires no bootstrap discovery, no bootstrap peers, no
cold-start PubSub discovery, no GossipSub peer exchange, and no peer-discovery
modules. The runtime connection gater rejects two explicit forbidden-topology
probes and records zero topology dial attempts. A discovery-event sink fails on
unauthorized pre-auth candidates. Legitimate registry-authorized routed targets
are admitted explicitly rather than weakening the gater.

Direct-path proof requires one unique libp2p WebRTC connection and its unique
`init` data channel, then correlates that channel to one
`RTCPeerConnection`. Both selected ICE candidates must be observed and neither
may be `relay`. Separate relay WebSocket and direct WebRTC byte counters must be
positive. After the selected relay process is stopped, direct bytes must grow
strictly before bounded replacement is accepted. The trace records the removed
relay, replacement Peer ID, convergence, retained direct path, and elapsed
recovery time.

The libp2p remote address retains `/p2p-circuit/webrtc` because the circuit is
the signaling path for browser WebRTC. The transport is nevertheless proven by
the unique runtime connection/data-channel correlation, selected non-relay ICE
pair, and strictly growing RTC bytes; the address string alone is not treated
as proof.

## Browser, profiler, and visual evidence

The dedicated Playwright matrix ran five success and five honest-exhaustion
repetitions in each of Chromium, Firefox, and WebKit, plus the labeled
Node-creator DHT-anchor assertion: 33/33 passed. The anchor advertises only the
configured Node and never claims browser publication.

A clean extension-disabled Chromium run produced:

- `.network-spike-raw/phase-07/grid-browser-final.cpuprofile`: 7,539 samples,
  5,520 nodes, 1,278 unique stacks, and 1,695.25 ms sampled.
- `.network-spike-raw/phase-07/grid-browser-final.folded` and
  `grid-browser-final-flamegraph.svg`/`.png`, regenerated from that exact
  profile.
- `.network-spike-raw/phase-07/grid-browser-final-trace.json`: 16,233 trace
  events. Both profile and trace scans found no browser-extension or wallet
  URL.
- `grid-joiner-desktop-final.png` and `grid-joiner-mobile-final.png`, captured
  after live joiner movement with every runtime assertion passing.

The first fresh visual critique identified a wrapped 5+1 provenance layout,
orphaned identifier fragments, undersized board metadata, weak proof dividers,
and missing mobile provenance helper copy. The final layout uses six provenance
columns, a balanced 4+3 assertion grid, larger board metadata, readable
identifier wrapping, stronger dividers, and retained mobile helper text. A
second fresh unprimed critique returned `ACCEPT`; it found no blocking
clipping, overflow, token layering, control, provenance, or responsive defect.

## Adversarial review

The initial Grok and Kimi reviews returned `BLOCK`. Their blocking findings
identified synthetic relay routing, error-string reservation inference,
fabricated movement rows, weak anti-cheat counters, non-unique direct-path
correlation, stale profiler evidence, permissive undefined assertions, and
fallback timing measured from the wrong milestone.

The implementation now routes candidates through `BrowserRouting` and
`RelayPolicy`, decodes real HOP/RESERVE protobufs, observes actual grid
mutations and runtime gater/event counters, requires unique WebRTC correlation
and strict post-removal byte growth, measures the real fallback milestone, and
regenerates all browser/profile evidence. The corrected full matrix passed
33/33.

The final maximum-budget Grok review returned `VERDICT: ACCEPT`. The final
maximum-step Kimi review also returned `VERDICT: ACCEPT`. Kimi retained
non-blocking caveats: a disclosed upstream `node-datachannel` teardown flake on
the first repository run, transport-tag reliance because the WebRTC signaling
address contains `/p2p-circuit`, partial circularity in two anti-cheat labels,
wire-decoder coverage primarily through browser E2E, and same-context rather
than cross-process page isolation. None permits a false terminal or bypasses
the runtime assertions.

## Verification

- Grid Playwright matrix: 33/33 passed across Chromium, Firefox, and WebKit.
- Network-spike package: 11 files and 145 tests passed.
- Repository `pnpm typecheck`: passed across every workspace project.
- Repository `pnpm lint`: passed with 0 errors and 80 documentation-rule
  warnings.
- Repository `CI=1 pnpm test --run`: 92 files and 730 tests passed, with 2
  pre-existing environment-gated tests skipped; aggregate statement coverage
  was 81.05%.
- The first aggregate test attempt passed all assertions but exited nonzero on
  one asynchronous `node-datachannel` destroyed-channel teardown exception.
  The retained rerun completed cleanly with no unhandled error.
- No public-network request was made.
