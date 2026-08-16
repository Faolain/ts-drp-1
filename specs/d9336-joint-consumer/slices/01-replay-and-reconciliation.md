# Slice 01: Complete Replay and Reconciliation

Extend the same recovery owner from one local record to the complete immutable
journal snapshot and full issuance outbox.

Every received carrier and local issuance reference passes genuine extraction.
Local references additionally require recomputed, envelope and journal digest
equality. Paging is exhaustive and cursor-monotone; cross-kind echoes append
zero; missing dependencies and capacity stalls remain durable and re-evaluable.

This slice adds evidence, not a second abstraction or store.

## Shipped checkpoint

The signed RED at `0773c3866c030c0fbd03b94bc6360289fad6524c`
introduced a real SQLite retained-journal recovery case. The signed GREEN at
`93ea1da` extends the existing `v3-live` composition owner without adding a
second coordinator, store or authorization path.

Recovery now re-authenticates retained received rows, reconstructs retained
local rows from durable issuance, requires recomputed/envelope/journal digest
agreement, preserves cross-kind idempotency and reconciles the full pending and
published outbox before activation. The compact final-byte gate passed 10 files
and 127 tests in 28.66 seconds; the focused retained-journal and authorized
recovery rows passed 3/3, and the node package build and static checks passed.

Bounded Codex, Grok, Kimi and Opus reviews produced no reproduced P0/P1. Their
nonterminal runs are recorded as `NO_VERDICT`, not approval and not a blocker to
this shipped slice. Slice 02 owns serialized activation and live ingress; this
checkpoint does not claim two-client convergence.
