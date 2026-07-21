# Public IPFS Routing, DRP Rendezvous, and Opportunistic Relay Spike

Issue: [Faolain/ts-drp-1#5](https://github.com/Faolain/ts-drp-1/issues/5)

## Next Agent Prompt

Current status (2026-07-20): Phases 00, 01, 01b, 02, 03, 03b, 04, 05, 06, 07,
and 08 are complete. Phase 09 is complete. The opt-in control plane
precomputes 806 tasks and a 12,920-request cap, serializes every endpoint owner
behind one cooldown/allowlist ledger, fixes task composition in-repository,
enforces per-task deadlines, emits only pre-registered decision-cell
aggregates, binds evidence to scheduled tasks, emits typed partial cells, and
rejects incomplete or privacy-unsafe reports.
[The Phase 09 review](reviews/phase-09.md) records the initial reviewer
rejections, tested dispositions, and final Grok/Kimi `ACCEPT` verdicts.

Public execution remains honestly `environment-blocked`: no exact operator
authorization, two independently operated signed-registry endpoints, or
authorized materially distinct second egress was supplied. The committed
artifact contains zero public requests and no synthetic trials. Implement the
decision package in
[slice 10](slices/10-decision-package.md).

- [x] Phase 00: evidence contract and thresholds
- [x] Phase 01: deterministic probe kernel
- [x] Phase 01b: injectable DRP network seam
- [x] Phase 02: Node Amino DHT harness
- [x] Phase 03: browser delegated-routing lab
- [x] Phase 03b: browser full-DHT feasibility verdict
- [x] Phase 04: signed rendezvous record
- [x] Phase 05: two-endpoint registry and DHT-anchor comparison
- [x] Phase 06: opportunistic relay policy
- [x] Phase 07: disconnected-joiner grid demonstration
- [x] Phase 08: deterministic failure campaign
- [x] Phase 09: opt-in public protocol and relay campaign
- [ ] Phase 10: ADR, security/privacy analysis, and implementation plan

Before ending a pass, update this section with the exact last completed gate,
next pickup point, active blockers, and checklist state.

## Goal

Produce the evidence-backed architecture decision required by issue #5. The
spike must prove or reject the proposed control-plane pieces without making
ordinary tests or production availability depend on the public IPFS network.
The existing GossipSub/object synchronization data plane stays unchanged.

The final proof is a playable grid demonstration in which a joiner starts
without a pre-shared DRP Peer ID, discovers a signed DRP participant, joins its
GossipSub mesh, synchronizes and mutates the grid, establishes direct WebRTC,
and recovers or terminates cleanly after relay loss.

## Current measured baseline

- HEAD inspected: `978f957`.
- Clean tracked worktree; unrelated untracked
  `docs/wip-upgrade-ai-notes.md` is user-owned.
- Node 22.15.0, pnpm 10.24.0, libp2p 3.3.5, Circuit Relay v2 4.2.8,
  WebRTC 6.0.26 (repository patch applied), WebTransport 6.0.31,
  Playwright 1.51.1, Vitest 3.1.1, TypeScript 5.8.2.
- `@libp2p/kad-dht`, `@libp2p/tcp`, and
  `@helia/delegated-routing-v1-http-api-client` are not installed.
- Baseline `pnpm typecheck`: pass.
- Baseline `pnpm lint`: pass with 71 pre-existing warnings and no errors.
- Baseline `CI=1 pnpm test --run`: 79 files passed, 572 tests passed,
  2 skipped, 94.77% statement coverage.

The lockfile and generated run manifest, not this prose, own exact versions
after spike dependencies are added.

## Architecture and ownership invariants

The spike has two private workspace surfaces:

- `packages/network-spike`: experiment contracts, Node probes, routing
  adapters, signed-record validation, registry server/client, relay policy,
  deterministic fixtures, telemetry, aggregation, and CLI commands.
- `examples/network-spike`: Vite browser workbench and a dedicated Playwright
  matrix for Chromium, Firefox, and WebKit.

Durable sanitized evidence, reviewer outcomes, and decision documents live
under this spec. Raw Peer IDs, IP addresses, full namespaces, admission tokens,
and endpoint credentials must not be committed.

Each concept has one owner:

- `ProbeRunner` owns clocks, seeded randomness, abort budgets, and cleanup.
- `AddressPolicy` owns address classification and dialability decisions.
- `ProbeEvent` is the only experiment telemetry vocabulary.
- `NodeRouting` owns Amino DHT lookup and publication.
- `BrowserRouting` owns delegated lookup and explicitly cannot publish.
- `SignedDrpRecordV1` and `RecordValidator` own rendezvous authenticity and
  replay/limit checks.
- `RegistryClient` owns signed-registry endpoint failover/backoff.
- `BrowserRouting` owns delegated Routing V1 endpoint failover/backoff.
- `RelayPolicy` owns candidate qualification, reservation lifecycle, rotation,
  and fallback.
- `EvidenceReport` owns coverage validation and threshold verdicts.
- `ControlPlaneHostFactory` owns spike-only libp2p host construction used by the
  grid proof. Production `DRPNetworkNode` continues to own the message queue,
  GossipSub data plane, and network interface; the factory may only replace host
  construction through the Phase 01b seam.

Production packages may be consumed by the spike; they must not depend on it.
Do not create a second production `DRPNetworkNode`, compatibility aliases, or
duplicated retry/address policies. The greenfield instruction means a later
production migration may replace old config directly, but this investigation
must first preserve the fixed bootstrap/owned-relay path required by issue #5.

## Shared typed seams

```ts
interface Probe<T> {
	readonly id: string;
	run(context: ProbeContext): Promise<ProbeResult<T>>;
}

interface NodeRouting {
	findPeer(peerId: string, signal: AbortSignal): Promise<PeerResult>;
	getClosestPeers(key: Uint8Array, signal: AbortSignal): AsyncIterable<PeerResult>;
	provide(cid: string, signal: AbortSignal): Promise<PublicationReceipt>;
}

interface BrowserRouting {
	readonly canProvide: false;
	findPeer(peerId: string, signal: AbortSignal): Promise<PeerResult>;
	findProviders(cid: string, signal: AbortSignal): AsyncIterable<PeerResult>;
	getClosestPeers(key: Uint8Array, signal: AbortSignal): AsyncIterable<PeerResult>;
}

interface RendezvousDirectory {
	register(record: SignedDrpRecordV1, signal: AbortSignal): Promise<RegistrationReceipt>;
	discover(namespace: string, signal: AbortSignal): Promise<ValidatedDrpRecord[]>;
}

interface RelayPolicy {
	acquire(source: AsyncIterable<RelayCandidate>, signal: AbortSignal): Promise<ReservationOutcome>;
	refresh(reservation: Reservation, signal: AbortSignal): Promise<ReservationOutcome>;
	replace(reason: RelayLossReason, signal: AbortSignal): Promise<ReservationOutcome>;
}
```

Lookup and publication stay separate because the Helia delegated content
routing adapter implements `provide()` as a no-op.

## Slice graph

```text
00 evidence contract
  └─ 01 deterministic probe kernel
       ├─ 01b injectable DRP network seam
       ├─ 02 Node Amino DHT
       ├─ 03 browser delegated routing
       ├─ 03b browser full-DHT feasibility
       ├─ 04 signed rendezvous record
       └─ 06 relay policy
02 + 03 + 04 ─ 05 registry and DHT-anchor comparison
02 + 03 ─ 06 routing-backed relay policy
01b + 03 + 04 + 05 + 06 ─ 07 disconnected-joiner grid demonstration
01 + 07 ─ 08 deterministic failure campaign
02 + 03 + 06 + 07 ─ 09 opt-in public campaign
02 + 03 + 03b + 04 + 05 + 07 + 08 + 09 ─ 10 decision package
```

## Pre-registered evidence classes and decision thresholds

Every threshold is owned by a named evidence class, sample rule, and statistical
interpretation. Missing coverage is a failed evidence requirement, not a
zero-valued measurement. Public rates are observed-rate decisions with Wilson
95% confidence intervals, never availability SLAs.

| Decision                                     | Evidence source and sample                                                                      | Threshold / interpretation                                                                                                                |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Node DHT cold bootstrap                      | Phase 09, 100 fresh Node identities per real condition                                          | observed success at least 95%; p95 at most 30 s; report Wilson interval                                                                   |
| Delegated first valid DRP peer               | Phase 09, 100 fresh identities per browser/condition, balanced across transport profiles        | observed success at least 95%; p95 at most 20 s; report Wilson interval                                                                   |
| GossipSub mesh and first synchronized object | Phase 07, 5 deterministic repetitions per browser                                               | every repetition passes; p95 at most 30 s; demonstration SLO, not public rate                                                             |
| Public relay as supported baseline           | Phase 09, 100 fresh identities per browser/condition total, 50 per randomized transport profile | observed reservation success at least 95% and p95 at most 20 s per profile; report Wilson interval                                        |
| Public relay as optional overflow            | Same Phase 09 cells                                                                             | observed reservation success at least 50% per profile; exhaustion delays owned fallback at most 5 s                                       |
| Public relay diversity for baseline          | Phase 09 aggregate reservation cells                                                            | at least two coarse operator/ASN groups with accepted reservations; otherwise baseline is no-go, overflow remains independently decidable |
| Controlled direct WebRTC upgrade             | Phase 07, 5 deterministic repetitions per browser                                               | every repetition passes within 20 s with correlated non-relay ICE/libp2p proof and nonzero bytes both ways                                |
| Public direct WebRTC upgrade                 | Phase 09 public grid canary, one run per browser/condition                                      | report-only with outcome and latency; Phase 10 chooses an SLO, no fleet claim                                                             |
| Relay/registry loss recovery                 | Phase 08 deterministic matrix and Phase 07 repetitions                                          | every deterministic scenario reaches its specified recovery/fallback within 60 s                                                          |
| Total outage                                 | Phase 08 composed worst-case fixture                                                            | terminal diagnostic within 30 s, capped attempts, no leaked work                                                                          |

The 100 browser trials satisfy the issue's per-browser/per-condition minimum;
the two transport profiles are balanced within that budget rather than
multiplying it. One hundred trials can support an overflow/no-go decision, not a
production availability SLA. The working recommendation is public relay
overflow only with owned DNSADDR fallback; evidence may make the verdict
stricter. Any change to source, sample count, CI method, or threshold after
collection requires a visible amendment and invalidates comparability.

## Composed deadline budget

The total-outage path has one 30 s parent deadline. It allocates at most 8 s to
the two registry/delegated endpoints, 5 s to relay candidate search and owned
fallback initiation, 12 s to owned DNSADDR/fixed-relay connection, and 5 s to
terminal cleanup/reporting. Child retries consume their parent's remaining time
and never restart the parent budget.

## Every-phase gate

After each phase-sized change:

1. Run the focused tests/artifact for the phase.
2. Run a read-only Grok adversarial review:

   ```bash
   grok --cwd "$PWD" --output-format plain \
     "Read-only adversarial review of phase NN against issue #5. Inspect the diff, tests, evidence quality, boundedness, security, and scope firewalls. Use a maximum reasoning/turn budget of 100. Return ACCEPT or blocking findings." \
     --max-turns 100 --permission-mode plan --no-subagents --disable-web-search
   ```

3. Run a read-only Kimi adversarial review:

   ```bash
   kimi-cli --work-dir "$PWD" --plan --print --thinking \
     --max-steps-per-turn 100 \
     -p "Read-only adversarial review of phase NN against issue #5. Inspect the diff and seek false positives, missing failure paths, unbounded retries, unsafe public-network behavior, and acceptance gaps. Return ACCEPT or blocking findings."
   ```

4. Save concise findings and dispositions in `reviews/phase-NN.md`. Resolve
   high/blocking findings, then rerun the affected reviewer.
5. Run `pnpm typecheck`, `pnpm lint`, and `CI=1 pnpm test --run`.
6. Browser phases also run their dedicated Chromium, Firefox, and WebKit
   Playwright project.

Public probes are separately opt-in and never determine deterministic CI
success.

## Standing browser evidence gate

Any browser-visible evidence view or grid checkpoint must be captured in a
current full screenshot plus tight crops of key status/timeline/diagnostic
regions. Run the `screenshot-critique` skill with a fresh, unprimed reviewer as
the last visual check. Record actionable defects and their dispositions before
accepting the phase. There is no reference-image comparison gate because this
spike has no visual target; correctness, legibility, and scanability are the
review variables.

## Scope firewalls

- Public IPFS utilities are best-effort, opt-in, and never an availability SLA.
- Public-network probes never run in ordinary CI.
- Respect endpoint terms, rate limits, explicit allowlists, low concurrency,
  cooldowns, and a hard request/trial budget.
- Routing results are untrusted dial candidates, not authorization.
- HOP advertisement is never counted as reservation acceptance.
- A DHT anchor advertises itself, never a browser peer.
- Browser delegated routing never claims provider publication.
- Node DHT/TCP dependencies never enter browser bundles.
- The existing fixed bootstrap/relay path remains runnable during the spike.
- GossipSub discovery remains post-bootstrap expansion, not initial rendezvous.
- All retry/search/refresh loops have abort signals, caps, backoff, terminal
  outcomes, cleanup tests, and telemetry.
- Public evidence is redacted by default; raw captures remain ignored/local.
- Raw capture output is restricted to `.network-spike-raw/`, which Phase 00
  adds to `.gitignore`; validation refuses any trackable raw-output path.
- Identity pseudonyms use a per-run secret salt and cannot be compared across
  runs. Operator/ASN diversity is aggregate-only; hashing public Peer IDs is not
  treated as anonymization.

## Research anchors

- [IPFS public utilities](https://docs.ipfs.tech/concepts/public-utilities/)
- [js-libp2p configuration](https://github.com/libp2p/js-libp2p/blob/main/doc/CONFIGURATION.md)
- [js-libp2p Kad DHT](https://github.com/libp2p/js-libp2p/tree/main/packages/kad-dht)
- [Helia delegated Routing V1 client](https://github.com/ipfs/helia-delegated-routing-v1-http-api/tree/main/packages/client)
- [Routing V1 HTTP specification](https://specs.ipfs.tech/routing/http-routing-v1/)
- [libp2p Rendezvous draft](https://github.com/libp2p/specs/tree/master/rendezvous)
- [Circuit Relay v2 specification](https://github.com/libp2p/specs/blob/master/relay/circuit-v2.md)
