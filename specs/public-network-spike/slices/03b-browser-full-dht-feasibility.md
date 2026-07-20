# Phase 03b: Browser Full-DHT Feasibility Verdict

## Contract

Produce a runnable feasibility verdict for browser full Amino DHT participation
rather than leaving it as an ADR-only hypothetical. A rejection is valid
evidence when browser transport, resource, or publication constraints prevent a
credible client.

## API seam

No production API. A browser-only experiment entry point owns the attempted DHT
construction, bundle/resource accounting, and typed `supported | rejected`
verdict. It cannot import Node TCP code.

## Runnable artifact

`/browser-dht` either bootstraps a local deterministic DHT fixture and exercises
lookup/publication, or renders the exact construction/bundle/protocol failure
with package and browser versions.

## Verification

- Chromium, Firefox, and WebKit construction/bundle checks.
- Local lookup/publication when possible; otherwise a reproducible rejection.
- CPU, memory, bundle size, routing-table behavior, address dialability, and
  browser transport constraints are reported.
- No public network in CI; an opt-in public canary uses the Phase 00 budget.
- Run the browser screenshot and every-phase gates.

## Must stay green

The delegated-routing lab and production browser bundle remain independent.

## Feedback that changes this phase

A compatible browser DHT implementation changes the verdict, not the boundary:
the experiment remains isolated until the final ADR selects it.
