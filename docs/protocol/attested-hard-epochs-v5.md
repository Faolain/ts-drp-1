# Attested Hard Epochs — protocol v3 registry v1 decisions

This document is the normative specification companion to
`packages/protocol-v3/registry/registry-v1.json`. It freezes the protocol-v3
registered surface for Phase −1′b. It does not activate governance or make the
in-progress Phase −1′a…−1′e bundle independently authoritative.

Protocol v3 carries forward all nineteen protocol-v2 registered kinds so the
successor does not evade pacemaker, seal, archive, snapshot, or state decisions
by omission. The only field-set additions are the model-derived
`vertex.authorSequence` and the directly bound `roundChange.anchor` that resolves
the protocol-v2 D.27 handoff.

<a id="decision-v3-01"></a>

## Decision 1 — protocol identity and suites

The successor identity is `(protocolMajor = 3, registryVersion = 1,
packageName = "protocol-v3")`. Every kind has a `ts-drp/*/v3` domain. The two
active suite identifiers are deliberately distinct from their v2 predecessors:
`ed25519-sha256-v3` authenticates vertices and epoch anchors, while
`ed25519-seal-v3` authenticates seal votes and round-change votes. The
cryptographic primitive remains Ed25519 over the raw 32-byte registered digest;
the distinct identifiers prevent cross-major suite substitution. The inactive
P-256 alternative is also domain-bound: v2's `p256-sha256-v1` is replaced by
the reserved `p256-sha256-v3`. It remains inactive, and activation requires one
numbered amendment that pins both digest mode and low-S normalization.

```json normative-decision
{
	"decision": 1,
	"id": "PH-N1P-D01",
	"decisionType": "protocol-identity",
	"normativeSource": "./attested-hard-epochs-v5.md#decision-v3-01",
	"registryPaths": ["protocolMajor", "registryVersion", "packageName", "cryptoSuites"],
	"requirements": {
		"protocolMajor": 3,
		"registryVersion": 1,
		"packageName": "protocol-v3",
		"distinctSuccessorSuites": true,
		"activeSuites": {
			"identityAndVertex": "ed25519-sha256-v3",
			"sealVote": "ed25519-seal-v3"
		},
		"predecessorSuites": {
			"identityAndVertex": "ed25519-sha256-v1",
			"sealVote": "ed25519-seal-v1"
		},
		"reservedSuites": {
			"identityAndVertexAlternative": "p256-sha256-v3"
		},
		"reservedPredecessorDisposition": {
			"predecessorSuiteId": "p256-sha256-v1",
			"successorSuiteId": "p256-sha256-v3",
			"disposition": "replaced-and-reserved-inactive",
			"activation": "same-numbered-amendment-must-pin-digest-mode-and-low-s-normalization"
		},
		"allRegisteredDomainsEndWith": "/v3"
	},
	"status": "normative"
}
```

<a id="decision-v3-02"></a>

## Decision 2 — vertex author sequence

The vertex review order is the exact accepted Phase −1′a `SignedVertex` order:
`kind`, `protocolMajor`, `objectId`, `epoch`, `anchor`, `author`,
`authorSequence`, `logicalTime`, `dependencies`, `operation`.
`authorSequence` is required and is a safe integer from zero through
`9007199254740991` inclusive. A durable author lineage starts at zero and never
resets on an epoch or anchor transition. Receiving the maximum safe integer is
valid. A local issuer whose next ordinal is already the maximum rejects issuance
without signing, advancing, wrapping, resetting, or exposing an envelope.

```json normative-decision
{
	"decision": 2,
	"id": "PH-N1P-D02",
	"decisionType": "vertex-author-sequence",
	"normativeSource": "./attested-hard-epochs-v5.md#decision-v3-02",
	"registryPaths": ["kinds.vertex.fields"],
	"requirements": {
		"field": "authorSequence",
		"reviewPosition": "immediately-after-author",
		"type": "safe-integer",
		"minimum": 0,
		"maximum": 9007199254740991,
		"initial": 0,
		"reset": "never",
		"overflow": "reject",
		"receivedMaximumIsValid": true,
		"localIssuanceAtExhaustion": "reject-without-state-change"
	},
	"status": "normative"
}
```

