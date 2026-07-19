# DRP Example

This is an example that uses a DRP to implement a 2D grid space where users appear to be circles and can move around the integer grid one grid at a time.

## Specifics

The Grid DRP has a mapping from user id (node id concacenated with a randomly assigned color string) to the user's position on the grid. The DRP leverages the underlying hash graph for conflict-free consistency. The mergeCallback function receives the linearised operations returned from the underlying hash graph, and recomputes the user-position mapping from those operations.

## How to run locally

Two browser tabs need a shared entry point to find each other. Run a local
bootstrap node, then start the grid pointed at it — otherwise the app dials the
public bootstrap and stalls on "Connecting to network...".

From the repository root (`pnpm install` first, once):

```bash
# Terminal 1 — local bootstrap relay (deterministic peer id from configs/local-bootstrap.json)
pnpm cli --config configs/local-bootstrap.json

# Terminal 2 — the grid, pointed at that relay
VITE_BOOTSTRAP_PEERS="/ip4/127.0.0.1/tcp/50000/ws/p2p/16Uiu2HAmTY71bbCHtmYD3nvVKUGbk7NWqLBbPFNng4jhaXJHi3W5" \
  pnpm --filter ts-drp-example-grid dev
```

Open the printed URL (`http://localhost:5173`) in **two** windows. In one, click
**CREATE** and copy the grid id; in the other, paste it into **GRID ID** and click
**JOIN**. Move with `W`/`A`/`S`/`D` — each window shows both dots and they track
each other. The bootstrap multiaddr above is fixed because the peer id is derived
from the `bootstrap` seed in `configs/local-bootstrap.json`.

## Verify

Automated checks that confirm nodes converge to identical positions:

```bash
# Cross-replica convergence property test (2D + 3D position maps; asserts every
# replica ends with identical positions, frontier, and linearization)
pnpm vitest run packages/object/tests/proptest/convergence.test.ts --coverage.enabled=false

# Real multi-node convergence over libp2p (identical serialized state across nodes)
pnpm vitest run packages/node/tests/proptest/multi-node-convergence.test.ts --coverage.enabled=false

# Grid browser end-to-end on Chromium + WebKit (starts its own relay + server)
pnpm e2e-test
```
