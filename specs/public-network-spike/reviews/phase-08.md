# Phase 08 Review: Deterministic Failure Campaign

Phase 08 implements the owner-driven failure matrix described by
[slice 08](../slices/08-failure-campaign.md). The fixture command produces
sanitized JSON, Markdown, and HTML for 24 unique scenarios without contacting a
public network. Every row reaches its registered recovery or terminal state
under the Phase 01 probe lifecycle and exercises the Phase 07 coordinator where
the control plane participates.

## Owner and lifecycle evidence

Delegated-routing rows run through `DelegatedBrowserRouting`; registry and
hostile-record rows run through `RegistryClient`, `RegistryServer`, and
`RecordValidator`; relay qualification and reservation rows run through
`RelayPolicy`; and relay-loss/control-health rows run through
`ControlPlaneCoordinator` backed by the real policy.

The initial adversarial reviews found two material false-positive risks:
operator-limit attempts were emitted as if the dialer had run, and relay-loss
terminals could fall back to expected owner literals while replacement used a
canned result. Both were removed. Dial telemetry is now emitted only for
attempts that reached the inspector, and relay-loss terminals fail closed unless
the real coordinator/policy evidence establishes the expected path.

The three relay-loss rows are intentionally different:

- During signaling, `CampaignReservationClient.reserve` throws
  `RelayConnectionLostError`. `RelayPolicy.acquire` records
  `connection-failed`, rotates internally, and reserves the replacement. The
  coordinator has no `relay-recovery` event. Reservation telemetry is
  `aborted → accepted`.
- After reservation, the initial reservation succeeds, the creator dial fails,
  and `ControlPlaneCoordinator.recoverRelay` calls `RelayPolicy.replace`.
  Reservation telemetry is `accepted → accepted`, and the coordinator records
  `relay-recovery`.
- After direct upgrade, the completed direct proof is retained while the same
  real recovery/replacement path runs. The terminal is `direct-retained`, and
  traffic evidence remains on the direct path.

## Budgets, telemetry, and cleanup

The composed outage spends one 30,000 ms parent: 8,000 ms for registry and
routing, 5,000 ms for relay search, 12,000 ms for owned fallback, and 4,999 ms
of the 5,000 ms cleanup window. Its terminal occurs at 29,999 ms. Every child
records its own start/finish window, observes abort, and ends `timed-out`; no
retry resets the parent.

Attempts and backoffs come from owner traces, not scenario labels. The
50/75/90-percent-undialable rows observe 20 candidates and exactly 13/18/20 real
dials, including 10/15/18 real refusals. The all-refused row records four
decoded reservation refusals before owned fallback. Every row completes all
registered cleanup, stops its coordinator, and finishes with zero active timers
and zero open handles.

The campaign assertion recursively rejects raw Peer IDs, multiaddrs, IPv4
addresses, credential URLs, and the run-specific sentinel before any report is
rendered. The browser test and capture listener observed no request outside
loopback. The report UI derives totals, budgets, attempt/backoff counts, cleanup,
and final resources from the live report, labels itself `LOCAL FIXTURE ONLY`,
and enforces the Phase 10 production-reconnect disclosure.

## Browser, profiler, and visual evidence

The final browser capture was produced after the last source build:

- Sanitized campaign artifacts: 24/24 rows passed.
- Chromium/Firefox/WebKit failure-campaign E2E: 3/3 passed; the complete example
  matrix passed 111/111.
- Desktop capture: 1,440 px wide by 3,965 px tall.
- Mobile capture: 390 px viewport and document width by 7,005 px tall, with no
  horizontal overflow.
- CPU profile: 7,132 samples, 2,556 nodes, 838 unique stacks, and 1,322 ms
  sampled.
- Trace: 19,873 events, four long tasks, longest 330.996 ms; extension and wallet
  scans were clean.
- Request capture: zero public requests.

The fresh unprimed visual critique returned `ACCEPT` after checking the exact
post-fix desktop, mobile, sticky-header, budget, routing, and composed-outage
captures.

## Adversarial review

The first Grok and Kimi passes rejected fabricated operator-limit dial telemetry
and synthetic relay-loss ownership. A later Grok pass additionally found that
the signaling and post-reservation loss rows still collapsed into the same
post-reservation failure. The implementation now exercises the distinct
reservation-client, acquire-rotation, creator-dial, coordinator-recovery, and
policy-replacement paths described above, and all affected artifacts were
regenerated.

The final maximum-turn Grok review returned `ACCEPT`. The final maximum-step
Kimi review also returned `ACCEPT` after independently rerunning the package,
repository, and three-browser Phase 08 tests. Both retained only non-blocking
notes about the probe event schema representing mid-reservation connection loss
as `aborted` and an unrelated stale root Playwright status file; neither can
create a passing campaign row.

## Verification

- Network-spike package: 12 files and 170 tests passed.
- Complete example Playwright matrix: 111/111 passed across Chromium, Firefox,
  and WebKit.
- Repository `pnpm typecheck`: passed across every workspace project.
- Repository `pnpm lint`: passed with 0 errors and 80 documentation-rule
  warnings.
- Repository Vitest: 93 files and 755 tests passed, with 2 existing
  environment-gated tests skipped.
- `git diff --check`: passed.
- No public-network request was made.
