# Slice 00: Public-Only Contract

## Contract unlocked

A typed, fail-closed experiment boundary that can prove no registry, owned
relay, pre-shared DRP identity, private address, or unbounded public work entered
the run.

## API seam

Add `packages/network-spike/src/public-only/contract.ts` with
`PublicOnlyConfig`, `PublicOnlyLimits`, ordered milestones, stage-specific
terminals, a sanitized trace, and a verdict of `success`, `no-go`, `blocked`, or
`inconclusive`.

The acknowledgement and one parent deadline are mandatory. Browser inputs are
limited to namespace, object ID, delegated endpoints, and limits.

## Runnable surface and verification

- Add a CLI that defaults to a blocked, zero-request report.
- Add contract tests that reject registry URLs, fallbacks, configured DRP Peer
  IDs/addresses, local endpoints in public mode, invalid endpoints, and budget
  expansion.
- Prove every milestone terminates under a manual clock.
- Run focused tests, package/workspace typecheck, lint, Grok, and Kimi review.

## Feedback that changes this slice

Only a change to the no-registry/no-owned-relay/no-pre-shared-identity goal.
