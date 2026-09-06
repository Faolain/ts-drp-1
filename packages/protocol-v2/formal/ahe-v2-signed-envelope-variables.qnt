module aheV2SignedEnvelopeVariables {
  type ProtocolMajor = int
  type ObjectId = str
  type Epoch = int
  type Round = int
  type Digest = str
  type SignerId = str
  type VotePhase = str
  type CryptoSuiteId = str

  // These boundary types preserve signed-field identity while leaving payload
  // semantics to the later pacemaker model. CanonicalOperation is an
  // uninterpreted canonical-object identity; SealQcEvidence preserves the
  // registry's explicit seal-qc-or-null choice.
  type CanonicalOperation = str
  type SealQcEvidence = | NoPrepareQc | PrepareQc(Digest)

  var vertexKind: str
  var vertexProtocolMajor: ProtocolMajor
  var vertexObjectId: ObjectId
  var vertexEpoch: Epoch
  var vertexAnchor: Digest
  var vertexAuthor: SignerId
  var vertexLogicalTime: int
  var vertexDependencies: List[Digest]
  var vertexOperation: CanonicalOperation

  var epochAnchorKind: str
  var epochAnchorProtocolMajor: ProtocolMajor
  var epochAnchorObjectId: ObjectId
  var epochAnchorEpoch: Epoch
  var epochAnchorPreviousAnchor: Digest
  var epochAnchorCutDigest: Digest
  var epochAnchorStateDigest: Digest
  var epochAnchorAclDigest: Digest
  var epochAnchorHistoryRoot: Digest
  var epochAnchorHistorySize: int
  var epochAnchorArchiveIndexRoot: Digest
  var epochAnchorBlueprintDigest: Digest
  var epochAnchorSignerSetDigest: Digest
  var epochAnchorParametersDigest: Digest
  var epochAnchorProfileDigest: Digest
  var epochAnchorCryptoSuiteId: CryptoSuiteId

  var sealVoteKind: str
  var sealVoteObjectId: ObjectId
  var sealVoteEpoch: Epoch
  var sealVoteRound: Round
  var sealVotePhase: VotePhase
  var sealVoteProposalDigest: Digest
  var sealVoteProposalHash: Digest
  var sealVoteSignerId: SignerId

  var roundChangeKind: str
  var roundChangeObjectId: ObjectId
  var roundChangeEpoch: Epoch
  var roundChangeRound: Round
  var roundChangePhase: VotePhase
  var roundChangeHighestPrepareQc: SealQcEvidence
  var roundChangeSignerId: SignerId
}
