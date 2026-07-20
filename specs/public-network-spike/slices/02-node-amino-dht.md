# Phase 02: Node Amino DHT Harness

## Contract

A Node-only harness proves or rejects client-mode Amino routing and namespace
publication with bounded resource and address handling.

## API seam

`NodeRouting` with `findPeer`, `getClosestPeers`, `provide`, reprovide control,
routing-table status, and `stop`. Construction lives in a Node-only entry point
using `@libp2p/kad-dht`, TCP/WebSockets, Identify, `/ipfs/kad/1.0.0`, and
official DNS bootstrappers.

## Runnable artifact

`pnpm --filter @ts-drp/network-spike node-routing --fixture` proves all
operations locally. `--public` additionally requires an explicit public-network
acknowledgement and emits sanitized manifest/evidence files.

## Verification

- Local DHT tests for find, closest, provide, visibility, and reprovide.
- Cold bootstrap, routing-table size, provider latency, CPU, RSS, and byte
  measurements.
- Record AutoNAT reachability transitions and public/private observed-address
  classes alongside dialability; do not infer reachability from a DHT result.
- Abort, shutdown, empty result, and 50–90% unusable-address bounds.
- Browser bundle analysis proves no DHT/TCP code is present.
- Public canary remains opt-in and outside normal CI.
- Run the every-phase review and quality gate.

## Must stay green

Universal network bundle, fixed bootstrap path, and ordinary CI remain
independent of Amino.

## Feedback that changes this phase

Package incompatibility, public bootstrap protocol drift, or unacceptable
resource cost may produce a measured rejection instead of a routing candidate.
