---
amendmentLog: ./amendments-v2.json
protocolMajor: 2
registryVersion: 5
specVersion: 2.0.0
status: normative
title: Attested Hard Epochs v4
---

# Attested Hard Epochs v4

## Status and scope

This document is the normative protocol-major-2 amendment surface for Attested Hard Epochs. It closes
the byte-level and consensus ambiguities that implementations must resolve before exchanging v2
artifacts. The frozen field registry remains the machine-readable authority for field order,
constraints, and domains; this document defines the relationships and operational meaning of those
values. The companion [versioned amendment log](./amendments-v2.json) binds each decision below to its
registry source.

Normative terms **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are to be interpreted as requirements on
interoperable protocol-major-2 implementations. A conforming implementation MUST apply all twelve
decisions together. It MUST NOT selectively advertise a subset as v2.

<a id="decision-01"></a>

## Decision 01 — Framed domain separation

Amendment [PH-N1-D01](./amendments-v2.json) freezes the framing rule. Every registered digest preimage
MUST be framed as `"DRP\0" || U32BE(|domain|) || domain || (U64BE(|part|) || part)*`; `44525000` is the
magic prefix, domain text MUST be UTF-8 bytes, and every part MUST have its own U64BE byte length. The
domain length MUST be U32BE. Lengths measure encoded bytes, not characters or elements.

Callers MUST use the domain registered for the artifact kind and MUST preserve part boundaries. They
MUST NOT hash an unframed concatenation, substitute a display label, omit an empty part, or merge
adjacent parts. Framing is the common separation boundary for signature messages, object digests, and
cross-runtime golden vectors.

<a id="decision-02"></a>

## Decision 02 — Integer and typed-array byte order

Amendment [PH-N1-D02](./amendments-v2.json) fixes byte order. All framing integers and all numeric
typed-array payloads MUST use big-endian byte order. An implementation MUST serialize each typed-array
element in its declared width; it MUST NOT copy host-memory bytes whose order depends on the host.

This decision applies independently of the canonical value codec's scalar tags. Cross-platform
implementations MUST therefore produce the same bytes on little-endian and big-endian machines.

<a id="decision-03"></a>

## Decision 03 — One canonical tag codec

Amendment [PH-N1-D03](./amendments-v2.json) selects `drp-canonical-profile-1`, whose format is the
reference-tag-codec. Consensus values MUST use that tag codec. CBOR MUST NOT be used as the canonical,
recommended, or alternate consensus encoding for v2 artifacts, even when a CBOR library can round-trip
the same application value.

Encoders MUST emit the unique form selected by the profile.
A decoder MUST reject wire forms explicitly forbidden by registry v5 or these amendments, including
Decision 04 negative zero. This amendment's decoder-rejection requirement applies only to those forms; it
does not classify every value the encoder cannot emit. Application storage MAY use another
representation only outside registered digest and signature preimages.

Unsafe-integral scalar Float64 handling remains unresolved. This amendment MUST NOT ratify acceptance or
rejection of such payloads; changing either behavior requires the separately governed codec decision and
evidence, not an inference from canonical encoder output.

<a id="decision-04"></a>

## Decision 04 — Negative-zero normalization

Amendment [PH-N1-D04](./amendments-v2.json) removes the two encodings of numeric zero. On encode, an
implementation MUST normalize negative zero (`-0`) to positive zero, including every element of a
`Float32Array`. On decode, it MUST reject a wire value carrying negative zero rather than normalize it
after acceptance.

The encode-normalize and decode-reject rules are intentionally asymmetric: producers converge on one
wire identity, while consumers fail closed on bytes no conforming producer emits. Equality at the
application layer MUST NOT be used to accept the forbidden representation.

<a id="decision-05"></a>

## Decision 05 — Round-free values and round-bearing proposals

Amendment [PH-N1-D05](./amendments-v2.json) separates a locked value from the round in which it is
proposed. `valueDigest` MUST be the registered digest of a round-free `CutValue`. `proposalDigest` MUST
equal `SealProposal.valueDigest`, and `proposalHash` MUST be the registered digest of the round-bearing
`SealProposal`, whose fields include `round` and `valueDigest`. Every `SealVote` and `SealQC` MUST agree
on both `proposalDigest` and `proposalHash`. A `CutValue` MUST NOT have a round field.

The preimages MUST include the registry additions: `CutValue` has `archiveIndexRoot` and
`availabilityPolicyDigest`; the epoch anchor has `archiveIndexRoot` and `blueprintDigest`; and the
snapshot payload has `blueprintDigest` and `archiveIndexRoot`. Implementations MUST bind these values
before voting so availability, archive, blueprint, state, and history commitments cannot drift apart.

Re-proposing a locked value in a later round MUST preserve its `valueDigest` while producing a distinct
`proposalHash`. Durable locks and committed-value comparison MUST use `proposalDigest`, the round-free
value identity, and MUST never use the round-bearing `proposalHash` as the locked-value key.

<a id="decision-06"></a>

## Decision 06 — Round-change certificate placement

Amendment [PH-N1-D06](./amendments-v2.json) gives `highestPrepareQC` one location and purpose. The
optional `highestPrepareQC` MUST occur only in a round-change preimage whose phase is `round-change`; it
MUST NOT occur in prepare or commit vote preimages, or in their `SealVote` and `SealQC` schemas.

A sender advancing rounds MUST carry its highest valid prepare certificate when one exists. A receiver
MUST validate that certificate and its proposal binding before using it to select a safe value. Absence
means the sender reports no prepared value; it MUST NOT be interpreted as permission to replace a
certificate already justified by the local safety state.

<a id="decision-07"></a>

## Decision 07 — Derived quorum parameters

