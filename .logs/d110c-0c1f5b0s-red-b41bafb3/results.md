# D.110c-0c1f5b0s initial RED result and disposition

- Exact selection: one test file, 45 tests; 24 passed and 21 failed.
- The initial RED was causal against the unimplemented native contract, but a later GREEN attempt exposed a latent test-helper defect: after a successful replacement at sequence 0, duplicate-link rejection incorrectly expected pristine lineage and no issued row.
- GREEN stopped at 42/45 and made no commit. Tests-only correction `b207e40ea196036b0f8cca357a50fce5fe154531` now preserves the actual preexisting state.
- This root is retained as the immutable initial diagnostic. The corrected accepted RED is `.logs/d110c-0c1f5b0s-red-b207e40e/`.

