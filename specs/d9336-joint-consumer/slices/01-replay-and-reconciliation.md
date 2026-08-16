# Slice 01: Complete Replay and Reconciliation

Extend the same recovery owner from one local record to the complete immutable
journal snapshot and full issuance outbox.

Every received carrier and local issuance reference passes genuine extraction.
Local references additionally require recomputed, envelope and journal digest
equality. Paging is exhaustive and cursor-monotone; cross-kind echoes append
zero; missing dependencies and capacity stalls remain durable and re-evaluable.

This slice adds evidence, not a second abstraction or store.
