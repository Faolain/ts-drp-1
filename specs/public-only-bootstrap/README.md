# Public-Only Bootstrap Experiment

Issue: [Faolain/ts-drp-1#5](https://github.com/Faolain/ts-drp-1/issues/5)

## Next Agent Prompt

Status: Slices 00-02 complete; Slice 03 is next. Last updated: 2026-07-20.

Start with [Slice 03](slices/03-browser-public-routing.md). Preserve the existing
Phase 09 registry-shaped campaign unchanged. Do not send public traffic until
the user supplies the exact acknowledgement
`I_ACKNOWLEDGE_ISSUE_5_PUBLIC_NETWORK_TRAFFIC_AND_OPERATOR_TERMS`. Update this
section before ending a pass.

Global checklist:

- [x] [Freeze the public-only and anti-cheat contract](slices/00-public-only-contract.md).
- [x] [Extract one reusable live Relay v2 client](slices/01-live-relay-client.md).
- [x] [Make one DRP Node the Amino provider and grid creator](slices/02-node-publisher.md).
- [ ] [Discover the provider and reserve a relay from a real browser](slices/03-browser-public-routing.md).
- [ ] [Prove or falsify the composed grid path](slices/04-public-only-grid.md).
- [ ] [Measure across browsers and two network conditions](slices/05-public-campaign.md).

## Goal

Prove or falsify that existing public IPFS/libp2p infrastructure can cold-start
DRP without a custom registry, a DRP-operated relay, a pre-shared DRP Peer ID,
or a fixed DRP address.

The success chain is:

1. one real DRP Node joins the public Amino DHT;
2. that same identity obtains a public relay reservation and advertises its
   browser-dialable circuit address;
3. it provides a deterministic opaque namespace CID;
4. a browser learns the provider only from the public delegated-routing API;
5. the browser independently obtains a public relay reservation;
6. it dials the provider-returned address, joins the DRP GossipSub/object data
   plane, synchronizes and mutates the grid, and proves direct WebRTC bytes.

A bounded failure is a valid result. Fixture fallback is not.

## External facts and research

- The IPFS Foundation documents `https://delegated-ipfs.dev/routing/v1` as the
  current public delegated-routing endpoint and publishes official Amino
  bootstrappers through `_dnsaddr.bootstrap.libp2p.io`:
  <https://docs.ipfs.tech/concepts/public-utilities/>.
- Public utilities are explicitly best-effort and are not intended as a
  production critical path.
- js-libp2p documents automatic relay discovery/reservation, but a relay address
  appears only after a reservation is successfully negotiated:
  <https://github.com/libp2p/js-libp2p/blob/master/doc/CONFIGURATION.md>.
- Circuit Relay v2 requires an explicit reservation before a peer is dialable
  through the relay: <https://docs.libp2p.io/concepts/circuit-relay/>.

## Scope firewalls

- No registry URL, registration, discovery, signed registry record, or
  `RendezvousDirectory` is allowed in the success path.
- No owned/community DNSADDR relay and no fallback callback is allowed.
- Public IPFS bootstrap Peer IDs are infrastructure seeds; no DRP Peer ID or
  address may be present in browser config, URL, storage, or control messages.
- The browser receives only an opaque namespace, deterministic object ID,
  explicitly reviewed delegated endpoint, and bounded limits.
- Provider and relay results are untrusted observations, not authorization.
- No production default or reconnect behavior changes in this experiment.
- Ordinary CI remains loopback-only. Live checks are explicit, manual, capped,
  sanitized, and excluded from deterministic CI.

## Single-owner architecture

The refactor-clean pass identified four concepts that must have one owner:

- `NodeRouting` owns Amino DHT operations; the public-only Node attaches it to
  the same libp2p identity that owns DRP and the grid.
- `RelayPolicy` owns selection, diversity, deadlines, lifecycle, and terminals;
  one extracted libp2p relay client owns Identify/HOP/RESERVE wire mechanics.
- The public-only contract owns anti-cheat inputs, budgets, milestones, and
  verdicts. The Phase 09 campaign contract remains separate and unchanged.
- The grid's existing synchronization and direct-byte oracle remains the only
  success oracle; the public-only coordinator supplies a different discovery
  source rather than copying the data plane.

Private fixture relay mechanics are transitional scaffolding. Slice 01 promotes
them to their natural owner and deletes the duplicate fixture implementation in
the same slice.

## Slice graph

```text
00 contract
   ↓
01 live relay client
   ↓
02 one-host Node publisher ──→ 03 browser public routing
                                  ↓
                           04 public-only grid
                                  ↓
                           05 measured campaign
```

Each slice must receive adversarial Grok and Kimi CLI review with maximum
reasoning, followed by focused tests, package typecheck, workspace typecheck,
lint, and the relevant browser gate. Any visual evidence must receive an
unprimed `screenshot-critique` review before acceptance.

## Verdict semantics

A single success proves feasibility only for that browser, network, and time.
It does not prove authorization, privacy, availability, or an SLA.

- Failure before provider visibility falsifies the tested DHT publication and
  browser address shape.
- Provider visibility without a browser-dialable address falsifies the anchor
  advertisement strategy.
- HOP discovery with bounded reservation exhaustion rejects public relays as a
  dependable baseline for the measured condition.
- Mesh/sync success without direct-byte growth proves relayed DRP operation but
  not the direct-upgrade requirement.
- Endpoint-wide outage, CORS, or rate limiting is recorded as an inconclusive
  public-utility outage, never converted into fixture success.
