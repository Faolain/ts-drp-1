# Phase 03: Browser Delegated-Routing Lab

## Contract

Chromium, Firefox, and WebKit can make bounded Routing V1 peer/provider/closest
lookups with browser-dialable address filtering and endpoint failover, while
publication is structurally unavailable.

## API seam

`BrowserRouting` wraps the maintained Helia delegated Routing V1 client and
exposes `canProvide: false`. `RegistryClient` does not own routing failover;
delegated endpoint backoff/failover lives in this adapter.

## Runnable artifact

The `/delegated` workbench displays raw and accepted addresses, query timing,
cache state, endpoint attempts/backoff, and exact terminal outcomes.

## Verification

- Separate-origin CORS, cache TTL/disabled cache, timeout, abort, empty, 404,
  malformed, oversized, poisoned, stale, 429/`Retry-After`, outage, and ordered
  endpoint-failover fixtures.
- Compile-time negative test: browser code cannot call `provide`.
- Real browser peer and provider lookup canaries are explicit opt-in.
- Dedicated Playwright runs for Chromium, Firefox, and WebKit.
- Capture the workbench and run the parent README screenshot-critique gate.
- Run the every-phase review and quality gate.

## Must stay green

No delegated request in ordinary CI; no Node-only package in the browser bundle.

## Feedback that changes this phase

Endpoint allowlist, cache policy, browser transport support, or a client defect
that swallows required diagnostics changes the adapter design and must be
recorded as evidence.
