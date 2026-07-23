# Slice 03: Browser Public Routing and Relay

## Contract unlocked

A real browser learns the DRP Node only from a deterministic CID lookup and
obtains its own public relay reservation without an owned fallback.

## API seam

Add `public-only/provider-locator.ts` and `public-only/browser-peer.ts`.
`DelegatedBrowserRouting.findProviders()` owns provider lookup;
`BrowserRoutingClosestPeersSource` and `RelayPolicy` own relay discovery and
selection. Results are explicitly `untrusted-public-provider` candidates.

Do not weaken the configured-identity checks in the existing registry anchor
resolver.

## Runnable surface and verification

- Add a dedicated opt-in browser route and Playwright config, starting with
  Chromium and then Firefox/WebKit.
- Assert no DRP Peer ID/address exists before the delegated response and no
  loopback, registry, DNSADDR fallback, or control side-channel is contacted.
- Require a provider-returned browser-dialable address and a decoded accepted
  public reservation. Empty, undialable, refused, rate-limited, CORS, and
  timeout outcomes remain typed evidence.
- Run `screenshot-critique` on any accepted visual evidence before retaining it.
- Run focused tests, package/workspace typecheck, lint, Grok, and Kimi review.

## Feedback that changes this slice

The permitted public Routing V1 endpoint or required browser transport set.
