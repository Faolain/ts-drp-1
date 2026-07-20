# Phase 00 Review: Evidence Contract

Phase 00 establishes the evidence boundary before any public-network probe is
allowed to run. The private package owns schema validation, pre-registered
decision rules, campaign coverage, redaction, bounded request accounting, and
the fixture manifest described by [slice 00](../slices/00-evidence-contract.md).

## Adversarial review

Both reviewers ran read-only with a maximum budget of 100 turns or steps.

- Grok initially returned `NOT ACCEPT` in session
  `019f7ea7-9c42-7741-b4d4-60138cf8ecf6`. It found outcomes that were not
  derived from trials, free-form Wilson intervals, an incompletely frozen
  campaign, and gaps in raw-output and redaction enforcement.
- Kimi initially returned `NOT ACCEPT` in session
  `36b9c7c9-3993-4018-b3e2-66b327e90db8`. It found omittable campaign cells,
  self-reported metrics, an incomplete decision roster, path traversal, and
  amendment/comparability gaps.
- A later Grok pass in session `019f7ebb-8420-7392-a89a-ca3c50a74efb`
  found that fallback timing was incorrectly mandatory when no fallback
  occurred, relay trials were not held to the exact transport split, and the
  privacy-preserving diversity aggregate lacked an explicit evidence binding.

The implementation now derives verdicts and Wilson intervals from trial rows,
has one canonical owner for all ten rules, validates exact public campaign
cells, binds fallback timing only to failed attempts, and binds diversity
attestations to both contributing trial IDs and the ignored local aggregate.
Campaign and threshold amendments invalidate comparability. Raw paths must be
contained, ignored, and absent from Git's index.

Final verdicts:

- Grok session `019f7ebb-8420-7392-a89a-ca3c50a74efb`: `ACCEPT`.
- Kimi session `36b9c7c9-3993-4018-b3e2-66b327e90db8`: `ACCEPT`.

The reviewers retained two non-blocking constraints for later phases. The
committed manifest is the durable anchor against a coordinated plan/fingerprint
rewrite, and Phase 07/08 must freeze their browser and failure-scenario values
when those matrices become concrete.

## Verification

- Focused package typecheck, lint, and build passed.
- Focused evidence contract: 14 tests passed, including a complete
  all-decision public-campaign fixture and negative checks for false verdicts,
  missing fallback telemetry, relay imbalance, unbound diversity, path escape,
  request overrun, and environment-blocked evidence.
- Repository `pnpm typecheck`: passed across all workspace projects.
- Repository `pnpm lint`: passed with 71 pre-existing warnings and no errors.
- Repository `CI=1 pnpm test --run --reporter=dot`: 80 files passed, 586 tests
  passed, 2 skipped.
- No browser-visible surface was added in this phase, so the screenshot review
  gate was not applicable.
- No public-network requests were made.
