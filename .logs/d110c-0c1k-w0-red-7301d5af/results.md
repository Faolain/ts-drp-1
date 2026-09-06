# D.110c-0c1k W0 RED result

- Completed: `2026-09-04T03:59:58Z`.
- Exact selection: one test file, four tests.
- Result: 0 passed, 4 failed, 0 skipped/todo; runner `success=false`.
- Classification: causal RED. Stage/open diverges at 31/64/65, both `SCANNABLE_BYTES` paths silently omit oversized candidates, the 16,384 authorization decisions match the old `.find` oracle but rescan members after open, and the authenticated default-4 per-author capacity owner is absent from all ingress/local gates.
- No module-resolution, import/export, or unexpected runtime error occurred.
- The RED does not raise `maxEpochVertices` and does not authorize W2.

