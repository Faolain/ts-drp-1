# Exact causal matrix

| File / obligation | Expected | Observed |
| --- | --- | --- |
| Phase-3g legacy structural `causalJoin` | Fail because e07f8a94 exposes an application intent and does not complete structural retirement | Failed at the exact deep-equality assertion |
| Corrective legacy structural `join` | Fail because e07f8a94 exposes an application intent and does not complete structural retirement | Failed at the exact deep-equality assertion |
| Legacy ordinary `ISSUANCE_OUTCOME_UNKNOWN` | Fail because e07f8a94 returns `issuance-rejected` instead of the parent-compatible `admission-rejected`; the test also pins the halt | Failed at the exact result-kind assertion |
| All other focused controls | Pass | 24 passed |
| Missing import/export/setup or top-level error | None | None |

Per-file counts from the full reporter:

- `tests/phase-3g-v3-rebase-outbox-red.test.ts`: 14 total, 13 passed, 1 failed.
- `tests/phase-6b-d110c-0c1f5b0b-node-corrective-red.test.ts`: 13 total, 11 passed, 2 failed.

The separate settlement fence ambiguous-outcome test remains unchanged and continues to expect `issuance-rejected`. Settlement `join`/`causalJoin` control-only tests, legacy ingress/sink/fold/application-accounting tests, and all other controls remain unchanged and passed.
