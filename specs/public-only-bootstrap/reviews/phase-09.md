# Phase 09 — Should the native circuit-relay-v2 auto-reservation be quiesced so RelayPolicy is the sole reserver?

**Method note (honesty):** everything below is from reading the actual installed
library source (`node_modules/.pnpm/@libp2p+circuit-relay-v2@4.2.8`,
`@libp2p/webrtc@6.0.26`, `libp2p@3.3.5`) and DRP's own source. No live node was
run in this phase; runtime outcomes are code-traced predictions, cross-checked
against phase-08's earlier empirical run. Claims are labeled verified (read in
source) vs. inferred (traced consequence).

## 1. Installed version + the exact auto-reservation trigger (verified)

Installed: **`@libp2p/circuit-relay-v2@4.2.8`** (single copy in the pnpm store).

The 4.2.8 machinery, from source:

- **Trigger = generic `/p2p-circuit` listen addresses.** Each listen addr that
  matches `CircuitSearch` (a bare `/p2p-circuit` with no relay prefix) registers
  one *pending reservation*:

  `dist/src/transport/listener.js` `listen()`:
  ```js
  if (CircuitSearch.exactMatch(addr)) {
      this.log('searching for circuit relay servers');
      // start relay discovery
      this.reservationId = this.reservationStore.reserveRelay();
  }
  ```

  `dist/src/transport/reservation-store.js`:
  ```js
  reserveRelay() {
      const id = nanoid();
      this.pendingReservations.push(id);
      this.#checkReservationCount();
      return id;
  }
  ```
  and `#checkReservationCount()` fires `relay:not-enough-relays` whenever
  `pendingReservations.length > 0`, which the transport converts into
  `RelayDiscovery.startDiscovery()` (`transport/index.js` constructor).
  So: **desired auto-reservations = count of generic `/p2p-circuit` listen
  addrs** — phase-08's claim is **VERIFIED**.

- **Candidate sources once discovery is armed** (`transport/discovery.js`):
  1. **Connected-peer HOP harvest (always on):** `RelayDiscovery.start()`
     unconditionally registers a topology on `/libp2p/circuit/relay/0.2.0/hop`;
     every connected peer that identifies with HOP fires `relay:discover` →
     `reservationStore.addRelay(peerId, 'discovered')`. Gated only by the
     pending count: `addRelay` throws `HadEnoughRelaysError` when
     `type === 'discovered' && this.pendingReservations.length === 0`.
  2. **Peer-store scan** for peers whose protocols include HOP (bypasses the
     `discoveryFilter`, dispatches `relay:discover` directly).
  3. **Random walk** via `components.randomWalk` — in `libp2p@3.3.5` this is
     backed by `peerRouting` (`dist/src/random-walk.js`), so with no peer
     router it yields nothing ("fails gracefully").
  4. **`peer:discovery` events:** while discovery is running it dials *every*
     discovered peer (`maybeDialPeer`, concurrency 5, 5 s timeout each) so that
     identify + the topology harvest can find relays.

- **A second, listen-independent trigger (verified, missed by phase-08):**
  `transport/index.js` `onStop()` — if a peer dials us via a relay the native
  store has no reservation on:
  ```js
  if (!this.reservationStore.hasReservation(connection.remotePeer)) {
      this.log('dialed via relay we did not have a reservation on, start listening on that relay address');
      await this.components.transportManager.listen([connection.remoteAddr.encapsulate('/p2p-circuit')]);
  }
  ```
  i.e. inbound relayed dials auto-create a `configured` native reservation.

- **Options (verified from `dist/src/index.d.ts`):** `CircuitRelayTransportInit`
  = `discoveryFilter`, `maxInboundStopStreams`, `maxOutboundStopStreams`,
  `reservationCompletionTimeout` + `TransportReservationStoreInit`
  (`reservationConcurrency`, `maxReservationQueueLength`,
  `reservationCompletionTimeout`). **There is no `discoverRelays` and no option
  that disables discovery/auto-reservation** — phase-08 **VERIFIED**.
  (`discoveryFilter` only filters the topology; the peer-store scan dispatches
  `relay:discover` directly past it, so it is not a disable switch.)

## 2. Is it active in DRP's base config? (code-traced)

`packages/network/src/node.ts`:
- line 532: `transports: [circuitRelayTransport(), webRTC(), webSockets()]` —
  **zero options** to the transport.
