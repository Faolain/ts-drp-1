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

### One‑command local WebRTC demo

To play it yourself — the whole modular stack on one machine, no fixed bootstrap
seeds, real WebRTC between two browser windows:

```bash
pnpm --filter ts-drp-example-grid demo
```

This stands up two rendezvous registries + a delegated‑routing endpoint and two
operator‑diverse relays, then serves the grid in modular mode. Open the printed
`http://127.0.0.1:4174` in **two** windows, **CREATE** in one, **JOIN** with the
copied grid id in the other, and move with `W`/`A`/`S`/`D`. Peers discover each
other through rendezvous, connect through a relay, and upgrade to direct WebRTC
where the network allows. Ctrl+C stops everything.

For the full picture — how the WebRTC upgrade works, whether you need to run your
own nodes, GossipSub node scoring/reputation, all‑in‑one setups, and how to stand
up a real shareable deployment — see **[docs/DEPLOYING.md](../../docs/DEPLOYING.md)**.

### Automated end‑to‑end

```bash
pnpm e2e-test        # modular grid, Chromium + WebKit, no fixed bootstrap
```

(That command runs `examples/grid/playwright.modular.config.ts`, which boots the
grid app in modular mode plus its local fixtures. This is the CI‑gated run.)

**Discovery over real public Nostr relays (manual, not CI):**

```bash
pnpm e2e-test:public-infra   # Chromium/Firefox/WebKit; discovery via wss://relay.damus.io + wss://nos.lol
```

This runs `playwright.public-infra.config.ts`. Only **discovery** goes
public — it **sends traffic to third‑party Nostr relays**, is **not** a CI gate,
and is flakier than the local run. **Connectivity** still uses local
operator‑diverse circuit relays, purely for reproducibility. Override
`VITE_NOSTR_RELAYS` / `VITE_RENDEZVOUS_NAMESPACE` to retarget or isolate a run.

**Fully public — discovery AND connectivity (manual, not CI):**

```bash
pnpm e2e-test:fully-public   # two browsers converge on ONLY public infra, no DRP-operated infra
```

This runs `playwright.fully-public.config.ts`: two browsers discover over public
Nostr and reserve a **real public relay** found via public delegated routing
(`delegated-ipfs.dev` → AutoTLS relays), then converge a grid — verified live
(~18 s). It's the flakiest run (live Nostr + ephemeral AutoTLS relays); full
context in
[docs/DEPLOYING.md](../../docs/DEPLOYING.md#infra-independent-discovery-via-nostr).

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
