# Equivocation digest identity v1

This additive profile refines the frozen D.37 candidate universe without changing it. A remote slot is
the exact `(objectId, author, authorSequence)` tuple. A vertex identity is the registered 32-byte digest
of the exact authenticated received canonical preimage bytes. Decoded or re-encoded bytes and signature
bytes never define that identity.

## Classification

- An authenticated redelivery with the same digest is one vertex and is a duplicate, including when a
  different accepted signature carrier authenticates the same exact preimage.
- Two authenticated vertices with unequal digests in one slot are equivocation, including when the
  operation is unchanged and only `dependencies` or `logicalTime` differs.
- Every valid envelope remains admitted. A duplicate, gap, descendant, proof, resolution, or advisory
  count never feeds back into envelope validity.

For a duplicate with another signature carrier, persistence selects the lexicographically least canonical
carrier record. Existing proof bytes are rebuilt from that carrier under the same proof IDs. This makes
the final stored carrier independent of arrival while producing no new evidence announcement.

## Canonical standalone proof

There is exactly one proof for each unordered digest pair. The two vertex entries are ordered by their
32-byte digests. The proof is canonical encoding of:

```text
{
  kind: "drp-equivocation-proof",
  profile: "equivocation-digest-identity-v1",
  protocolMajor: 3,
  slot: { objectId, author, authorSequence },
  vertices: [
    { digest, domain, expectedAnchor, preimage, signature, suiteId },
    { digest, domain, expectedAnchor, preimage, signature, suiteId }
  ]
}
```

Its identity is
`hashDomain("ts-drp/equivocation-proof/v1", lesserDigestBytes, greaterDigestBytes)`. Verification must
decode canonical bytes without substitution, require the closed schema and ordered unequal digests,
authenticate both exact included preimages and signatures through the authoritative author key resolver,
recompute both registered digests, and require both included slot tuples to equal the declared slot.

## Persistence, resolution, and advisory accounting

The injected exact-slot transaction store owns atomic slot durability and serialization. Authentication
and input detachment finish before entering it, and no result or slot advisory signal is observable before
a successful commit. Resolution orders all observed digest identities lexicographically and prefers the
least digest; it does not reject or invalidate any fork.

All pair proofs persist and each newly persisted proof ID is returned exactly once. With `forks` distinct
digests, proof storage may therefore be O(forks²). The per-slot advisory limit only partitions the proof
count into within-limit and over-limit accounting; it suppresses, deletes, rates, or gossips nothing.
Phase 0o-b owns cross-slot per-author aggregation, durable retention and compaction, gossip/rate budgets,
ACL-visible reputation composition, and the corresponding concurrent-store contract.

## Frozen D.37 binding

This supplement binds the unchanged D.37 tuple:

- `author-lineage-actions.qnt`: `7971a025959164f609f4509bf4242f94fc4cc0b6974dde903bf462852983f038`
- protected test: `affc5e439220e8ac6353c0795f591da3946a6aeb37d69a71a05763f229f34f6d`
- fixture: `474c83e7a3f130504e8dedc8ceb0843ee3413ca56c27003a354f6088b0f41dcf`
- signed-field derivation: `e693b3fec5ef0d73299642d49e5ab7fdc969df80214f1d9891a05e188d1b7346`
