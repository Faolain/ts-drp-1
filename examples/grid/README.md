# DRP Example

This is an example that uses a DRP to implement a 2D grid space where users appear to be circles and can move around the integer grid one grid at a time.

## Specifics

The Grid DRP has a mapping from user id (node id concacenated with a randomly assigned color string) to the user's position on the grid. The DRP leverages the underlying hash graph for conflict-free consistency. The mergeCallback function receives the linearised operations returned from the underlying hash graph, and recomputes the user-position mapping from those operations.

## Network mode

The grid runs on the **modular network stack** (PRD 001): peers discover one
another through the rendezvous ensemble and connect over operator‑diverse relays
with **no fixed bootstrap seeds**. The modular configuration is built from
`VITE_*` env vars by `src/network-config.ts` (`buildModularNetworkConfig`), and
`src/index.ts` wires the node via `@ts-drp/rendezvous`, `@ts-drp/relay-policy`
and `@ts-drp/control-plane`.

The end‑to‑end harness starts the whole local modular topology for you —
two independent registry backends, a delegated‑routing fixture, and two
operator‑diverse relay fixtures — so the easiest way to see it converge is:

```bash
pnpm e2e-test        # modular grid, Chromium + WebKit, no fixed bootstrap
```

(That command runs `examples/grid/playwright.modular.config.ts`, which boots the
grid app in modular mode plus its local fixtures.)

### Legacy fixed‑bootstrap dev loop (optional)

The app still accepts `VITE_BOOTSTRAP_PEERS` for a simple two‑window loop against
a single local seed. Note that Phase 7 de‑privileged bootstrap peers, so two
browsers behind one seed sync their grid **through** the seed rather than
connecting directly — use the modular path above for the full experience.

```bash
# Terminal 1 — local seed (deterministic peer id from configs/local-bootstrap.json)
pnpm cli --config configs/local-bootstrap.json

# Terminal 2 — the grid, pointed at that seed
VITE_BOOTSTRAP_PEERS="/ip4/127.0.0.1/tcp/50000/ws/p2p/16Uiu2HAmTY71bbCHtmYD3nvVKUGbk7NWqLBbPFNng4jhaXJHi3W5" \
  pnpm --filter ts-drp-example-grid dev
```

Open the printed URL in **two** windows. In one, click **CREATE** and copy the
grid id; in the other, paste it into **GRID ID** and click **JOIN**. Move with
`W`/`A`/`S`/`D`.

## Verify

Automated checks that confirm nodes converge to identical positions:

```bash
# Cross-replica convergence property test (2D + 3D position maps; asserts every
# replica ends with identical positions, frontier, and linearization)
pnpm vitest run packages/object/tests/proptest/convergence.test.ts --coverage.enabled=false

# Real multi-node convergence over libp2p (identical serialized state across nodes)
pnpm vitest run packages/node/tests/proptest/multi-node-convergence.test.ts --coverage.enabled=false

# Modular grid browser end-to-end on Chromium + WebKit (no fixed bootstrap;
# starts its own registries, delegated-routing fixture and operator-diverse relays)
pnpm e2e-test
```

See [Cross-browser grid testing](../../docs/cross-browser-testing.md) for the
Firefox and WebKit validation evidence, relay-readiness contract, and guidance
for interpreting repeated-run failures.
