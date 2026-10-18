# Causal matrix

## Final accepted run

| Class | Count | Result |
| --- | ---: | --- |
| Selected | 12 | exact one file |
| Compatibility controls | 3 | pass |
| Causal product obligations | 9 | fail |
| Skipped/todo | 0 | none |

Passing controls:

1. Local frontier generation rejects missing/altered causalJoin ABI before
   issuance.
2. Genuine signed legacy ingress rejects an unregistered causalJoin at
   authenticated extraction/catalog admission before journal or sink.
3. Settlement-profile join remains control-only.

Causal failures:

1. Legacy causalJoin is omitted from sink delivery; the same case carries the
   post-GREEN fold-membership assertions (current failure occurs at the first
   sink equality).
2. Legacy join is no longer exposed as an application-visible displaced
   operation.
3. Legacy same-store, non-creator sequence-zero displaced row is skipped and
   sequence one is surfaced instead.
4. Settlement same-store, non-creator sequence-zero displaced row is skipped
   and sequence one is surfaced instead.
5. Settlement recovery accepts an issued/outbox mismatch instead of returning
   `issuance-rejected` / `v3 recovery issued record does not match`.
6. An ambiguous committed terminal transaction returns without
   `terminalIntent: "outcome-unknown"`; the same case checks the terminal latch
   after that first mismatch is repaired.
7. A settlement plan with non-array `entries` rejects the promise by throwing
   instead of resolving a typed fail-closed result.
8. An accessor-backed settlement plan rejects the promise by throwing instead
   of resolving a typed fail-closed result.
9. A settlement plan with a top-level extra key is accepted and issues a fence
   instead of resolving a typed fail-closed result.

## Preserved diagnostics

- Initial: 11 selected, 1 pass, 10 fail, 0 skip. Four results were contaminated
  by an out-of-scope bootstrap variable; the fold probe used state bytes not
  bound by the signed anchor. This result is diagnostic only.
- Corrected: 11 selected, 2 pass, 9 fail, 0 skip. Fixture-clean. It established
  that the local bad-ABI case is a compatibility control rather than causal.
- Final: 12 selected, 3 pass, 9 fail, 0 skip. Fixture-clean and accepted.

