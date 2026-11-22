module equivocationDigestIdentity {
  type VertexCarrier = {
    objectId: str,
    author: str,
    authorSequence: int,
    logicalTime: int,
    dependencies: Set[str],
    operation: str,
    digest: str,
    signatureCarrier: str,
  }

  pure val baseVertex: VertexCarrier = {
    objectId: "object-A",
    author: "alice",
    authorSequence: 7,
    logicalTime: 31,
    dependencies: Set("dependency-A"),
    operation: "same-operation",
    digest: "digest-A",
    signatureCarrier: "signature-A",
  }

  pure val sameOperationDifferentDependencies: VertexCarrier =
    baseVertex
      .with("dependencies", Set("dependency-B"))
      .with("digest", "digest-B")

  pure val sameOperationDifferentLogicalTime: VertexCarrier =
    baseVertex
      .with("logicalTime", 32)
      .with("digest", "digest-C")

  pure val sameDigestDifferentSignatureCarrier: VertexCarrier =
    baseVertex.with("signatureCarrier", "signature-B")

  pure val boundedCandidates = Set(
    baseVertex,
    sameOperationDifferentDependencies,
    sameOperationDifferentLogicalTime,
    sameDigestDifferentSignatureCarrier
  )

  pure def sameSlot(left: VertexCarrier, right: VertexCarrier): bool =
    left.objectId == right.objectId
      and left.author == right.author
      and left.authorSequence == right.authorSequence

  pure def duplicate(left: VertexCarrier, right: VertexCarrier): bool =
    sameSlot(left, right) and left.digest == right.digest

  pure def equivocation(left: VertexCarrier, right: VertexCarrier): bool =
    sameSlot(left, right) and left.digest != right.digest

  pure def unorderedDigestPair(left: VertexCarrier, right: VertexCarrier): Set[str] =
    Set(left.digest, right.digest)

  pure val boundedUnorderedProofPairs = Set(
    unorderedDigestPair(baseVertex, sameOperationDifferentDependencies),
    unorderedDigestPair(baseVertex, sameOperationDifferentLogicalTime),
    unorderedDigestPair(sameOperationDifferentDependencies, sameOperationDifferentLogicalTime)
  )

  pure val sameDigestRecarrierIsDuplicate =
    duplicate(baseVertex, sameDigestDifferentSignatureCarrier)

  pure val dependencyForkIsEquivocation =
    equivocation(baseVertex, sameOperationDifferentDependencies)

  pure val logicalTimeForkIsEquivocation =
    equivocation(baseVertex, sameOperationDifferentLogicalTime)

  var witness: bool

  action init = {
    witness' = true
  }

  action check(condition) = all {
    condition,
    witness' = witness,
  }

  run testSameDigestRecarrierIsDuplicate =
    init
      .then(check(witness))
      .then(check(sameDigestRecarrierIsDuplicate))

  run testDependencyForkIsEquivocation =
    init
      .then(check(witness))
      .then(check(dependencyForkIsEquivocation))

  run testLogicalTimeForkIsEquivocation =
    init
      .then(check(witness))
      .then(check(logicalTimeForkIsEquivocation))

  run testExactlyThreeUnorderedProofPairs =
    init
      .then(check(witness))
      .then(check(boundedUnorderedProofPairs.size() == 3))
}
