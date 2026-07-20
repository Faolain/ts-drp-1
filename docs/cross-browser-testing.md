# Cross-browser grid testing

The grid end-to-end suite exercises peer discovery, object membership, state
exchange, and movement propagation through browser libp2p nodes. A passing run
is meaningful only when the local relay is ready before the second browser peer
starts and every test releases the peers it creates.

The canonical test behavior lives in
[`examples/grid/e2e`](../examples/grid/e2e). This document records the
cross-browser contracts and interpretation rules that are not obvious from the
test code.

## Browser targets

The default Playwright matrix is defined in
[`playwright.config.ts`](../playwright.config.ts). WebKit uses Playwright's
Desktop Safari device profile; it is the automated Safari-engine target, not a
run of the installed Safari application.

Firefox is locally validated but remains outside the default matrix until it is
deliberately enabled and verified in GitHub Actions. The older upstream links
that previously justified excluding Firefox do not describe the current grid
transport:

- [Mozilla bug 1659672](https://bugzilla.mozilla.org/show_bug.cgi?id=1659672)
  was resolved as invalid and concerned pure-LAN ICE gathering.
- [js-libp2p issue 2047](https://github.com/libp2p/js-libp2p/issues/2047)
  was closed after going stale and used an older libp2p stack.
- [js-libp2p issue 2572](https://github.com/libp2p/js-libp2p/issues/2572)
  tracks WebTransport, while the grid uses WebRTC.

## Latest validation

The most recent focused validation was performed on 2026-07-20 with Playwright
1.51.1 on macOS ARM64:

| Engine      | Focused grid suite | Clean five-repeat run | Instrumented WebRTC run |
| ----------- | -----------------: | --------------------: | ----------------------: |
| Firefox 135 |         3/3 passed |          15/15 passed |              3/3 passed |
| WebKit 18.4 |         3/3 passed |          15/15 passed |              3/3 passed |

The instrumented runs observed connected `RTCPeerConnection` instances,
successful ICE candidate pairs, open data channels, and matching increases in
sent and received WebRTC bytes after grid movements. This distinguishes a
working peer-to-peer transport from a test that merely reaches the relay over
WebSockets.

These counts are a dated evidence snapshot, not a permanent browser-support
guarantee. Repeat the validation after changing libp2p transports, relay
startup, browser versions, or the grid test lifecycle.

## Readiness is part of the protocol

The first browser peer must finish registering its signed peer record with the
local relay before the second peer starts. The grid suite enforces this by
waiting for the first peer's signed relay address in `test.e2e.log`.

Do not replace that gate with a fixed delay or merely wait for the page loading
indicator. WebKit can reach the relay before the relay is ready to introduce
that peer to another browser, producing an empty peer or object group even
though neither ICE nor the data channel failed.

## Tests must release browser peers

Each grid test creates two independent pages with `browser.newPage()`. Repeated
runs must close both pages after the test. Otherwise old libp2p nodes remain
connected to the relay, the apparent peer population grows across tests, and
later assertions can fail with closed-stream errors.

This lifecycle leak can resemble browser-specific networking instability. In
the 2026-07-20 investigation, five repeats without teardown produced 12/15
passes in Firefox and 14/15 in WebKit. Closing both pages after every test
produced 15/15 passes in each engine.

Position assertions also need to wait for the preceding movement before
capturing a baseline. A replica may legitimately apply two queued movements in
one render; treating the intermediate position as already synchronized creates
a false 50-pixel-versus-100-pixel failure.

## Running the checks

Install the Playwright engines once:

```bash
pnpm exec playwright install firefox webkit
```

Run the configured WebKit project:

```bash
pnpm exec playwright test --project=webkit --reporter=list
```

Firefox is not currently a configured project. To evaluate it locally, add a
temporary project using Playwright's `Desktop Firefox` device alongside the
configured projects, then run:

```bash
pnpm exec playwright test --project=firefox --reporter=list
```

Use one worker and close the pages after every test when repeating the suite.
Retain traces on failure so browser console errors and stream state can be
correlated with the failed assertion.

## WebRTC dependency caveat

The repository applies
[`@libp2p/webrtc`'s early-data-channel patch](../patches/@libp2p__webrtc@6.0.26.patch).
It buffers messages that arrive before the stream muxer adopts a data channel.
Without that behavior, an established WebRTC connection can still lose the
first protocol-negotiation bytes and time out.

Keep the patch until the installed `@libp2p/webrtc` release contains the
upstream fix tracked in
[js-libp2p pull request 3576](https://github.com/libp2p/js-libp2p/pull/3576).
