# Phase 08: Deterministic Failure Campaign

## Contract

Every issue-listed failure reaches a bounded recovery/fallback or typed terminal
diagnostic with complete telemetry and no leaked timers, controllers,
connections, or refresh work.

## API seam

Table-driven `FailureScenario`, `FaultSchedule`, and `FailureCampaignReport`
consume the same Phase 01 seams and Phase 07 coordinator.

## Runnable artifact

`failure-campaign --fixture all` produces machine-readable evidence and a
generated sanitized Markdown/HTML summary.

## Verification

- Delegated outage, DNS/CORS failure, 429, stale/poisoned/malformed/oversized
  responses.
- 50–90% undialable candidates and all reservations refused.
- Relay loss during signaling, after reservation, and after direct upgrade.
- One/all registries unavailable.
- Replayed, expired, oversized, forged, and Sybil-flooded registrations.
- Stale DNSADDR fallback.
- Hard deadlines, attempt/backoff caps, terminal reasons, cleanup, and
  telemetry coverage asserted for every row.
- The composed all-dependencies-down scenario consumes the Phase 00 child
  budgets under one 30 s parent deadline; no retry may reset it.
- Typed control-plane health/reconnect behavior is exercised by the spike
  adapter. Production reconnect redesign remains a Phase 10 design deliverable.
- Capture report views and run screenshot-critique.
- Run the every-phase review and quality gate.

## Must stay green

No public network access; all scenarios use deterministic fixtures.

## Feedback that changes this phase

Any newly discovered production-relevant failure class must be added as a
scenario rather than narrated only in the ADR.
