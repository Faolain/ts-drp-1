# Protocol v3 seal digest identity v1

This additive decision restores the seal identity rule inherited from the
predecessor hard-epoch design. It does not change the frozen protocol-v3
registry, schema, codec grammar, registered fields, or D01–D07 decisions.

## Normative decision PH-P5-D01

The JSON block below is the sole machine-readable normative decision in this
supplement. Explanatory prose is subordinate to it.

<!-- PH-P5-D01:BEGIN -->

```json
{
	"id": "PH-P5-D01",
	"profileId": "seal-digest-identity-v1",
	"protocolMajor": 3,
	"registryVersion": 1,
	"requirements": {
		"cutValueDigest": "hash-domain-exact-cut-value-bytes",
		"lockIdentity": "valueDigest",
		"proposalHash": "hash-domain-exact-seal-proposal-bytes",
		"qcProposalDigest": "valueDigest",
		"roundChangeDisposition": "separate-kind-deferred-phase-5d",
		"sameValueRoundCarryover": true,
		"sealProposalValueDigest": "valueDigest",
		"sealVotePhases": ["prepare", "commit"],
		"sealVoteProposalDigest": "valueDigest"
	}
}
```

<!-- PH-P5-D01:END -->

## Identity boundary

`valueDigest` is the registered domain hash of the exact canonical `CutValue`
bytes. `CutValue` is round-free. A `SealProposal` carries that value identity
and the round; `proposalHash` is the registered domain hash of the exact
canonical `SealProposal` bytes. Two rounds may therefore propose the same value
under distinct proposal hashes.

Votes and quorum certificates bind both identities. Their `proposalDigest`
field is always the round-free `valueDigest`; their `proposalHash` field is the
round-bearing proposal identity. Locks and committed-value comparison use
`valueDigest`, while the round and proposal hash retain the exact justification
that produced the lock. This permits safe same-value round carryover without
turning a new proposal envelope into a new value.

## Phase boundary

The frozen `sealVote.phase` remains exactly `prepare | commit`. `roundChange`
is a distinct registered signed-envelope kind. Phase 5d owns its construction,
authentication, pacemaker semantics, and round-advance evidence; this decision
does not widen the seal-vote enum or activate round changes.
