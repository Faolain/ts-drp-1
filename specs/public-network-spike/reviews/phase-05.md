# Phase 05 Review: Two-Endpoint Registry and DHT Anchor

Phase 05 implements the spike-local `RendezvousDirectory`, bounded registry,
runtime admission policies, and configured Node-anchor comparison described by
[slice 05](../slices/05-registry-and-anchor.md). Every returned record remains
an untrusted dial candidate. Neither registry admission nor DHT provider
discovery proves DRP authorization or object membership.

## Registry contract and ownership

`RegistryServer` validates every registration through the Phase 04
`RecordValidator`, stores no admission credential, sweeps expired records, and
applies hard ceilings to clients, namespaces, records, responses, and global
and per-namespace request windows. Registration accounting is bound to the
signed Peer ID rather than a caller-selected bucket. A network adapter must
derive the discovery rate key from its transport; an untrusted request body
must not control it.

`RegistryClient` requires two to four unique configured endpoints. Registration
replicates to all of them. Discovery validates each healthy endpoint and
reconciles the highest signed sequence for each Peer ID, so a primary that
missed a refresh cannot roll a recovered client back. Equal-sequence,
different-payload equivocation removes that publisher from the result.
Endpoint unions and every individual response remain capped.

Each endpoint attempt has a literal caller-enforced deadline. The client races
the call against its own timer, so an endpoint that ignores `AbortSignal` still
cannot hang the operation. Exceptions, timeouts, typed rejections, malformed
non-empty responses, and all-endpoint exhaustion produce sanitized bounded
attempt traces. A healthy empty endpoint no longer hides a populated secondary
because all healthy replicas are reconciled.

## Admission and abuse bounds

Invite-token admission is the safe default and uses a constant-work comparison.
Allowlist mode accepts exact Peer IDs. Open mode requires the explicit
`allowUnsafeOpen` acknowledgement and is labeled a Sybil-unsafe canary in code,
fixture evidence, and the browser. The multi-identity flood test proves that
open admission reaches, but cannot exceed, the configured client-capacity
boundary.

The experimental proof-of-work mode binds a versioned challenge to namespace,
signed Peer ID, issue/expiry time, nonce, and adaptive difficulty. Registration
and challenge identities must equal the signed Peer ID. Duplicate outstanding
challenge requests are idempotent. Challenge state, TTL, difficulty,
iterations, pressure step, and outstanding count are all capped. A joint
configuration invariant requires the client search budget to cover at least
eight complete search spaces at maximum difficulty; the default is therefore
15 bits with 262,144 iterations, rather than a permitted configuration that
silently rejects a large fraction of honest solvers. The challenge tag is
HMAC-SHA-256 and is independently verified before the proof counter.

Tests cover adaptive pressure, capacity, expiry, replay, wrong-client and
wrong-record binding, CPU bounds, invalid configuration, and server verification
cost. Proof-of-work raises abuse cost; it does not defeat botnets, Sybil identity
creation, or challenge-capacity pressure.

## Configured Node-anchor comparison

`namespaceAnchorCid` deterministically derives a versioned raw CID from the
opaque namespace. `DhtAnchorPublisher` can publish only its own
`NodeRouting.peerId`; attempting to advertise a browser peer throws
`AnchorAdvertisementError`. Its `stop` method delegates reprovide cancellation
to the Node routing owner.

`DhtAnchorResolver` does not promote every DHT provider to an anchor. It filters
delegated provider results against one to thirty-two explicitly configured Node
anchor Peer IDs, caps the accepted providers, and returns
`configured-node-anchor-only` semantics. The fixture deliberately yields an
unconfigured provider first and proves it is discarded.

The real local Amino-DHT regression constructs a server and publisher through
`createNodeRouting`, publishes the exact Phase 05 namespace CID through
`DhtAnchorPublisher`, observes the publisher from the server, and cancels
reprovide through the same owner. Phase 03 separately proves the bounded
delegated Routing V1 adapter; the browser comparison composes these already
tested seams without public egress.

## Measured decision evidence

The deterministic fixture now matches ten expected/actual assertions:
two-endpoint replication, refresh during primary outage, discovery failover,
monotonic refresh, all-endpoint outage, recovered stale primary reconciliation,
anchor self-publication, CID round-trip, configured delegated anchor lookup, and
configured-anchor semantics.

The comparison table contains measured fixture-operation duration plus observed
dependency-hop and visible-artifact-class counts for both paths. Its qualitative
rows state the freshness mechanism, exposed metadata, availability chain,
operator dependency, and result. Admission cards record the browser solve and
server verification duration using microseconds when a millisecond display
would round to zero. Timing is deliberately excluded from the stable sanitized
digest.

