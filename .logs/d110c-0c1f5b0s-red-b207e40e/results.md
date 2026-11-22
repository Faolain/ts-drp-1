# D.110c-0c1f5b0s corrected RED result

- Completed: `2026-09-04T03:59:58Z`.
- Exact selection: one test file, 45 tests.
- Result: 24 passed, 21 failed, 0 skipped/todo; runner `success=false`.
- Classification: causal corrected RED. The failures cover the public/native plan contract, atomic fence/replacement effects, ambiguous post-commit readback, unlinked-plan pruning custody, the fourth browser store/schema version, and the Node v2-to-v3 migration.
- The 24 passing vectors execute the frozen CAS, detachment, malformed-plan, and fence/replacement precondition matrix through a test-only fallback that yields to native methods once GREEN exists.
- The initial RED's duplicate-link helper incorrectly expected pristine state after a prior successful replacement. The corrective commit instead preserves the observed lineage, issued row and plan state. That diagnostic remains under `.logs/d110c-0c1f5b0s-red-b41bafb3/`; it is not relabeled as accepted evidence.
- No import/export/module-resolution or unexpected raw runtime failure remains. No design stop rule was triggered.

