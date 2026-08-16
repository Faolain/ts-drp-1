# Slice 02: Serialized Activation and Ingress

Activation consumes only the recovered capability. It removes the caller-owned
author resolver and direct prepared-to-live bypass.

One gate owns recovery completion, ingress, future local issue and egress. Live
ingress is ordered as authentication and admission, journal append, index append,
then post-commit observation. Subscription begins only after recovery succeeds.

## Shipped checkpoint

The signed RED at `670525bd322869b2d3087d5a81a1e36860f2f7d4`
requires activation from a recovered capability, rejects the direct prepared
bypass, and proves that dependent ingress waits for the preceding journal and
index transition. The prior Seam3 contract was migrated in signed test-only
commits `96a60f1`, `2496545`, and `a0239f6` without adding a compatibility path.

The signed one-owner GREEN at
`344dd7c902fbc54a7bf7b48e83484a08756f6d6f` consumes only the recovered
authority, derives ingress authorization from recovered state, and serializes
journal append, causality-index append, observation, and egress through the
existing registration gate. Final evidence was the focused activation set
23/23 in 5.37 seconds and compact preservation 10 files / 98 tests in 25.11
seconds, plus the node build, ESLint, Prettier, and diff checks.

The requested bounded RED review attempts ended `NO_VERDICT` without a
reproduced P0/P1. Per the fast-track instruction, no additional GREEN review
round was made a release condition. Slice 03 owns local issue, apply, and
publish; the two-client golden path is not yet complete.