The CLI emits ten matched deterministic assertions, zero credential fields, no
token, and the stable shortened digest `sha256:cvn2f7chVZkDEr4n`. Raw Peer IDs,
namespaces, addresses, tokens, and timing traces remain outside committed
evidence.

## Browser and performance evidence

`/rendezvous` shows replication, typed failover, recovered-stale-primary
reconciliation, four admission modes, and the comparison table. `/anchor` shows
the namespace-CID to configured-Node-anchor chain, explicit browser-provider
rejection, metadata leakage, and the longer dependency chain. Both pages keep
the non-authorization and dial-time TTL/DNS recheck boundary visible.

Chrome inspection at 1440 pixels found no horizontal overflow, console error, or
public request. The final v4 pages are 4,110 and 3,411 pixels high respectively.
The instrumented registry render was about 16.6 ms. The durable Chrome
Performance flame-chart source is
`.network-spike-raw/phase-05/chrome-rendezvous-load-trace.json.gz`; its reload
contained 6,479 events with 164 ms LCP, 0.011 CLS, 64.3 ms TTFB, 117.3 ms DOM
content loaded, and 122.6 ms load.

Final screenshots:

- `.network-spike-raw/phase-05/rendezvous-desktop-v4.png`
- `.network-spike-raw/phase-05/anchor-desktop-v4.png`

The initial visual review rejected a large `ACCEPTED` label that could imply
authorization and small expected/actual values. V2 replaced it with
`RECORD FOUND / untrusted dial candidate` and strengthened evidence contrast.
The v3 review then rejected cross-reload timing ambiguity and labels that could
read as authorization or security endorsements. V4 uses same-run latency bands,
labels registrations as fixture outcomes, replaces `PROVEN` with `FIXTURE
MATCH`, and makes the ten assertions traceable as six registry plus four
anchor-specific checks. The fresh V4 review returned `ACCEPT`; it found no
clipping, overlap, horizontal overflow, count mismatch, or misleading
authorization claim. Its only notes were that the intentionally shortened
digest could be labeled more explicitly and that the smallest monospace
metadata is dense at full-page scale.

## Adversarial review

Both required reviewers ran read-only with a maximum reasoning budget of 100.

Kimi session `31fe1965-15b7-4322-8d14-3712fdb0fbf9` initially blocked on
permitted proof configurations that could reject honest work, stale-primary
rollback, mocked-only anchor-CID evidence, a qualitative-only decision table,
and missing Sybil-flood coverage. The implementation now enforces the
eight-search-space invariant, reconciles all healthy replicas with a recovery
oracle, exercises the exact anchor CID through the real local DHT lifecycle,
adds measured rows, and drives open admission to its capacity boundary.
Registration identity is also bound to the signed Peer ID; challenge issuance
is identity-bound and idempotent; the former decorative tag is now verified
HMAC.

Grok's initial review blocked on non-cooperative endpoints bypassing
signal-only deadlines, unverified `node-anchor-only` resolver semantics, and the
then-incomplete phase gate. The client now owns a literal deadline race with a
hanging-endpoint regression. The resolver filters against configured Node
anchors and labels that narrower fact precisely. The complete gate and visual
dispositions are recorded here.

Both stable-tree follow-ups returned `VERDICT: ACCEPT`. Grok confirmed the
corrected shortened digest directly; Kimi re-read the finalized review and
verified the digest, screenshot dimensions, source/test mtimes, and post-edit
browser artifact. No blocking finding remains.

## Verification

- Registry/record focused gate: 33/33 passed.
- Complete network-spike package: 9 files and 93 tests passed.
- Registry module: 88.58% statement, 80.07% branch, and 93.47% function
  coverage; registry fixture: 100% statement coverage.
- Real anchor lifecycle and local Amino-DHT fixture passed without public
  egress.
- CLI fixture: 10/10 deterministic expected/actual assertions matched; zero
  credential fields.
- Production Vite build: 524 modules, 784.74 kB JavaScript (249.07 kB gzip) and
  42.95 kB CSS (8.97 kB gzip). The aggregate multi-workbench chunk warning is
  non-blocking.
- Repository `pnpm typecheck`: passed across all workspace projects.
- Repository `pnpm lint`: passed with 71 baseline warnings and no errors.
- Phase 05 browser gate: 9/9 passed across Chromium, Firefox, and WebKit.
- Complete browser project: 63/63 passed across Chromium, Firefox, and WebKit.
- Final serial repository gate: 90 files passed, 676 tests passed, 2 skipped,
  and 87.37% statement coverage.
- No public-network request was made.
