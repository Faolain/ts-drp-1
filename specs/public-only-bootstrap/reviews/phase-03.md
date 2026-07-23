# Slice 03 Local-Readiness Record

Date: 2026-07-21

No public network traffic was sent. The browser gate used real DRP/libp2p hosts,
delegated-routing protocol handling, and Relay v2 HOP/RESERVE exchanges, but all
servers and relays were loopback fixtures.

## What this establishes

The browser bootstrap surface accepts a namespace rather than a DRP identity or
address. It derives the same CID as the Node, treats delegated provider results
as untrusted dial candidates, and sources its own relay candidates from a
separate closest-peers query. An owned DNSADDR fallback is structurally rejected.

The anti-cheat gate inspects the browser before releasing the provider response.
That stronger check found a provider identity embedded in the application bundle;
the fixture identity was separated from the browser bundle before acceptance.
The browser test also audits every request and WebSocket so a registry, control
port, DNSADDR fallback, or undeclared origin cannot silently make the proof pass.

This does **not** establish that the public Amino DHT will surface the provider,
that arbitrary public relays will accept reservations, or that the grid will
sync over those paths. Those are public-network acceptance questions and remain
blocked on the experiment's exact acknowledgement.

## Review and verification

- Grok and Kimi both returned `VERDICT: ACCEPT` after the anti-cheat,
  no-fallback, rejected-address, Identify lifecycle, and cancellation repairs.
- Codex identified the rejected-address, fallback-configuration, Identify timing,
  and cancellation bugs that were then pinned with regression tests.
- The focused browser-routing, relay, and public-only tests pass, as do package
  typechecks and lint with no errors.
- Chromium, Firefox, and WebKit pass the real-host loopback browser gate.

The untracked personal notes under `docs/` are not part of this slice and must
not be staged.
