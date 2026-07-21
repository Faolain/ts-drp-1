# Phase 10 Review: Decision Package

VERDICT: ACCEPT

The decision package closes the local investigation without overclaiming: the
measured public report is treated as missing, production public routing/relay
is no-go, and issue #5 closure is blocked on the absent authorized campaign.
Every deliverable and acceptance claim was checked against code and retained
evidence; no material blocker remains.

## Review cycle

- Initial Grok review rejected the package for a missing Phase 10 disposition,
  stale phase-bound reconnect wording, and closure/index hygiene. The
  disposition file is this record; the live reconnect marker was renamed to
  `productionReconnectRedesignUnshipped`; the historical wording was updated;
  slice files were deleted under the close-spec contract; and all retained
  review links now target the durable decision record.
- Initial Kimi review rejected a false link to the not-yet-created disposition
  and an ambiguous campaign-plan source pointer. The premature link was removed
  until both reruns completed, and the source pointer now names
  `packages/network-spike/src/campaign-plan.ts`.
- Three context-free close-spec audits independently checked architecture,
  security/production planning, and issue acceptance. Their material findings
  narrowed cancellation, address-policy, failure-domain independence,
  retry/redirect, deletion, pseudonym-salt, typed-health, telemetry, and issue
  closure claims. All three accepted the corrected package.
- Final Kimi session `eddbb737-85fb-497a-ba53-2fed04fec1ff` returned
  `VERDICT: ACCEPT`.
- Final Grok session `019f824c-61f0-71e2-82d5-8ddc8744d1c6` returned
  `VERDICT: ACCEPT`.

## Claim-by-claim verification

1. **Zero-request honesty**: `evidence/phase-09-environment-blocked.json` has
   `status: environment-blocked`, `criterionSatisfied: false`,
   `publicRequests: 0`, `observations: []`, and three unsatisfied
   `requiredInputs` (consent, independent registries, second egress) — exactly
   as the README and audit claim. `public-campaign/report.ts:262-295` generates
   this artifact, `tests/public-campaign.test.ts:173` pins the committed file,
   and the workbench renders it via `createEnvironmentBlockedCampaignReport`.
2. **Frozen plan math**: `campaign-plan.ts` with
   `campaign-primitives.ts:101-110` yields 200 node + 600 browser trials (800),
   plus six grid canaries (806 tasks), and a hard cap of
   200×4 + 600×20 + 6×20 = 12,920 — matching the Phase 09 review, config
   enforcement (`public-campaign/config.ts:133-137`), and the blocked report.
3. **"39 aggregates"**: the public-observation/report-only decision cells
   (2 + 6 + 12 + 12 + 1 + 6) sum to 39, matching the Phase 09 review.
4. **Go/no-go contract**: `contract.ts` thresholds (95%/30 s Node DHT, 95%/20 s
   delegated, 50-identity relay baseline, 50% overflow with 5 s fallback,
   600-identity/2-operator-group diversity, 5×/20 s WebRTC, 60 s recovery,
   30 s total outage) match the acceptance-audit table row for row.
5. **Fail-closed public campaign**: no `public-campaign-executors/` directory
   exists; the workflow is `workflow_dispatch`-only under a protected
   environment, requires the exact consent phrase in config
   (`public-campaign/config.ts:7`), CLI, and workflow, enforces a strict
   executor basename (`network-spike-public.yml:41-46`), and uploads only
   sanitized artifacts with `if: always()`. Ordinary CI and production never
   import campaign authority.
6. **Telemetry gaps honestly disclosed**: `registry-freshness`,
   `relay-reservation-expiry`, `relay-refresh`, `ice-candidate-pair`, and
   `transport-selected` are declared in `probe/events.ts` but have no `emit()`
   sites; the audit's telemetry table admits exactly these gaps rather than
   hiding them behind schema-only coverage.
7. **Failure-injection coverage**: all named injections exist as deterministic
   scenarios (`failure-campaign/index.ts:375-511`): delegated outage, DNS/CORS,
   429, stale/poisoned/malformed/oversized responses, undialable-50/75/90,
   all-refused reservations, relay loss during signaling, after reservation,
   and after direct upgrade, one/all registries unavailable,
   replayed/expired/oversized/forged records, Sybil flood, stale DNSADDR
   fallback, and the composed all-dependencies-down outage under one parent
   deadline.
8. **Production no-overclaim**: the production dial gate defaults to allow-all
   when no policy is injected (`network/src/node.ts:250,263`); reconnect still
   checks exact configured bootstrap Peer IDs
   (`interval-reconnect/src/index.ts:80-90`); two fixed seeds remain
   (`network/src/node.ts:49-52`); the diff touches no production defaults; and
   the spike health adapter field was renamed to
   `productionReconnectRedesignUnshipped` consistently across source, tests,
   and the failure workbench.
9. **Paths**: no stale `specs/public-network-spike` references remain; every
   README/audit/ADR evidence link resolves to an existing file; every code-map
   path exists; slice links in retained reviews were re-pointed to the closed
   decision record.
10. **Security/privacy claims grounded**: secret-salt pseudonyms
    (`node-routing/public-evidence.ts:144-249`), URL userinfo rejection
    (`public-campaign/config.ts:16`), credential/endpoint/egress redaction, and
    aggregate-only durable diversity are all present in code. No claim of
    cross-run unlinkability is made beyond what an external executor must
    separately prove.
11. **Issue closure blocked**: the README ("does not claim that issue #5's
    public-measurement criterion is complete"), the audit ("Issue #5 is not
    ready to close"), and the architecture decision ("No production public
    path is enabled by this decision") are mutually consistent. The production
    plan covers configuration ownership, typed health, observability, a
    nine-step delivery sequence, and release gates without claiming anything
    is shipped.

## Reviewer advisories and dispositions

- The Phase 08 historical review's "Phase 10 production-reconnect disclosure"
  wording was updated to the durable "unshipped production-reconnect
  disclosure" contract.
- `node-routing/public-evidence.ts:16` `SANITIZED_EVIDENCE_ROOT` now points
  into the archived `specs/done/...` tree, so a future spike canary would write
  into the retained issue evidence package. This is intentional while issue #5
  remains open for an authorized campaign; any future executor must re-review
  output ownership before use. It is not a production path.
- Reviewer test-count checks were static. The implementation owner reruns the
  executable verification matrix below before commit.

## Executable verification

- `pnpm --filter @ts-drp/network-spike build`: passed.
- `pnpm typecheck`: passed across all 21 workspace projects after rebuilding
  the network-spike declaration output.
- `pnpm lint`: passed.
- `pnpm exec vitest run packages/network-spike/tests
--coverage.enabled=false`: 13 files and 190 tests passed.
- `CI=1 pnpm test`: exited successfully. A concise confirmation run,
  `CI=1 pnpm exec vitest run --coverage.enabled=false --reporter=dot`, passed
  94 files and 775 tests, with 2 intentional skips.
- The registry timing check that appeared transiently during the canonical
  output passed 20/20 in isolation.
- `pnpm --dir examples/network-spike e2e`: two full runs each passed 113/114.
  The only failure in each was the known Firefox grid-startup timeout, first in
  repetition 3 and then in repetition 5; both exact Firefox cases passed in
  isolation (2/2). Chromium and WebKit were fully green in both runs.
- `git diff --check`: passed.