<a id="decision-v3-03"></a>

## Decision 3 — received-byte wire rule

The signed wire envelope consists of canonical-preimage bytes plus signature
bytes. Verification validates canonicality and the registered field contract,
then computes the digest over the exact received canonical-preimage byte array.
It MUST NOT decode and re-encode a semantically equivalent object before
digesting or signature verification.

```json normative-decision
{
	"decision": 3,
	"id": "PH-N1P-D03",
	"decisionType": "wire-format",
	"normativeSource": "./attested-hard-epochs-v5.md#decision-v3-03",
	"registryPaths": ["wireFormat"],
	"requirements": {
		"canonicalPreimage": "bytes",
		"signature": "bytes",
		"digestVerification": "received-bytes",
		"reencodeBeforeDigest": false
	},
	"status": "normative"
}
```

<a id="decision-v3-04"></a>

## Decision 4 — canonical map ordering

Registry field order is the review and field-set order. It does not determine
canonical object encoding. Canonical maps sort by the canonical encoded bytes of
each key, bytewise and unsigned; declaration order, locale order, insertion
order, and host object enumeration order never control the encoded map order.

```json normative-decision
{
	"decision": 4,
	"id": "PH-N1P-D04",
	"decisionType": "canonical-map-order",
	"normativeSource": "./attested-hard-epochs-v5.md#decision-v3-04",
	"registryPaths": ["canonicalObjectKeyOrder"],
	"requirements": {
		"rule": "encoded-key-bytes",
		"declarationOrderControlsEncoding": false,
		"reviewOrderPurpose": "field-set-and-human-review"
	},
	"status": "normative"
}
```

<a id="decision-v3-05"></a>

## Decision 5 — round-change anchor resolution

Every signed v3 `roundChange` directly includes `anchor` immediately after
`epoch`, so its signed tuple binds `(objectId, epoch, anchor, round)`. Direct
binding is selected instead of an indirect `highestPrepareQC` path because that
field may be null and cannot prove the epoch lineage in every round-change vote.
The registry, schema, formal variable declaration, and registry-to-model sign-off
all include this field. This resolves the protocol-v2 D.27 residual without
reinterpreting or editing protocol v2.

```json normative-decision
{
	"decision": 5,
	"id": "PH-N1P-D05",
	"decisionType": "round-change-anchor-resolution",
	"normativeSource": "./attested-hard-epochs-v5.md#decision-v3-05",
	"registryPaths": ["kinds.roundChange.fields", "kinds.epochAnchor.fields"],
	"requirements": {
		"resolution": "Every signed v3 roundChange directly binds the object epoch anchor.",
		"roundChangeAnchorBinding": "direct",
		"field": "anchor",
		"reviewPosition": "immediately-after-epoch",
		"normativeRationale": "A direct anchor prevents one round-change vote from being replayed between competing epoch lineages and closes the v2 D.27 residual without relying on an indirect certificate path.",
		"registryModelSpecConsequences": "consistent"
	},
	"status": "normative"
}
```

<a id="decision-v3-06"></a>

## Decision 6 — signed-envelope classification

Every registered kind carries mechanical signed/unsigned metadata. The complete
classification is:

- Signed by `identityAndVertex`: `vertex`, `epochAnchor`.
- Signed by `sealVote`: `sealVote`, `roundChange`.
- Unsigned registered structures: `signerSet`, `parameters`, `cutValue`,
  `historyLeaf`, `snapshotPayload`, `snapshotChunk`, `snapshotManifest`,
  `archivePayload`, `archiveChunk`, `archiveSegment`, `sealProposal`, `sealQC`,
  `profile`, `availabilityPolicy`, and `state`.

