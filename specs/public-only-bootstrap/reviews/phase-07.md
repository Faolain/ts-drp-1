# Phase 07 — Enabling the Node Overflow Relay Tier: Design Decision & Security Tradeoff

Date: 2026-07-22

This records the design decision behind enabling DRP's **node overflow
circuit-relay-discovery tier** and the security tradeoff it accepts. It is the
context for the round-3 implementation (after two adversarial review rounds found
the naive enablement inert and, worse, regressing existing features).

## What the tier is, and when it engages

A Node/Electron peer normally connects through **operated** Circuit Relay v2
relays (configured/infra relays it or a partner runs). The overflow tier is the
fallback: **when the operated relays are offline or cannot reach the target
reservations, the node walks the public Amino DHT (`clientMode:true`) and uses
whatever browser/node-dialable Circuit Relay v2 relays it discovers.** It is
best-effort and only engages in that degraded state (Phase 05 verified such
relays exist and grant reservations; Phase 06 verified the walk mechanism and
root-caused why DRP's conservative DHT config made it non-functional).

## The operator-diversity requirement (why the naive tier fails)

DRP's relay policy (`relay-policy/src/index.ts`, defaults) requires:

- `requiredReservations: 2` — hold two relay reservations,
- `requiredOperatorGroups: 2` with `maxPerOperatorGroup: 1` — from **two distinct
  operators**, at most one relay per operator,
- and `#requirementsMet()` counts **only operators it can cryptographically
  verify** (evidence-derived), discarding any relay classified `"unknown"`.

**Why this rule exists (the security property it buys):** a circuit relay is your
connectivity lifeline and sees your traffic **metadata** (who you broker WebRTC
with, when, how often); it can also **censor** you (drop your reservation) or, if
it controls *both* your relays, **eclipse** you (control your whole view of the
network) and correlate/deanonymize your activity. Requiring two
**verified-independent** operators is the **anti-Sybil / anti-fake-diversity**
property (Phase 5): an attacker can cheaply spin up thousands of relays, but they
all collapse into one *unverified* bucket — they cannot manufacture two
*verified-distinct* operators. It forces a real adversary to compromise two
independent operators.

## The design tension

Public DHT-discovered relays are **anonymous** — they carry no operator evidence,
so the classifier returns `"unknown"` for all of them. Trace it:

- `maxPerOperatorGroup: 1` on the single `"unknown"` bucket ⇒ the policy reserves
  **at most one** DHT relay.
- `#requirementsMet()` discards `"unknown"` ⇒ that reservation counts as **zero**
  verified groups ⇒ `0 < 2` ⇒ **never "reserved."**

So the overflow tier can physically reserve one working relay, but the policy's
success condition — *two verified-independent operators* — is **structurally
unreachable from anonymous relays.** The terminal stays `"exhausted"`, is reported
as `outcome:"failed"` despite a live relay, and **every relay disconnect triggers
another expensive ~30–45s DHT re-walk** chasing a target it can never hit. The
security model (verified diversity) and the source (anonymous public relays) are
mutually exclusive by construction.

## Decision: relax operator diversity for the overflow tier

**We accept unverified, anonymous DHT-discovered relays as a degraded best-effort
fallback.** Overflow reservations count toward a degraded "reserved" outcome; the
tier is allowed more than one `"unknown"` relay; and reaching the degraded target
stops the re-walk churn. This is scoped to **the overflow tier only** and only
matters **when operated relays are unavailable** — normal operation still uses the
verified-diversity path unchanged.

### What we are giving up, and why it's acceptable here

Relaxing diversity means accepting relays we **cannot prove are independent.** An
attacker running many DHT relays could occupy both slots and **funnel all your
connectivity through attacker-controlled relays** — observing metadata,
correlating/deanonymizing, censoring, or eclipsing you. That is a real security
downgrade. It is acceptable in this **specific, bounded** case because:

1. It only engages in a **degraded fallback** — when your trusted operated relays
   are down — i.e., the alternative is **no connectivity at all**.
2. DRP data stays **authenticated end-to-end**: a relay **cannot read or forge**
   your encrypted objects — it only sees connection metadata/timing and can
   censor. So the cost is **metadata privacy + censorship-resistance in the
   fallback**, not data integrity or membership authorization (those remain
   governed by the DRP signatures and membership model, unchanged).
3. It is **opt-in** (`control_plane.relay_policy.sources.node_closest_peers`) and
   off by default.

Operators who need the stronger property should run/rely on operated relays; this
tier is explicitly the "better than nothing when the floor is gone" path.

## The resource-model problems the naive enablement introduced (and how they're handled)

Two adversarial review rounds (grok + kimi + fable) found the first enablement was
not just structurally inert (above) but **actively regressed existing, shipped
features**, because a public DHT walk fights DRP's resource-bounding model:

- **Global anchor regression (discarded):** the walk needs high DHT query breadth
  to converge, so the first pass dropped the conservative public `alpha:1 /
  disjointPaths:1` for **every** public DHT op — regressing rendezvous **anchor**
  queries (they could exhaust the shared 128-request budget mid-operation). Fix:
  keep the conservative defaults for shared/anchor routing; apply bounded
  discovery-appropriate concurrency **only** to the overflow discovery routing.
- **Global browser-relay regression (discarded):** the collection-window
  re-derivation shrank the shared acquire window 5s→3s, regressing the existing
  **browser/delegated-routing** relay path. Fix: keep the original window for the
  non-overflow path.
- **Lifetime budgets vs recurring walks:** `maxNetworkRequests` and `maxOperations`
  are **lifetime, unresettable** circuit-breakers (default/cap 128) — a deliberate
  DoS bound from when Node routing was a bounded experiment. A **recurring**
  operation (a walk on every disconnect) exhausts them, after which *all* routing
  (anchors included) throws permanently. Fix: give walks their own **windowed**
  budget; ordinary ops keep their existing bound.
- **Buffered walk:** `getClosestPeers` buffered all peers and yielded only after
  the walk resolved, so a timeout (common for public walks) yielded **zero**. Fix:
  **stream** peers as they arrive so partial results survive a timeout.
- **Blocking startup:** the post-attach retry was `await`ed, hanging startup ~1–2
  min when relays are down. Fix: fire-and-forget (the promise never rejects).
- **Retry suppression:** the "consulted" flag flipped when an empty cold-DHT walk
  *started*, skipping the retry with no later recovery. Fix: only treat the tier as
  satisfied when it actually holds enough (degraded) reservations.

## Net posture

The overflow tier is a **degraded, best-effort, metadata-untrusted** connectivity
fallback that engages only when operated relays are down. It relaxes operator
diversity by explicit decision, preserves end-to-end data authentication, is
opt-in, and must not regress anchors or the browser relay path (those regressions
are reverted/scoped). Run ≥1 operated relay for the trusted path; this is the
floor-is-gone fallback.
