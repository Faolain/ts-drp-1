# Equivocation author projection v1

This additive deep-only profile composes `equivocation-evidence-projection-v1` without amending the
frozen 0o-a persistence, admission, resolution, `slotSignal`, standalone verification, or
`newlyPersistedProofIds` contracts.

The coordinator is constructed only from injected storage and authority. For reconciliation it
once-captures the requested scope, calls `readCommittedSlotState` for an authoritative full-slot
snapshot, detaches every current committed witness, and authenticates every witness before any
irreversible author projection write. It does not read `state.proofs`, caller digest lists, caller
proof IDs, or `newlyPersistedProofIds`.

For one slot, `newDigests = committedDigests - priorDigests`. The stored digest set is updated by
monotone union, never replacement. The coordinator enqueues the canonical
`newDigests × postUnionDigests` cross-product after removing self-pairs and collapsing each unordered
pair. Exactly one pending identity is enqueued over the author store lifetime for each scope and
canonical unordered distinct digest pair. Pending removal never removes the durable digest-set dedup
fact, so retry, concurrency, drain, and redelivery do not re-enqueue it.

The injected author transaction co-commits the slot projection and all pending rows. The slot store and
author store need not span one transaction. `enumerateCommittedAuthorSlots(author)` is therefore a
required independent author-scoped recovery source; an existing author-record slot list is not an
enumeration substitute. Recovery re-reads and reconciles every enumerated committed slot, including a
slot whose first author projection write was lost.

A pending row contains only detached scope strings/integer, two lowercase digest strings, and their
pair identity. It stores zero proof bodies, zero payload copies, and zero `Uint8Array` values. No
bounded proof, carrier, resolver-result, or authentication cache is durable authority.

Before handoff, the coordinator re-reads current committed witnesses and invokes the accepted 0o-b1a
current-witness materialization helper. Pure proof-ID derivation or a pending row is never evidence.
Scope, canonical digest pair, and proof ID are recomputed. A stale carrier, byte-swap TOCTOU,
unauthenticated witness, missing current carrier, or mismatched row fails closed and leaves the row
pending. Successful drain removes only that pending row.

`handoffProof` is at-least-once across a crash after successful external handoff but before pending-row
removal. This profile makes no exactly-once external delivery claim, adds no acknowledgement API, and
adds no payload outbox.

The profile adds no default store, wall clock, budget, reputation, gossip transport, ACL mutation,
witness/proof compaction, or global evidence-storage bound.