- line 510: default `listen: ["/p2p-circuit", "/webrtc"]` — **one** generic
  circuit listen ⇒ one pending native reservation ⇒ discovery **starts at
  boot**.

Where candidates come from in the base host:
- No DHT/peer router ⇒ random walk starves (phase-08's "no peer router" is
  right, but it only starves source 3).
- `@libp2p/bootstrap` + `@libp2p/pubsub-peer-discovery` are installed
  (node.ts:413-429) and both emit `peer:discovery` ⇒ discovery **dials every
  announced peer**.
- DRP relays/bootstrap nodes run `circuitRelayServer()` when
  `relay_service.enabled` (node.ts:450-457) ⇒ they advertise HOP ⇒ the
  topology harvest fires for them.

**Verdict: armed AND able to fire — not merely starving.** The first connected
HOP-advertising peer (typically a DRP bootstrap relay, dialed at startup via
`_dialBootstrapWithRetry`) gets a native `'discovered'` reservation that
consumes the pending slot. This races *ahead* of `RelayPolicy` (which starts in
`_startRelayPolicy()` after libp2p start and does inspect/reserve rounds), so
the native mechanism usually wins the first reservation. Only in a topology
with zero HOP-speaking reachable peers does it truly starve — and then it
degrades into a perpetual discovery loop that dials every pubsub-discovered
peer forever.

**Correction to phase-08:** phase-08 said DRP's `Libp2pRelayClient` is "a
parallel reservation path that never touches the native transport's reservation
store". **REFUTED.** `packages/relay-policy/src/libp2p-client.ts:131-134`:
```ts
const circuitAddress = multiaddr(`${relayAddress}/p2p-circuit`);
...
await this.#host.components.transportManager.listen([circuitAddress]);
```
That specific (`CircuitListen`) address routes into the native transport's
listener (`libp2p@3.3.5` `transport-manager.js` `listen()` creates a listener
per matching addr), whose `CircuitListen` branch calls
`reservationStore.addRelay(relayConn.remotePeer, 'configured')`. So every
policy reservation **is also a native-store `'configured'` reservation**: DRP
first sends its own raw HOP RESERVE (`libp2p-client.ts` `#requestReservation`,
`framed.write(Uint8Array.of(8, 0))`), then the native listener sends a second
RESERVE. Server-side this is one slot refreshed, not two slots
(`server/reservation-store.js` `reserve()`: "refreshing reservation for client"
when the peer already has one). Net effect: the native store owns the refresh
timer and keep-alive tag for policy-chosen relays — the two systems already
cooperate on `'configured'` reservations. The ambiguity is only the
**`'discovered'` path** armed by the generic `/p2p-circuit` listen.

## 3. Conflict / harm assessment (code-traced)

Not catastrophic, but not benign either:

1. **Off-policy reservation.** The native `'discovered'` reservation lands on
   the first-connected HOP peer, chosen by connection order — not by
   RelayPolicy's diversity/operator-group rules. Its circuit addr (and the
   derived `/webrtc` addr) is announced. Policy accounting
   (`_reservedRelayPeerIds`, operator groups, control-plane events) never sees
   it.
2. **Reservation count drift.** `'configured'` reservations (policy-driven) do
   NOT consume the pending `'discovered'` slot (`addRelay` returns the existing
   reservation without popping `pendingReservations`). So the node ends at
   `target_reservations + 1`, or — if every reachable HOP peer is already a
   policy relay — the slot never fills and **discovery runs forever, dialing
   every `peer:discovery` peer** (pubsub discovery announces every ~5 s). That
   is real, ongoing dial churn caused solely by the generic listen.
3. **Churn on disconnect.** When the native `'discovered'` relay's connection
   closes, the store removes the reservation, re-queues the pending id, and
   restarts discovery.
4. **Cross-listener cancel footgun (upstream behavior, worth knowing):**
   `transport/listener.js` `close()` calls
   `this.reservationStore.cancelReservations()` — all circuit listeners share
   one store, so closing ONE listener clears the local refresh timers of ALL
   native reservations. DRP's `Libp2pRelayClient.release()` closes per-relay
   listeners during `replace()`, so a single policy replacement silently stops
   native refresh for the surviving relays. Self-healing exists (DRP's own
   `_scheduleRelayRefresh` re-RESERVEs server-side, and `onStop` re-listens on
   inbound), but it is churny and worth a pinning test. This is independent of
   the quiesce question but interacts with it.

No harm found in the dial path or STOP handling: the RESERVE collision is a
server-side refresh, and the relay server keys reservations per peer.

