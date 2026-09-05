# Corrective f5b0d review ledger

## Blocking union

The union is two P1 findings, both from Opus. The three-line backend
future-epoch repair is accepted by all reviewers; f5b0d remains open because
the rejected first GREEN left two invalid recovery-surface changes in the
tree.

1. **Legacy recovery cap was widened.** `packages/node/src/v3-live.ts` still
   uses `maxEpochVertices * 3` in the historical-issuance context. That context
   is reachable for `creator-trusted-v1`, not the settlement profile, so this
   reverses the accepted compatibility requirement. Owner: corrective f5b0d.
   Required disposition: causal tests-only RED, then restore the legacy
   one-epoch bound; the settlement-profile rollback-window proof remains parent
   f5b-owned.
2. **Invalid retained oracles remain green.** The first f5b0d test still calls
   a comment/source substring proof “production invocation” and pins the wrong
   3x constant. Owner: corrective f5b0d. Required disposition: remove or replace
   those invalid assertions and ensure retained totals do not claim them as
   behavioral evidence. Parent f5b remains blocking for real hot/restart/cold
   reachability and the settlement recovery bound.

## P2 disposition

- Grok's source-containment warning is the same second P1 above and is assigned
  to corrective f5b0d plus parent f5b's behavioral RED.
- Kimi's raw RED assertion only captured the first failure; accepted as an
  evidence note because Chromium captured code, row loss and watermark, while
  GREEN executes every frozen assertion. Owner: f5b0d evidence.
- Kimi's inherited typecheck baseline was verified independently but not
  byte-compared in the packet. Nonblocking; future f5b packets must retain the
  explicit baseline comparison. Owner: inherited/f5b evidence.
- The published `./maintenance` subpath is an intentional trusted same-realm
  exact-store capability, not package-private. Correct its JSDoc in the same
  narrow GREEN if touched; no threat-model expansion. Owner: f5b0d.
- The store does not authenticate checkpoint fields or `terminalThrough` by
  itself. Parent f5b must derive and compare the exact authenticated boundary
  and RED an over-boundary caller. Owner: f5b.
- Replay currently echoes `closedEpoch` without revalidating old rows. Parent
  f5b must not consume that receipt as independent checkpoint proof and must
  compare/rederive the epoch. Owner: f5b.
- A large authenticated prefix is one transaction. Parent f5b must use a
  reviewed bounded per-invocation/epoch schedule without changing the backend
  contract silently. Owner: f5b.
- The rejected post-hoc replay block and false authority comment remain for
  parent f5b to delete/restructure through the causal production integration
  RED. They are not accepted reachability evidence. Owner: f5b.

No P2 closes f5b0d or authorizes parent production work before the blocking
correction and its confirmation are green.
