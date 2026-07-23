# Slice 02: One-Host Node Publisher

## Contract unlocked

The same identity owns DRP GossipSub/object state, public relay dialability, and
the public Amino provider record.

## API seam

Extract reusable Amino construction/attachment from `node-routing/index.ts` and
add `public-only/node-publisher.ts`. Do not create a helper host that would
publish the wrong Peer ID.

Startup order is observable and fixed: start isolated DRP Node, join Amino,
obtain a public reservation, wait for the browser-dialable circuit address,
create the grid, then provide the namespace CID.

## Runnable surface and verification

- A local private-DHT/real-relay topology proves same identity, ordering,
  provider visibility, address advertisement, cleanup, and bounded terminals.
- The opt-in public checkpoint requires explicit acknowledgement and records
  bootstrap, routing table, relay reservation, circuit address, provide, and
  independent lookup evidence.
- If the independent result omits the circuit address, stop with a no-go.
- Run focused tests, package/workspace typecheck, lint, Grok, and Kimi review.

## Feedback that changes this slice

A supported mechanism for one peer to publish another peer's signed provider
record, or evidence that browsers can publish Amino providers directly.