Amendment [PH-N1-D07](./amendments-v2.json) defines the attested quorum from signer-set size `n`:
`q = ceil(2*n/3)` (⌈2n/3⌉) and `f = floor((n-1)/3)` (⌊(n−1)/3⌋). Implementations MUST derive both
values from the frozen signer set used by the epoch.

`maxByzantine` is not caller-supplied and MUST NOT be accepted as a configuration override. APIs MAY
display the derived value, but a caller-provided value MUST NOT alter vote validation, certificate
thresholds, or liveness calculations.

<a id="decision-08"></a>

## Decision 08 — Signer ordering and identifier hygiene

Amendment [PH-N1-D08](./amendments-v2.json) fixes signer ordering. Signers MUST be unique by `signerId`
and sorted by ascending UTF-8 byte order of that identifier before canonical encoding. This protocol byte
order is authoritative even though the registry's portable implementation label is `codepoint`.

A `signerId` MUST be a sequence of Unicode scalar values excluding control characters and MUST satisfy
the registry length bound. Implementations MUST NOT use locale-sensitive collation. They MUST reject
duplicates and prohibited control values before computing the signer-set digest.

<a id="decision-09"></a>

## Decision 09 — Complete conflict-action vocabulary

Amendment [PH-N1-D09](./amendments-v2.json) freezes exactly five conflict actions: `Nop`, `DropLeft`,
`DropRight`, `Swap`, and `Drop`. A v2 resolver MUST interpret all five according to its conflict
contract and MUST NOT collapse `Drop` into a directional drop.

Unknown actions MUST be rejected. `Nop` preserves the current order, `Swap` exchanges it,
`DropLeft` and `DropRight` discard the named side, and `Drop` discards both the left and right vertices of
the resolved conflict. The resolver MUST apply the selected action deterministically to every replica.

<a id="decision-10"></a>

## Decision 10 — Trust profiles and custody

Amendment [PH-N1-D10](./amendments-v2.json) defines the profiles
`creator-trusted-v1`, `delegated-trusted-v1`, and `attested-bft-v1`. Both `profileDigest` and
`cryptoSuiteId` MUST be signed into genesis and every epoch anchor; changing either value therefore
requires an explicit epoch transition, not local negotiation. The trust profile determines authority and
quorum semantics; it does not determine a voter's storage class or custody mechanism.

The creator profile uses `q = 1` and `n = 1`. Its key custody MUST be recoverable through a seed-derived
key plus network re-learn, and it MUST NOT fate-share the key with eviction-prone local vote storage. A
delegated profile MUST use k-of-n-not-bft authority semantics and a minimum quorum of two. An attested
profile MUST use the derived BFT quorum in Decision 07.

For quorum >= 2, every voter MUST preserve exact-slot anti-equivocation continuity. An external exact-slot
witness that atomically reserves the slot and vote bytes is a valid mode; a round-only or epoch-only high
water mark is not. A witness outage MUST stop signing.

A detectable-loss durable-class voter MUST use a durable CAS and outbox, MUST bind the signer identity to
a storage incarnation, and MUST refuse permanently on incarnation mismatch. Re-entry after such a mismatch
requires an authority handoff to a new signer identity.

Both delegated and attested profiles admit detectable-loss durable-class voters and browser-local
eviction-prone voters. A browser-local eviction-prone voter without an external exact-slot witness MUST
use fate-shared non-extractable custody, with the key fate-shared with the vote log, so eviction destroys
both the continuity state and the old signing identity.

Every quorum >= 2 signer set with eviction-prone voters MUST include at least one durable-class voter or
declare correlated-eviction stall acceptance. A stall MUST NOT trigger quorum reduction. Implementations
SHOULD also bound eviction-prone voters per correlated failure domain so one eviction wave cannot cross the
quorum line.

<a id="decision-11"></a>

## Decision 11 — Version and naming boundary

Amendment [PH-N1-D11](./amendments-v2.json) assigns this protocol `protocolMajor: 2` and the package name
`protocol-v2`. Registered domains MUST follow `ts-drp/*/v2`, with the specific middle component taken
from the frozen registry. Implementations MUST NOT negotiate v1 bytes under a v2 domain.

“Attested Hard Epochs v4” is the specification title exception: the document generation is v4 while its
wire protocol is major 2. Package, domain, and wire-version checks MUST use the protocol-major value,
not the numeral in the title.

<a id="decision-12"></a>

## Decision 12 — Signature suites and reservation

Amendment [PH-N1-D12](./amendments-v2.json) activates `ed25519-sha256-v1` for identity and vertex
signatures and `ed25519-seal-v1` for seal votes. Exactly two suite identifiers are active:
`ed25519-sha256-v1` and `ed25519-seal-v1`. Each Ed25519 signer MUST sign the raw 32-byte registered digest
exactly once; it MUST NOT silently prehash that digest again or accept an unregistered message.

`p256-sha256-v1` is reserved and MUST NOT be negotiated, signed, or verified as an active v2 suite. Any
reactivation MUST be a same-edit coordinated amendment that pins low-S normalization and pins one digest
mode: either raw registered digest input or an explicitly specified rehash/prehash rule. Reactivation
MUST update the registry, vectors, reference, and amendment log together; recognizing the reserved name
alone is not activation.

Suite identifiers MUST remain domain-scoped. A valid Ed25519 signature under one active suite MUST NOT
be accepted under the other merely because both suites use the same curve.

## Conformance

A protocol-major-2 implementation conforms to this document only when it implements every normative
decision above and reproduces the frozen registry vectors. The [amendment log](./amendments-v2.json) is
the machine-readable decision index; it is not a second source of prose semantics. On discrepancy,
implementations MUST fail closed and obtain a coordinated registry and specification amendment rather
than guessing an encoding or consensus rule.
