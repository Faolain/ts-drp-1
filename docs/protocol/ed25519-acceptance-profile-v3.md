# Protocol v3 Ed25519 acceptance profile

Status: normative post-freeze supplement

Profile: `ts-drp-ed25519-acceptance-v1`

Protocol major: `3`

Suite: `ed25519-sha256-v3`

## Authority and scope

This addendum closes the Ed25519 verification ambiguity in the frozen protocol-v3 tuple at checkpoint
`907fae437e558145f63614cd6b5de925ea4bd8c2`. It is additive: it does not replace, restamp, or modify any
Phase −1′ registry, specification, amendment, vector, reference, lock, freeze policy, checker, workflow,
or governance evidence.

The authoritative frozen policy is
`packages/protocol-v3/conformance/freeze-policy-v3.json`, SHA-256
`fa2a69d4113f73bbd657d4490189b472a2ae04b5bdc88d35d2de5c87e572ccc3`. Its 47 protected paths have
the frozen state digest `023e7b50c11eff2d5fd4d0d8c5ea6da8d54ad095d73d24b7d3badea2e3769637`
when each row is `path || NUL || sha256-or-ABSENT || LF` in policy order.

This profile governs signature acceptance for a protocol-v3 registered digest. It does not change
canonical preimage construction, domain-separated SHA-256 digest derivation, author-key resolution,
issuance transactions, transport encoding, or publication.

## Normative message and encodings

The Ed25519 message is `raw-32-byte-registered-digest`: the exact 32 digest bytes produced by the frozen
registered-byte rules. Implementations MUST NOT sign or verify the digest's hexadecimal text, UTF-8
representation, JSON wrapper, canonical wrapper, or any other transformed value.

The public key `A` MUST be exactly 32 bytes using
`canonical-compressed-edwards-y-32`. The signature MUST be exactly 64 bytes, split as the 32-byte point
encoding `R_bytes` followed by the 32-byte little-endian scalar `S`. `R_bytes` MUST use
`canonical-compressed-edwards-y-32`. Both point encodings MUST decode canonically under strict noble
2.2.0 behavior; unreduced/noncanonical Edwards-y encodings are rejected.

The scalar rule is `0 <= S < L`, where
`L = 2^252 + 27742317777372353535851937790883648493`. Verifiers MUST reject `S = L`, `S > L`, and a valid
signature changed to `S + L`; they MUST NOT reduce an out-of-range `S` before verification.

The public-key rule is `reject-small-order`. After canonical decoding, a small-order public key `A` is
rejected before equation acceptance.

## Normative verification equation

Let `B` be the Ed25519 base point. Compute the challenge exactly as
`k = SHA-512(R_bytes || A_bytes || raw_registered_digest) mod L`, using the received canonical point
bytes and the raw 32-byte registered digest.

Acceptance requires the cofactored equation
`[8][S]B = [8]R + [8][k]A`.

The small-order public-key rejection above is an additional admission rule. The profile does not require
`A` or `R` to be in the prime-order subgroup. In particular, canonical mixed-order points remain
accepted when the cofactored equation holds. Implementations MUST NOT add a blanket mixed-order,
torsion-free, or full-subgroup rejection: doing so would diverge from this profile.

## Executable definition

The executable definition is noble-curves 2.2.0:

`ed25519.verify(signature, rawRegisteredDigest, publicKey, { zip215: false })`

The protocol adapter MUST first require the `64 / 32 / 32` byte widths for signature, raw registered
digest, and public key respectively, then invoke that exact call. Invalid types, widths, scalars, point
encodings, small-order public keys, or failed equations return rejection. There is no Node `crypto`,
OpenSSL, WebCrypto, platform-provider, ZIP-215, retry, or fallback admission path.

## Reference role and conformance

The original and regenerated frozen Phase −1′ references retain the role
`byte-and-digest-oracle-only`. They remain authoritative for their frozen registered preimage and digest
bytes. Node/OpenSSL results produced by those references or diagnostic probes are not signature-
acceptance authority when they diverge from the executable definition above.

The governed vectors in
`packages/protocol-v3/supplements/ed25519-acceptance-profile-v1/vectors.json` include raw-message
substitution, small-order, out-of-range scalar, noncanonical point, and independently sourced
mixed-order cases. A conforming live receiver MUST apply this same profile after all pre-crypto
registered-byte checks and author-key resolution, with no decode/re-encode digest substitution.

## Change control

The machine amendment, this addendum, the permanent vectors, additive freeze policy, checker, workflow,
RED test, and permanent input fixture form one atomic supplement. Their separate additive policy
protects all eight artifacts while leaving unrelated additive repository work outside this supplement
unrestricted. Any future change to a protected supplement artifact requires a new explicitly governed
successor profile; silently weakening or restamping this profile is forbidden.