## 4. Safe quiesce options, ranked

**(a) Drop the generic `/p2p-circuit` from the default listen set — SAFE and
effective (recommended).**
- Verified: DRP's `Libp2pRelayClient.reserve()` adds its own specific
  `<relay-multiaddr>/p2p-circuit` listen (libp2p-client.ts:131-134) and waits
  for the addr to be advertised — so policy-driven reachability does NOT depend
  on the generic listen. `transportManager.listen()` works at any time on a
  started node regardless of the configured `addresses.listen`.
- With zero generic listens, `pendingReservations` stays empty forever ⇒
  `#checkReservationCount()` emits `found-enough-relays` ⇒ discovery never
  starts, topology harvest throws `HadEnoughRelaysError` instantly, no
  `peer:discovery` dial churn. The STOP handler is registered in
  `transport.start()` unconditionally, so inbound relayed connections still
  work.
- **`/webrtc` interaction — verified safe:** `@libp2p/webrtc@6.0.26`
  `private-to-private/listener.js` `getAddrs()` derives `/webrtc` addrs from
  *any other transport's* circuit listen addrs
  (`.filter(Circuit.exactMatch).map(ma => ma.encapsulate('/webrtc'))`). It does
  not care whether the circuit listener came from a generic search or a
  specific policy listen. Policy reserves ⇒ circuit addrs exist ⇒ `/webrtc`
  addrs exist.
- **The one real risk:** a node whose config has NO
  `control_plane.relay_policy` (or no enabled sources) never runs
  `_startRelayPolicy()` (it returns early, node.ts:666, 747) and would then
  have **no relayed reachability at all**, where today native discovery could
  serendipitously reserve on a connected DRP relay. Mitigation: only drop the
  generic listen when a relay policy is configured (compute the default listen
  from the same predicate `_startRelayPolicy` uses), or accept + document that
  policy-less nodes are dial-only.

**(b) A transport option to disable discovery — NOT AVAILABLE in 4.2.8.**
Verified against `CircuitRelayTransportInit`: no `discoverRelays`, no
`discovery: false`. `discoveryFilter` cannot serve as a disable switch (the
peer-store scan bypasses it, and the discovery dial loop is driven by the
pending count, not the filter). Do not attempt.

**(c) Leave as-is and document — defensible but weaker.** The native path is
NOT provably starving in DRP's base config (bootstrap relays speak HOP), and
when it does starve it degrades into perpetual discovery dialing. "Benign
redundancy" is the wrong description; "mostly harmless churn plus one
off-policy reservation" is accurate. Acceptable only if the extra reservation
on a DRP-owned relay is considered a feature (belt-and-suspenders reachability
before the policy converges).

## 5. Recommendation

**Quiesce via (a), conditionally:** default `listen` to `["/webrtc"]` (plus any
configured addrs) when `control_plane.relay_policy` with sources is configured;
keep `["/p2p-circuit", "/webrtc"]` for policy-less configs. Smallest change:
one conditional at node.ts:510 keyed on the same predicate as
`_startRelayPolicy()`. This makes RelayPolicy the sole *initiator* of
reservations (the native store still executes and refreshes them via the
specific listens — that is the cooperation we want, not a conflict).

Pinning tests:
1. **No off-policy reservation:** start a node (policy configured) connected to
   an extra HOP-serving relay that is NOT in any policy source; assert the
   relay server's reservation store never gains an entry for the node, and the
   node's `getMultiaddrs()` never contains that relay's `/p2p-circuit` addr.
2. **Policy reachability intact:** after `RelayPolicy` reserves, assert
   `getMultiaddrs()` contains `<relay>/p2p-circuit` AND the derived
   `<relay>/p2p-circuit/webrtc`, and a second peer can dial the node through
   the relay (STOP path) and upgrade to webrtc.
3. **No discovery churn:** with pubsub-peer-discovery emitting peers, assert
   the node does not auto-dial announced non-relay peers (e.g. count
   `connection:open` events or assert the circuit transport's discovery never
   ran via its logger/metrics).
4. **Replace() refresh regression (footgun #4):** reserve on two relays,
   `replace()` one, then advance past the refresh window and assert the
   surviving relay's server-side reservation is still refreshed (guards the
   shared-store `cancelReservations()` interaction).
5. **Policy-less config keeps legacy behavior** (if the conditional default is
   chosen): node without `relay_policy` still auto-reserves on a connected DRP
   relay.
