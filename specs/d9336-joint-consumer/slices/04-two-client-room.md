# Slice 04: Two-Client Room Exchange

Add a dedicated v3 chat artifact rather than relabeling the legacy chat. Two
isolated browser clients consume the same authenticated join bundle with two
pre-authorized P5 identities, join one room, each issue a visible message and
observe both accepted operations in the same order.

The first proof targets Chromium; Firefox and WebKit remain broader gates. The
artifact reports accepted-operation and durable transcript digests, not an
unowned general synchronization claim.

## Shipped checkpoint

The tests-only RED is signed at `a1d990c6d04995981ccf8b27bce0e7480cd19769`.
The product GREEN is signed at `18eb903528af0328f6ba69ab50d25bfdcf863391`.

`examples/v3-chat` uses two genuine P5 keychain authors, the real browser
authorization-history, issuance and live-journal stores, and the shipped
`@ts-drp/node/v3-live` composition owner. `BroadcastChannel` is only the
external transport boundary; received vertices still enter through the genuine
v3 ingress path. Both isolated Chromium clients accepted the same two issued
messages in the same order with equal operation and transcript digests.

The Playwright checkpoint passed 1/1 in about 1.2 seconds. The five retained
live-plane suites passed 27/27 in 7.20 seconds. The node package build, example
typecheck and build, targeted ESLint, Prettier, and diff checks passed. Package
typecheck retained only the two known compact-history test-helper diagnostics.
A bounded Codex review ended `NO_VERDICT` without a reproduced Slice 04 defect;
under the user-authorized fast track it was recorded rather than retried.

Slice 04 is closed. Slice 05 owns reopening a client from its durable browser
stores, recovering before subscription, exchanging another operation, and
converging again.