`sealProposal` is the registered proposal preimage and `sealQC` is a certificate
containing signed votes; neither is a separately signed envelope. All four kinds
classified as signed in the frozen v2 formal boundary remain signed successors,
so there is no omitted or unsigned v2-signed predecessor requiring an exception.
Each signed kind maps to exactly one active suite role, and no unsigned kind maps
to an active suite.

```json normative-decision
{
	"decision": 6,
	"id": "PH-N1P-D06",
	"decisionType": "signed-envelope-classification",
	"normativeSource": "./attested-hard-epochs-v5.md#decision-v3-06",
	"registryPaths": ["kinds"],
	"requirements": {
		"classificationMode": "registry-metadata",
		"allKindsAudited": true,
		"signedEnvelopeKinds": ["vertex", "epochAnchor", "sealVote", "roundChange"],
		"unsignedEnvelopeKinds": [
			"signerSet",
			"parameters",
			"cutValue",
			"historyLeaf",
			"snapshotPayload",
			"snapshotChunk",
			"snapshotManifest",
			"archivePayload",
			"archiveChunk",
			"archiveSegment",
			"sealProposal",
			"sealQC",
			"profile",
			"availabilityPolicy",
			"state"
		],
		"kindSuiteRoles": {
			"vertex": "identityAndVertex",
			"epochAnchor": "identityAndVertex",
			"sealVote": "sealVote",
			"roundChange": "sealVote"
		},
		"omittedPredecessorRationales": {},
		"unsignedPredecessorRationales": {},
		"v2SignedPredecessorDisposition": "all-four-retained-as-signed-successors"
	},
	"status": "normative"
}
```

<a id="decision-v3-07"></a>

## Decision 7 — canonical codec grammar

The language-neutral grammar in `canonical-tag-codec-v1.md` is the authoritative
production contract for `drp-canonical-profile-1`. Its machine-readable companion
is `canonical-tag-codec-v1.json`. Together they bind the registered codec,
framing, and big-endian numeric rules at the exact hashes below. Worked examples
are binding conformance examples, but they never override the grammar's
production rules.

```json normative-decision
{
	"decision": 7,
	"id": "PH-N1P-D07",
	"decisionType": "canonical-codec-grammar",
	"normativeSource": "./attested-hard-epochs-v5.md#decision-v3-07",
	"registryPaths": ["codec", "framing", "endianness"],
	"requirements": {
		"profile": "drp-canonical-profile-1",
		"authoritativeGrammar": {
			"path": "./canonical-tag-codec-v1.md",
			"sha256": "40f817866619931cd13461393005ea2a796de343591e3ec88be404664e8e5036"
		},
		"machineCompanion": {
			"path": "./canonical-tag-codec-v1.json",
			"sha256": "64426584f7c3217a42e258ec5d2eaae368d209dd520c0653361a1aca82aa705e"
		},
		"registryValues": {
			"codec": {
				"id": "drp-canonical-profile-1",
				"format": "reference-tag-codec",
				"cbor": false,
				"floatNegativeZero": {
					"encode": "normalize-to-positive-zero",
					"decode": "reject"
				}
			},
			"framing": {
				"magicHex": "44525000",
				"domainEncoding": "utf8",
				"domainLength": "U32BE",
				"partLength": "U64BE",
				"formula": "\"DRP\\0\" || U32BE(|domain|) || domain || (U64BE(|part|) || part)*"
			},
			"endianness": "big-endian"
		},
		"workedExamples": "binding-conformance-examples-never-override-production-rules"
	},
	"status": "normative"
}
```

## Mechanical interpretation

The JSON Schema mirrors every registry kind and field in review order and rejects
additional fields. Custom `x-registry-type` and `x-registry-constraints`
annotations retain registry semantics that JSON Schema cannot express exactly.
The Quint declaration source and sign-off cover all fields of the four signed
envelopes and derive variable names from `(kind, field)`, including the fixed
`QC` to `Qc` normalization. Artifact hashes in the sign-off point outward to the
five reviewed artifacts and never include the sign-off's own hash.
