# D.93.36 Durable Live Composition

## Overview

D.93.36 connects the shipped protocol-v3 authorization, admission, issuance,
live-journal, causality, and transport owners into one durable product path. Two
browser clients can join the same room, issue visible durable messages, observe
the same accepted transcript, close one client, reopen its real browser stores,
and converge again after another exchange.

This is a warm-reconnect proof for the exercised room history. It is not a
general offline synchronization protocol, dynamic membership system, or claim
that every application reducer is correct.

## Why this shape

The live path composes existing authorities instead of introducing a replica
manager beside them. Authorization remains in the prepared/recovered
capabilities, issuance remains in the durable issuance store, accepted history
remains in the live journal and `CausalityIndex`, and transport remains outside
those authorities. That separation keeps persistence carriers from becoming
authorization claims.

Recovery deliberately finishes before transport activation. A reconnecting
application needs the already-authenticated recovered views to reconstruct its
visible state, but subscription must not race that reconstruction. The recovery
descriptor therefore exposes detached admitted views; it does not replay an
application sink or create a second effect path.

The dedicated v3 chat artifact exists because the legacy chat exercises a
different protocol plane. Its `BroadcastChannel` is only a browser transport
adapter. Every received vertex still crosses the genuine v3 ingress boundary.

## Invariants

- `packages/node/src/v3-live.ts` is the composition owner. There is no parallel
  coordinator, publisher, replica store, or caller-selected authorization seam.
- Every retained journal or issuance carrier is re-authenticated through the
  same admission path used for a received vertex.
- Recovery completes before subscription, publication, reducer, sink, or other
  observable live effects.
- The journal precedes the causality index, and the index precedes visible
  observation.
- One serialized registration gate orders ingress, local issue, and pending
  publication after recovery.
- Pending and published outbox records are both recovery candidates;
  publication state controls egress, not admission.
- Reconnect accepts `already-installed` trust only through the trust store's
  exact-byte equality result. Conflicting trust state remains fatal.
- Durable low-frequency operations belong on this path. Ephemeral movement,
  aim, and physics do not.
- The node package root export remains closed; the product uses only the narrow
  `@ts-drp/node/v3-live` subpath.

## Code and evidence

- Composition and public product boundary:
  [`packages/node/src/v3-live.ts`](../../../packages/node/src/v3-live.ts),
  especially `recoverV3LiveReplica`, `activateV3LivePlane`, `routeV3Ingress`,
  and `V3PlaneHandle`.
- Browser artifact:
  [`examples/v3-chat/src/index.ts`](../../../examples/v3-chat/src/index.ts).
- Two-client and reconnect acceptance:
  [`tests/phase-3a1b-d9336-two-client-room.pw.ts`](../../../tests/phase-3a1b-d9336-two-client-room.pw.ts).
- Recovery, reconciliation, activation, local issue, and transport contracts:
  `tests/phase-3a1b-d9336-*-red.test.ts` and
  `tests/phase-3a1b-p3-live-transport-red.test.ts`.

The browser acceptance passes both the initial exchange and durable reconnect
cases in about two seconds. The retained five-file live-plane set passes 27/27
in about seven seconds. Node/example builds, example typecheck, ESLint,
Prettier, and diff checks pass. Package-wide node typecheck still reports only
the two pre-existing compact-history helper union diagnostics at
`tests/helpers/compact-history-scale-1i-b.ts`.

## Divergences and rejected approaches

- The original plan kept every node export private. A real browser artifact
  could not consume that boundary, so the shipped design added one explicit
  `./v3-live` subpath while leaving the package root closed.
- Treating an identical persisted trust anchor as a fresh-install error made
  warm reconnect impossible. The artifact now distinguishes the trust store's
  authenticated `already-installed` result from a conflict or store failure.
- The initial bootstrap reused the visible `message` operation. Once recovery
  correctly exposed prior accepted views, that implementation detail became a
  user-visible chat line. Bootstrap is instead a distinct `join` operation.
- Replaying sinks from activation was rejected because it would mix recovered
  state reconstruction with live subscription and create a second effect path.
  The application hydrates from authenticated recovery output before activation.
- The legacy chat was never accepted as evidence for this path because it does
  not exercise the v3 composition owner.

## Boundary

This record closes D.93.36. It does not establish missed-history repair while a
client is offline, dynamic writer grants, arbitrary reducer convergence,
Firefox/WebKit parity, Phase 3b, or completion of the broader production
hardening plan.
