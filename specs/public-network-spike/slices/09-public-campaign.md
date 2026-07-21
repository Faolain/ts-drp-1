# Phase 09: Opt-In Public Protocol and Relay Campaign

## Contract

Collect a reproducible protocol matrix and at least 100 fresh-identity trials
per target browser and real network condition, balanced equally across the two
transport profiles,
without abusing public utilities or leaking raw identities in committed data.

## API seam

`PublicCampaignConfig` requires explicit consent, endpoint allowlist, condition
label, trial/request budget, concurrency, cooldown, and raw-output location.
`CoverageValidator` refuses incomplete reports.

The repository-owned task driver is the only production campaign driver. It
submits typed DHT, delegated, registry, relay, and grid attempts to the request
gate without receiving an arbitrary I/O callback. The environment-blocked ref
intentionally contains no usable public executor. Before any authorized run, a
protected executor must be checked into
`packages/network-spike/src/public-campaign-executors/` on that separately
reviewed execution ref; its absence keeps this ref fail-closed. The gate invokes
it once per frozen top-level attempt, passes a
task deadline signal, and rejects retry or redirect metadata. Dynamic relay
multiaddrs remain executor-private: the durable ledger records only the
configured relay accounting owner and aggregate outcomes.

Each public cell declares its rendezvous substrate:

- browser creator/joiner cells use two explicitly allowlisted, independently
  configured spike signed-registry endpoints;
- Node publisher/anchor cells use the public Amino DHT plus delegated browser
  lookup and label the anchor as Node-only.

Registry and anchor publication/lookup requests consume the same hard request
ceiling, consent, cooldown, endpoint allowlist, and redaction policy as routing
and relay requests. Registry-only outage yields a typed partial cell rather than
being misreported as public-IPFS failure.

## Runnable artifact

An opt-in local command and `workflow_dispatch`-only workflow collect:

- Node, Chromium, Firefox, and WebKit transport/Identify protocol matrix.
- WSS-only and WSS + WebTransport + WebRTC Direct profiles.
- 100 cold Node DHT identities per real network condition.
- 100 delegated first-valid-DRP-peer and relay trials per browser/condition,
  randomized and balanced 50/50 across the two transport profiles.
- One composed Phase 07 public grid canary per browser/condition using the same
  anti-cheat provenance and direct-connection oracle.
- At least two materially distinct real egress/NAT conditions; browser network
  emulation does not satisfy this requirement.
- Candidate count, address families, dial ratio, HOP ratio, exact reservation
  outcomes, candidates per success, p50/p95 latency, TTL/limits,
  refresh/replacement, and coarse operator/IP/ASN diversity.

## Verification

- Deterministic parser, statistics, confidence interval, redaction, and coverage
  tests run in ordinary CI.
- Public trials are serialized/low-concurrency and stop on rate-limit or terms
  concerns.
- Every task has a configured deadline. A hung executor becomes a typed
  `task-timeout` partial result rather than waiting for the workflow job limit.
- The manifest computes a hard endpoint-request ceiling before consent. The
  runner includes registry registration/refresh/discovery and DHT
  provide/reprovide in that ceiling, refuses any request after it, and records a
  typed partial run.
- Each run records exact package/browser/source versions and anonymized network
  descriptors.
- Raw addresses/Peer IDs stay in `.network-spike-raw/`; committed evidence uses
  per-run salted pseudonyms and aggregate-only operator/ASN groups. Authorized
  result artifacts persist only counts and pre-registered decision-cell
  aggregates, never per-trial observation rows.
- Report coverage is at least 100 trials per required cell.
- Capture the sanitized report and run screenshot-critique.
- Run the every-phase review and quality gate.

## Must stay green

No public campaign in pull-request CI and no public utility on a production
critical path.

## Feedback that changes this phase

The user must supply or authorize a second materially distinct egress condition
if the execution environment exposes only one. Until then the coverage report
is explicitly `environment-blocked` and the issue criterion is unsatisfied.
Unsafe operator terms or rate limits stop collection and become no-go evidence;
they do not justify synthetic replacement data.
