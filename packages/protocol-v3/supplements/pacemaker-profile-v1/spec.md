# Protocol v3 pacemaker profile v1

This additive decision fixes the deterministic Phase 5d pacemaker law without
changing the frozen protocol-v3 registry, codecs, signer roster, or seal digest
identities. It governs observation and evidence only; certified adoption and
epoch advance remain later phases.

## Normative decision PH-P5-D02

The JSON block below is the sole machine-readable normative decision in this
supplement. Explanatory prose is subordinate to it.

<!-- PH-P5-D02:BEGIN -->

```json
{
	"id": "PH-P5-D02",
	"profileId": "pacemaker-profile-v1",
	"protocolMajor": 3,
	"registryVersion": 1,
	"requirements": {
		"bundleCutValue": "exact-canonical-required",
		"highestPrepareQCCustody": "complete-canonical-qc",
		"highestPrepareQCSelection": "greatest-round-then-lowest-registered-qc-digest",
		"leaderOrdering": "raw-utf8-ascending",
		"maxFutureRoundGap": 8,
		"newRoundCertificate": "exact-certified-quorum-no-truncation",
		"proposalAuthentication": "durable-leader-prepare-vote",
		"roundChangeDisposition": "distinct-registered-kind",
		"roundTimeoutBaseMs": 1000,
		"roundTimeoutMaxMs": 30000,
		"sealVotePhases": ["prepare", "commit"]
	}
}
```

<!-- PH-P5-D02:END -->

## Deterministic timing and leadership

Round timeout is `min(30_000, 1_000 × 2^round)` milliseconds. Implementations
must saturate before exponentiation can overflow. A future message more than
eight rounds ahead is rejected rather than used to advance local state.

The certified signer identifiers are ordered by their raw UTF-8 bytes. Round
`r` selects entry `r mod n`; locale, UTF-16 code-unit, and host collation order
are not consensus inputs.

## Round-change and proposal evidence

`roundChange` remains its own registered signed kind. A new-round certificate
contains exactly the certified quorum of distinct, valid, tuple-bound
round-change carriers. It is neither truncated nor padded.

A proposal bundle carries the exact canonical CutValue bytes, the registered
SealProposal, and the exact durable leader prepare-vote carrier. Recipients
recompute the CutValue digest and proposal hash, bind the elected leader, and
verify the registered signature before voting.

Every non-null highest prepare QC is retained as its complete canonical QC,
including votes and signatures. Selection takes the greatest round. Two QCs at
that round for different values are a terminal conflict; for the same value,
the lower registered QC digest is the deterministic choice. Digest-only
summaries are not sufficient restart custody.

## Phase boundary

The registered `sealVote.phase` stays exactly `prepare | commit`. This profile
does not adopt a certified cut, advance the active epoch, prune history, or
claim Phase 5e/6 behavior.
