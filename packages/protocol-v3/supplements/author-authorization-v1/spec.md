# Current-epoch author authorization v1

This repository-governed supplement freezes the complete protocol-v3 ordinary-writer authorization snapshot. Its closed canonical carrier has exactly `authors`, `epoch`, `kind`, `objectId`, `profileId`, `protocolMajor`, and `version`. The digest is the existing `hashDomain` framing over `ts-drp/author-authorization/v3` and the exact canonical carrier bytes.

The carrier is nonempty and at most 8192 bytes. `authors` contains one through 64 unique lowercase 64-hex raw Ed25519 public-key identities, already in strict ascending unsigned ASCII order. The runtime never sorts or normalizes input. The exact literals are kind `drp-author-authorization`, profile `creator-author-authorization-v1`, protocol major 3, and version 1. Epoch is a safe nonnegative integer and object identity uses the existing protocol-v3 storage-object text predicate.

The authenticated current anchor authorizes only the complete carrier whose digest equals `aclDigest` and whose object and epoch match. Signer sets, anchor signers, operator maps and implicit creators confer no author authority. This seam defines no roles, deltas, wildcards, delegation, revocation, transport, persistence, activation, reducer, publication or deployment behavior.

The supplement itself is not a runtime package subpath. The separate published TypeScript subpath `@ts-drp/protocol-v3/author-authorization` owns exactly two runtime functions and seven type exports. The package root remains exact runtime ten.
