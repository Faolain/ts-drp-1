# D.110c-0c rejected first RED execution

- Plan anchor: `8d2d729e146da1fcaa4374d552bb8ef84eed7512`
- Selected inventory: exactly one Chromium test in one file; no campaign title.
- Reporter result: expected=0, skipped=0, unexpected=1, flaky=0; no top-level errors.
- Duration: 3,754.872 ms overall; 1,962 ms test body.
- Result: rejected as non-causal fixture evidence. The run stopped before pending recovery with `D.108d2 snapshot scope is ambiguous`; the frozen RED token was absent.
- Diagnosis: `packages/node/src/creator-close.ts::persistSnapshot()` receives `registration.currentTrust.currentEpoch` and `currentAnchorDigest`. Therefore the genuine `2→3` transition snapshot is keyed by closing epoch 2/current anchor, while epoch 3 belongs to the pending head and successor trust.
- Correction: select the unique verified epoch-2 scope for this exact `2→3` transition. Workload, orderings, product path, authority, thresholds, and recovery semantics remain unchanged.
- This result is not a product failure, does not satisfy RED, and is never relabeled as causal evidence.
- The earlier package-relative protected-path predicate stopped before Playwright was invoked and created no evidence root; it was a faulty launcher diagnostic, not an execution.

Reporter SHA-256: `1dcbdc8cdeb34769d5e756d669e20e4cd47d2d118c99dfde4f09c1393205b14d`.
