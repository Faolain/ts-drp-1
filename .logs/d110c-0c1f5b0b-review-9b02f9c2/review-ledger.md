# D.110c-0c1f5b0b rejected GREEN review

The reviewed production GREEN is signed commit `93585bf3`; its signed evidence
anchor is `9b02f9c2`. The formal review is rejected because the P0/P1 union is not
empty.

| Reviewer      | Verdict |  P0 |  P1 |  P2 | Terminal handling                                                                                                                                                                                                                                 |
| ------------- | ------- | --: | --: | --: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Grok 4.6/high | PASS    |   0 |   0 |   2 | The runner classified the first turn `NO_VERDICT` only because prose preceded a valid JSON verdict. Exact session `01a06b91-5e05-71a3-b14e-9210eb60e9d6` was resumed once for schema-only re-emission; its substantive verdict was unchanged.     |
| Kimi K3/100   | PASS    |   0 |   0 |   8 | The original direct CLI turn stopped making progress while two internal reads remained pending. It was interrupted after preserving raw output, then exact session `session_8bc80621-d5c6-4a05-8123-d4ad0096bcc4` was resumed for synthesis only. |
| Opus xhigh    | BLOCK   |   1 |   3 |   3 | Completed normally with exact JSON in the CLI result envelope.                                                                                                                                                                                    |

## Blocking union

1. P0: the new unprofiled control predicate makes `join` and `causalJoin`
   control-only under `creator-trusted-v1`, bypassing reservation and sink
   delivery and removing them from the application projection/fold. This
   contradicts the frozen legacy-unchanged constraint and breaks reachable
   legacy paths.
2. P1: the displaced-row filter drops ordinary same-store sequence-zero rows,
   causing legacy work loss and omitting a settlement source from planning.
3. P1: settlement recovery no longer cross-checks the outbox row against the
   durable issued row, weakening the existing corruption latch.
4. P1: the new generic unknown-outcome return runs before terminal handling,
   so an ambiguous terminal transaction no longer latches the plane terminal.

The corrective RED also owns Opus's actionable P2s: malformed settlement-plan
values must return a typed fail-closed result, and the legacy join/causalJoin
plus affected shared-fixture suites must enter the retained gate. The latent
payload-seeded control-set observation remains owned by f5b0c/f5b before a
retained payload can carry settlement controls.

## Other P2 dispositions

- Frontier binding and classifier-local terminal/incarnation suppression stay
  with f5b0c/f5b, where the authenticated checkpoint frontier is first wired.
- Replacement `planEffect` authority and terminal-entry validation stay with
  f5b0c; the current public type remains unchanged.
- The stricter settlement-advance shape reason is accepted and documented;
  it is a fail-closed diagnostic refinement, not an acceptance change.
- The corrective RED expectation adjustment remains accepted because
  `planEffect` is transaction command metadata, while restart verification now
  authenticates the durable fence bytes and signature directly.
- The inherited Node typecheck failures will be captured again in corrective
  GREEN evidence and compared with its untouched parent.

No P2 overrides or reduces the blocking union.
