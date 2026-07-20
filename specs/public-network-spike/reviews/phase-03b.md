# Phase 03b Review: Browser Full-DHT Feasibility

Phase 03b implements the isolated browser Amino DHT experiment and
`/browser-dht` evidence view described by
[slice 03b](../slices/03b-browser-full-dht-feasibility.md). Its verdict is
`rejected` for the tested browser-host shape: an outbound WebSocket browser can
construct the DHT, identify and query a routing peer, and complete an
`ADD_PROVIDER` exchange, but a host with `listen: []` has no dialable address to
publish. The installed DHT drops zero-multiaddr provider records, so a separate
observer query completes without finding the browser provider.

This is not a claim that every browser transport, WebRTC listener, or relay
reservation is incapable of DHT participation. It rejects using this
outbound-only browser DHT as the general browser rendezvous/provider mechanism
for issue #5. Delegated lookup remains an independent Phase 03 option.

## Runtime and protocol evidence

The deterministic fixture uses one loopback Node routing peer and two fresh
browser hosts. The publisher and observer use
`@libp2p/kad-dht@16.3.4`, `libp2p@3.3.5`,
`@chainsafe/libp2p-noise@17.0.0`,
`@chainsafe/libp2p-yamux@8.0.1`,
`@libp2p/identify@4.1.9`, `@libp2p/ping@3.1.8`, and
`@libp2p/websockets@10.1.16`. Both browser hosts have an empty listen-address
set and dial the fixture over outbound WebSocket.

The visible, run-bound ledger records separate actor-scoped facts for host
construction, fixture dial, routing readiness, peer lookup, provider RPC
response, observer provider-query completion, returned providers, and dialable
addresses. Compact peer/CID aliases remain stable within the view; the full
values and typed result are available in the disclosure. The provider RPC
check asserts only that a response was observed, not that the remote peer
stored a provider record.

Exact installed dependency source explains the outcome. `provide()` reads the
host address manager's current addresses; the provider-record handler ignores
records with zero multiaddrs; and `GET_PROVIDERS` filters empty-multiaddr
providers. The package export map prevented the isolated dependency-index
helper from resolving this package, so the review inspected the exact installed
artifact directly and recorded that fallback rather than inferring behavior
from documentation.

## Bounds, cleanup, and scope

- Browser hosts are constructed sequentially, so a second-host construction
  failure cannot leak the first host.
- The experiment has one eight-second protocol cap. Every dial and query
  receives its abort signal; cleanup uses settled host stops.
- Publisher and observer searches use deliberately degenerate deterministic
  bounds (`alpha: 1`, one disjoint path, and a one-entry bucket). The workbench
  labels the fixture as protocol-shape evidence from a single local routing
  peer, not DHT-scale or public-network evidence.
- Provider RPC completion and provider-query completion are separate facts. A
  failed/interrupted query is `provider-query-failed`, never a false timeout or
  a successful zero-result observation.
- Fixture startup failure produces the same typed, versioned
  `fixture-unreachable` rejection surface, including bundle evidence.
- No public peer, delegated endpoint, relay, or IPFS bootstrap node was
  contacted.

## Bundle, resource, and browser evidence

The browser-platform esbuild metafile is generated rather than hand-authored.
The final standalone bundle evidence is 625,524 bytes, 202,359 gzip bytes, and
496 inputs, with zero forbidden Node/TCP inputs. Browser tests assert that
firewall on the rendered generated artifact.

Resource observations distinguish what the browser actually exposes:
`PerformanceLongTaskTiming`, non-standard heap counters when available, and
Resource Timing transfer bytes. The view explicitly says Resource Timing does
not include WebSocket frame bytes. In the accepted desktop run, the complete
protocol verdict took about 86.2 ms with no long task; heap deltas remain
environment-dependent observations rather than a memory claim.

Chrome was also captured under Fast 4G and 4× CPU slowdown. Its durable
Performance flame-chart source is
`.network-spike-raw/phase-03b/chrome-fast4g-4xcpu-trace.json.json.gz`; the
recorded page-load metrics were 1,242 ms LCP, 0.01 CLS, 2 ms TTFB, and
1,239 ms render delay. Raw captures remain ignored and local.

The focused browser-DHT suite passes six combinations across Chromium,
Firefox, and WebKit. It covers the exact zero-address rejection and a fixture
failure with no console errors or horizontal overflow. The complete
network-spike browser project passes 51/51. Chrome inspection found only the
two intended loopback origins and no public request.

The accepted full screenshot is
`.network-spike-raw/phase-03b/browser-dht-desktop-v5.png`. A fresh unprimed
visual review returned `ACCEPT`: the rejection chain, actual-versus-policy cap,
actor aliases, typed disclosure, and bundle firewall are legible and
traceable. Its only non-blocking note was that secondary ledger labels are
slightly faint; the exact values remain available through the disclosure and
tooltips, with no clipped content or lost state.

## Adversarial review

Both required reviewers ran read-only with a maximum budget of 100 turns or
steps:

- Grok interactive review (tool session `67351`) initially rejected partial
  construction cleanup, provider-ack wording, a hand-authored bundle claim,
  shared-fixture browser concurrency, and provider-query timeout
  classification. The implementation now constructs sequentially, says
  response observed, generates and tests an esbuild metafile, serializes the
  intentionally shared fixture, and distinguishes query failure. Its follow-up
  returned `VERDICT: ACCEPT` with no remaining actionable blockers.
- Kimi session `96ff4a71-825e-488a-a1ca-e76d8805cb17` returned `ACCEPT`.
  Its findings led to generated bundle evidence, typed fixture-unreachable
  output, construction cleanup, exact protocol-cap wording, an explicit
  WebSocket transfer-measurement limitation, fixture-scope labeling, and
  additional failure-path tests.

No blocking finding remains.

## Verification

- Focused package suite: 7 files and 60 tests passed.
- Browser bundle evidence: 625,524 bytes, 202,359 gzip bytes, 496 inputs, zero
  forbidden inputs.
- Focused Playwright project: 6/6 passed across Chromium, Firefox, and WebKit.
- Complete network-spike Playwright project: 51/51 passed with one worker,
  required because all projects intentionally share one bounded fixture peer.
- Vite production build: 532 modules, 744.52 kB JavaScript (238.69 kB gzip)
  and 23.49 kB CSS (5.52 kB gzip). The aggregate workbench chunk warning is
  non-blocking; the dedicated DHT bundle measurement above is the decision
  artifact.
- Repository `pnpm typecheck`: passed across all workspace projects.
- Repository `pnpm lint`: passed with the 71 pre-existing warnings and no
  errors.
- Final serial `CI=1 pnpm test --run --reporter=dot`: 88 files passed, 643
  tests passed, 2 skipped, and 88.18% statement coverage.
- `git diff --check`: passed.
- No public-network request was made.
