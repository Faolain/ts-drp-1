# D.110c-0c1f5b0b corrective RED evidence

Signed commit `de1eed2a6be65ed022f8b502e4cdd6208a234dd1` corrects one
test expectation without changing the causal RED or production code.

The accepted f5b0s store contract treats `planEffect` as transaction command
metadata. Durable restart truth is the atomic settlement-plan link together
with the corresponding authenticated issued/outbox row; adapters are not
required to reconstruct `planEffect` in `readIssued` after reopening.

The corrected fixture therefore selects the pending row at
`plan.fenceSequence`, recomputes and verifies its digest/signature, validates
scope and sequence, decodes the exact operation, and opens it as the matching
author fence. The focused and detached clean-worktree runs remained identical:
27 selected, 6 controls passed, 21 causal product failures, and no skipped or
unexpected failures.

The prior RED root is preserved as immutable evidence. This root supersedes
only its restart-row expectation.
