# Phase 00: Reproducible Evidence Contract

## Contract

Freeze what constitutes a valid run before collecting measurements. A report
cannot silently omit cells, relax thresholds, or mix incompatible versions.

## API seam

`ExperimentManifest`, `TrialResult`, `CoverageRequirement`, `ThresholdSet`, and
`EvidenceReport`, `DecisionRule`, and `DeadlineBudget` in the private
`packages/network-spike` package. Each decision rule binds its evidence phase,
cell dimensions, minimum sample count, statistic/CI method, and interpretation.
Schemas must
capture git SHA/dirty state, lockfile digest, exact resolved package and browser
versions, OS/runtime, seed, target, network-condition label, transport profile,
timestamps, endpoint class, redaction state, and evidence checksums.

## Runnable artifact

`pnpm --filter @ts-drp/network-spike manifest --fixture` prints a schema-valid
example, planned matrix, and exact required trial count.

## Verification

- Schema round-trip and incompatible-version tests.
- Coverage validator rejects absent/duplicate/undersized cells.
- Threshold changes after a run require an explicit amendment record.
- The 30 s parent outage budget is decomposed into endpoint, candidate/fallback,
  owned-fallback, and cleanup child budgets; their sum cannot exceed the parent.
- Redaction validator rejects raw Peer IDs, IPs, namespaces, tokens, stable
  hashes, and trackable raw-output paths. Per-run salted pseudonyms and
  aggregate-only operator/ASN diversity are required.
- Add `.network-spike-raw/` to `.gitignore`; the manifest refuses raw output
  outside that directory when inside the worktree and tests prove raw files
  cannot appear as trackable Git changes.
- Required public request budgets are computed before consent: per condition,
  100 Node DHT identities plus 100 identities per browser, with the latter
  balanced 50/50 across transport profiles. A hard request cap accounts for all
  endpoint calls and stops before overrun.
- If a second real egress cannot be authorized, emit a partial evidence report
  whose acceptance row is `environment-blocked`; never synthesize a condition
  or describe the issue criterion as satisfied.
- Run the every-phase review and quality gate from the parent README.

## Must stay green

All existing packages and the fixed-bootstrap grid path.

## Feedback that changes this phase

A different supported-baseline/overflow policy, required browser set, or
materially different real network conditions changes the manifest matrix before
public data is collected.
