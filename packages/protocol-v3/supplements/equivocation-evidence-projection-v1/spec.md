# Equivocation evidence projection v1

This additive profile hash-binds and composes the frozen `equivocation-digest-identity-v1` artifacts. It
does not amend them. Every authenticated witness and every canonical proof body in `state.proofs`
persists, and `newlyPersistedProofIds` keeps its frozen exactly-once meaning for conforming Phase 0o-a
state. This profile authorizes no witness compaction, proof-body compaction, global storage bound,
pending lifecycle, budget, reputation, gossip transport, ACL mutation, payload outbox or
acknowledgement API.

## Pair projection

`deriveEquivocationProofId(leftDigest, rightDigest)` accepts exactly two distinct 32-byte registered
digests, detaches them, orders them lexicographically and returns the lowercase hexadecimal value of
`hashDomain("ts-drp/equivocation-proof/v1", lesserDigest, greaterDigest)`. Reversing the pair cannot
change the ID. Wrong types, wrong lengths and equal digests throw `TypeError`; inputs are never mutated.

The projection identity is only a structured slot plus an unordered pair of distinct digests. It stores
zero proof bodies and zero payload-bearing outbox rows. That zero-copy statement is not a retention or
total-evidence bound.

## Current proof reconstruction

`materializeCurrentEquivocationProof({ scope, vertices, resolveAuthorPublicKey })` captures and detaches
one structured `(objectId, author, authorSequence)` scope and exactly two current persisted witnesses.
It authenticates each exact received canonical preimage and signature through the authoritative
resolver, recomputes and matches each stored digest, requires both decoded slots to equal the supplied
scope, rejects an equal/self-pair, canonicalizes digest order and returns the current canonical proof
bytes with its recomputed pair ID. Invalid, malformed, wrong-key, wrong-scope, wrong-digest or wrong
carrier input returns `undefined` before output.

The returned bytes must be accepted by `verifyEquivocationProof`. A lexicographically lesser accepted
same-digest signature re-carrier changes the reconstructed bytes to the current carrier while leaving
the unordered-pair proof ID unchanged. No stale carrier payload is authoritative.
