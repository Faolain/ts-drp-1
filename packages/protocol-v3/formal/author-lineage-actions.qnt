module authorLineageActions {
  pure val LOCAL_SEQUENCE_CAP = 3
  pure val SUCCESSFUL_ISSUANCE_CAP = 3
  pure val FAILURE_ATTEMPT_CAP = 2
  pure val REMOTE_OBSERVATION_CAP = 8
  pure val PHASE_CAP = 16
  pure val BOUNDED_SEQUENCES = Set(0, 1, 2)

  type SignedVertex = {
    kind: str,
    protocolMajor: int,
    objectId: str,
    epoch: int,
    anchor: str,
    author: str,
    authorSequence: int,
    logicalTime: int,
    dependencies: Set[str],
    operation: str,
  }

  pure def authenticateSignedVertex(
    signed: SignedVertex,
    candidate: SignedVertex
  ): bool = signed == candidate

  pure def operationIdentity(vertex: SignedVertex): str = vertex.operation

  pure def localSignedVertex(sequence: int): SignedVertex = {
    kind: "vertex",
    protocolMajor: 3,
    objectId: "room-A",
    epoch: 0,
    anchor: "anchor-0",
    author: "alice",
    authorSequence: sequence,
    logicalTime: sequence,
    dependencies:
      if (sequence == 0) Set()
      else if (sequence == 1) Set("digest-0")
      else Set("digest-1"),
    operation:
      if (sequence == 0) "operation-0"
      else if (sequence == 1) "operation-1"
      else "operation-2",
  }

  pure val EMPTY_VERTEX: SignedVertex = {
    kind: "vertex",
    protocolMajor: 3,
    objectId: "room-A",
    epoch: 0,
    anchor: "anchor-0",
    author: "alice",
    authorSequence: 0,
    logicalTime: 0,
    dependencies: Set(),
    operation: "operation-0",
  }

  pure val ALICE_0: SignedVertex = localSignedVertex(0)
  pure val ALICE_1A: SignedVertex = {
    kind: "vertex",
    protocolMajor: 3,
    objectId: "room-A",
    epoch: 0,
    anchor: "anchor-0",
    author: "alice",
    authorSequence: 1,
    logicalTime: 1,
    dependencies: Set("digest-0"),
    operation: "operation-1a",
  }
  pure val ALICE_1B: SignedVertex = {
    kind: "vertex",
    protocolMajor: 3,
    objectId: "room-A",
    epoch: 0,
    anchor: "anchor-0",
    author: "alice",
    authorSequence: 1,
    logicalTime: 1,
    dependencies: Set("digest-0"),
    operation: "operation-1b",
  }
  pure val ALICE_2: SignedVertex = localSignedVertex(2)
  pure val ALICE_2B: SignedVertex = {
    kind: "vertex",
    protocolMajor: 3,
    objectId: "room-A",
    epoch: 0,
    anchor: "anchor-0",
    author: "alice",
    authorSequence: 2,
    logicalTime: 2,
    dependencies: Set("digest-1"),
    operation: "operation-2b",
  }

  pure val MUTATED_KIND: SignedVertex =
    EMPTY_VERTEX.with("kind", "other-kind")
  pure val MUTATED_PROTOCOL_MAJOR: SignedVertex =
    EMPTY_VERTEX.with("protocolMajor", 4)
  pure val MUTATED_OBJECT_ID: SignedVertex =
    EMPTY_VERTEX.with("objectId", "room-B")
  pure val MUTATED_EPOCH: SignedVertex =
    EMPTY_VERTEX.with("epoch", 1)
  pure val MUTATED_ANCHOR: SignedVertex =
    EMPTY_VERTEX.with("anchor", "anchor-1")
  pure val MUTATED_AUTHOR: SignedVertex =
    EMPTY_VERTEX.with("author", "mallory")
  pure val MUTATED_AUTHOR_SEQUENCE: SignedVertex =
    EMPTY_VERTEX.with("authorSequence", 1)
  pure val MUTATED_LOGICAL_TIME: SignedVertex =
    EMPTY_VERTEX.with("logicalTime", 1)
  pure val MUTATED_DEPENDENCIES: SignedVertex =
    EMPTY_VERTEX.with("dependencies", Set("different-digest"))
  pure val MUTATED_OPERATION: SignedVertex =
    EMPTY_VERTEX.with("operation", "different-operation")

  type RemoteCandidate = {
    envelopeId: str,
    signed: SignedVertex,
    candidate: SignedVertex,
  }

  pure val REMOTE_CANDIDATES = Set(
    { envelopeId: "alice-0", signed: ALICE_0, candidate: ALICE_0 },
    { envelopeId: "alice-1a", signed: ALICE_1A, candidate: ALICE_1A },
    { envelopeId: "alice-1b", signed: ALICE_1B, candidate: ALICE_1B },
    { envelopeId: "alice-2", signed: ALICE_2, candidate: ALICE_2 },
    { envelopeId: "alice-2b", signed: ALICE_2B, candidate: ALICE_2B }
  )

  pure val KNOWN_ENVELOPE_IDS = Set(
    "",
    "alice-0",
    "alice-1a",
    "alice-1b",
    "alice-2",
    "alice-2b",
    "mut-kind",
    "mut-protocol",
    "mut-object",
    "mut-epoch",
    "mut-anchor",
    "mut-author",
    "mut-sequence",
    "mut-time",
    "mut-dependencies",
    "mut-operation"
  )

  pure val VALID_ENVELOPE_IDS = Set(
    "alice-0",
    "alice-1a",
    "alice-1b",
    "alice-2",
    "alice-2b"
  )

  pure def incrementCapped(value: int, cap: int): int =
    if (value < cap) value + 1 else value

  pure def expectedLocalRecords(count: int): Set[SignedVertex] =
    BOUNDED_SEQUENCES
      .filter(sequence => sequence < count)
      .map(sequence => localSignedVertex(sequence))

  type ModelState = {
    phase: int,
    localNextSequence: int,
    localSuccessfulCount: int,
    localFailureCount: int,
    issuedRecords: Set[SignedVertex],
    exposedIssuedRecords: Set[SignedVertex],
    failedCounterBefore: int,
    failedCounterAfter: int,
    failedIssuedBefore: Set[SignedVertex],
    failedIssuedAfter: Set[SignedVertex],
    failedExposedBefore: Set[SignedVertex],
    failedExposedAfter: Set[SignedVertex],
    lastLocalAttemptFailed: bool,
    currentEnvelopeId: str,
    currentSignedVertex: SignedVertex,
    currentCandidateVertex: SignedVertex,
    currentAdmitted: bool,
    remoteDecisionByEnvelope: str -> bool,
    remoteSignedByEnvelope: str -> SignedVertex,
    remoteCandidateByEnvelope: str -> SignedVertex,
    seenEnvelopeIds: Set[str],
    remoteRecords: Set[SignedVertex],
    seenRemoteSequences: Set[int],
    operationsBySequence: int -> Set[str],
    detectedEquivocationSequences: Set[int],
    remoteObservationCount: int,
    gapObserved: bool,
    duplicateObserved: bool,
    equivocationObserved: bool,
    lastObservationWasGap: bool,
    lastObservationWasDuplicate: bool,
    lastObservationAdmitted: bool,
  }

  var state: ModelState

  action init = {
    state' = {
      phase: 0,
      localNextSequence: 0,
      localSuccessfulCount: 0,
      localFailureCount: 0,
      issuedRecords: Set(),
      exposedIssuedRecords: Set(),
      failedCounterBefore: 0,
      failedCounterAfter: 0,
      failedIssuedBefore: Set(),
      failedIssuedAfter: Set(),
      failedExposedBefore: Set(),
      failedExposedAfter: Set(),
      lastLocalAttemptFailed: false,
      currentEnvelopeId: "",
      currentSignedVertex: EMPTY_VERTEX,
      currentCandidateVertex: EMPTY_VERTEX,
      currentAdmitted: false,
      remoteDecisionByEnvelope: KNOWN_ENVELOPE_IDS.mapBy(_ => false),
      remoteSignedByEnvelope: KNOWN_ENVELOPE_IDS.mapBy(_ => EMPTY_VERTEX),
      remoteCandidateByEnvelope: KNOWN_ENVELOPE_IDS.mapBy(_ => EMPTY_VERTEX),
      seenEnvelopeIds: Set(),
      remoteRecords: Set(),
      seenRemoteSequences: Set(),
      operationsBySequence: BOUNDED_SEQUENCES.mapBy(_ => Set()),
      detectedEquivocationSequences: Set(),
      remoteObservationCount: 0,
      gapObserved: false,
      duplicateObserved: false,
      equivocationObserved: false,
      lastObservationWasGap: false,
      lastObservationWasDuplicate: false,
      lastObservationAdmitted: false,
    }
  }

  action issueLocalSuccess = all {
    state.localNextSequence < LOCAL_SEQUENCE_CAP,
    state.localSuccessfulCount < SUCCESSFUL_ISSUANCE_CAP,
    authenticateSignedVertex(
      localSignedVertex(state.localNextSequence)
        .with("authorSequence", state.localNextSequence),
      localSignedVertex(state.localNextSequence)
        .with("authorSequence", state.localNextSequence)
    ),
    state' =
      state
        .with("phase", incrementCapped(state.phase, PHASE_CAP))
        .with(
          "issuedRecords",
          state.issuedRecords.union(
            Set(
              localSignedVertex(state.localNextSequence)
                .with("authorSequence", state.localNextSequence)
            )
          )
        )
        .with(
          "exposedIssuedRecords",
          state.exposedIssuedRecords.union(
            Set(
              localSignedVertex(state.localNextSequence)
                .with("authorSequence", state.localNextSequence)
            )
          )
        )
        .with("localNextSequence", state.localNextSequence + 1)
        .with("localSuccessfulCount", state.localSuccessfulCount + 1)
        .with("lastLocalAttemptFailed", false),
  }

  action issueLocalFailure = all {
    state.localFailureCount < FAILURE_ATTEMPT_CAP,
    state' =
      state
        .with("phase", incrementCapped(state.phase, PHASE_CAP))
        .with("failedCounterBefore", state.localNextSequence)
        .with("failedCounterAfter", state.localNextSequence)
        .with("failedIssuedBefore", state.issuedRecords)
        .with("failedIssuedAfter", state.issuedRecords)
        .with("failedExposedBefore", state.exposedIssuedRecords)
        .with("failedExposedAfter", state.exposedIssuedRecords)
        .with("lastLocalAttemptFailed", true)
        .with("localFailureCount", state.localFailureCount + 1),
  }

  action admitRemote(
    envelopeId,
    signed,
    candidate
  ) = all {
    KNOWN_ENVELOPE_IDS.contains(envelopeId),
    BOUNDED_SEQUENCES.contains(signed.authorSequence),
    BOUNDED_SEQUENCES.contains(candidate.authorSequence),
    not(state.seenEnvelopeIds.contains(envelopeId)) or
      (state.remoteSignedByEnvelope.get(envelopeId) == signed and
        state.remoteCandidateByEnvelope.get(envelopeId) == candidate),
    state' =
      state
        .with("phase", incrementCapped(state.phase, PHASE_CAP))
        .with("currentEnvelopeId", envelopeId)
        .with("currentSignedVertex", signed)
        .with("currentCandidateVertex", candidate)
        .with(
          "currentAdmitted",
          if (state.seenEnvelopeIds.contains(envelopeId))
            state.remoteDecisionByEnvelope.get(envelopeId)
          else authenticateSignedVertex(signed, candidate)
        )
        .with(
          "remoteDecisionByEnvelope",
          state.remoteDecisionByEnvelope.set(
            envelopeId,
            if (state.seenEnvelopeIds.contains(envelopeId))
              state.remoteDecisionByEnvelope.get(envelopeId)
            else authenticateSignedVertex(signed, candidate)
          )
        )
        .with(
          "remoteSignedByEnvelope",
          state.remoteSignedByEnvelope.set(envelopeId, signed)
        )
        .with(
          "remoteCandidateByEnvelope",
          state.remoteCandidateByEnvelope.set(envelopeId, candidate)
        )
        .with(
          "seenEnvelopeIds",
          state.seenEnvelopeIds.union(Set(envelopeId))
        ),
  }

  action observeRemote = all {
    state.currentAdmitted,
    state.remoteObservationCount < REMOTE_OBSERVATION_CAP,
    val signed = state.currentSignedVertex
    val operation = operationIdentity(signed)
    val priorOperations =
      state.operationsBySequence.get(signed.authorSequence)
    val duplicate = state.remoteRecords.contains(signed)
    val gap =
      signed.authorSequence > 0 and
        not(state.seenRemoteSequences.contains(signed.authorSequence - 1))
    val equivocation =
      priorOperations.exists(priorOperation => priorOperation != operation)
    state' =
      state
        .with("phase", incrementCapped(state.phase, PHASE_CAP))
        .with(
          "remoteObservationCount",
          state.remoteObservationCount + 1
        )
        .with("duplicateObserved", state.duplicateObserved or duplicate)
        .with("gapObserved", state.gapObserved or gap)
        .with(
          "equivocationObserved",
          state.equivocationObserved or equivocation
        )
        .with("lastObservationWasGap", gap)
        .with("lastObservationWasDuplicate", duplicate)
        .with("lastObservationAdmitted", state.currentAdmitted)
        .with("remoteRecords", state.remoteRecords.union(Set(signed)))
        .with(
          "seenRemoteSequences",
          state.seenRemoteSequences.union(Set(signed.authorSequence))
        )
        .with(
          "operationsBySequence",
          state.operationsBySequence.set(
            signed.authorSequence,
            priorOperations.union(Set(operation))
          )
        ),
  }

  action detectEquivocation(sequence) = all {
    BOUNDED_SEQUENCES.contains(sequence),
    state.currentSignedVertex.authorSequence == sequence,
    state.operationsBySequence
      .get(sequence)
      .contains(operationIdentity(state.currentSignedVertex)),
    state.operationsBySequence
      .get(sequence)
      .exists(
        operation =>
          operation != operationIdentity(state.currentSignedVertex)
      ),
    state' =
      state
        .with("phase", incrementCapped(state.phase, PHASE_CAP))
        .with(
          "detectedEquivocationSequences",
          state.detectedEquivocationSequences.union(Set(sequence))
        ),
  }

  action admitRemoteChoice = {
    nondet remote = REMOTE_CANDIDATES.oneOf()
    admitRemote(remote.envelopeId, remote.signed, remote.candidate)
  }

  action detectEquivocationChoice = {
    nondet sequence =
      BOUNDED_SEQUENCES
        .filter(
          candidate =>
            state.currentSignedVertex.authorSequence == candidate and
              state.operationsBySequence.get(candidate).size() > 1
        )
        .oneOf()
    detectEquivocation(sequence)
  }

  val boundedStateAtCapacity =
    state.localNextSequence == LOCAL_SEQUENCE_CAP and
      state.localSuccessfulCount == SUCCESSFUL_ISSUANCE_CAP and
      state.localFailureCount == FAILURE_ATTEMPT_CAP and
      state.remoteObservationCount == REMOTE_OBSERVATION_CAP and
      state.phase == PHASE_CAP

  action boundedCapStutter = all {
    boundedStateAtCapacity,
    state' = state,
  }

  action check(condition) = all {
    condition,
    state' = state,
  }

  val authorSequenceAuthenticated =
    not(state.currentAdmitted) or
      authenticateSignedVertex(
        state.currentSignedVertex,
        state.currentCandidateVertex
      )

  val successfulLocalIssuanceContiguous =
    state.localNextSequence == state.localSuccessfulCount and
      state.issuedRecords == expectedLocalRecords(state.localSuccessfulCount) and
      state.exposedIssuedRecords == state.issuedRecords

  val failedLocalIssuanceOpaque =
    not(state.lastLocalAttemptFailed) or
      (state.localNextSequence == state.failedCounterBefore and
        state.failedCounterBefore == state.failedCounterAfter and
        state.issuedRecords == state.failedIssuedBefore and
        state.failedIssuedBefore == state.failedIssuedAfter and
        state.exposedIssuedRecords == state.failedExposedBefore and
        state.failedExposedBefore == state.failedExposedAfter)

  val remoteAdmissionArrivalOrderIndependent =
    VALID_ENVELOPE_IDS.forall(
      envelopeId =>
        not(state.seenEnvelopeIds.contains(envelopeId)) or
          state.remoteDecisionByEnvelope.get(envelopeId)
    )

  val duplicateAndGapNeverReject =
    (not(state.lastObservationWasDuplicate) or state.lastObservationAdmitted) and
      (not(state.lastObservationWasGap) or state.lastObservationAdmitted)

  val equivocationObservationSound =
    state.detectedEquivocationSequences.forall(
      sequence => state.operationsBySequence.get(sequence).size() > 1
    )

  val localIssuedRecordsBindSelectedSequence =
    state.issuedRecords == state.exposedIssuedRecords and
      state.issuedRecords.forall(
        vertex =>
          vertex.authorSequence < state.localNextSequence and
            authenticateSignedVertex(
              localSignedVertex(vertex.authorSequence),
              vertex
            )
      )

  val validRemoteDecisionHistoryIndependent =
    VALID_ENVELOPE_IDS.forall(
      envelopeId =>
        not(state.seenEnvelopeIds.contains(envelopeId)) or
          state.remoteDecisionByEnvelope.get(envelopeId)
    )

  val operationIdentityGrounded =
    state.remoteRecords.forall(
      vertex => operationIdentity(vertex) == vertex.operation
    )

  val boundedStateFinite =
    0 <= state.localNextSequence and
      state.localNextSequence <= LOCAL_SEQUENCE_CAP and
      0 <= state.localSuccessfulCount and
      state.localSuccessfulCount <= SUCCESSFUL_ISSUANCE_CAP and
      0 <= state.localFailureCount and
      state.localFailureCount <= FAILURE_ATTEMPT_CAP and
      0 <= state.remoteObservationCount and
      state.remoteObservationCount <= REMOTE_OBSERVATION_CAP and
      0 <= state.phase and
      state.phase <= PHASE_CAP and
      state.seenRemoteSequences.subseteq(BOUNDED_SEQUENCES) and
      state.detectedEquivocationSequences.subseteq(BOUNDED_SEQUENCES) and
      state.issuedRecords.size() <= SUCCESSFUL_ISSUANCE_CAP and
      state.exposedIssuedRecords.size() <= SUCCESSFUL_ISSUANCE_CAP and
      state.remoteRecords.size() <= REMOTE_CANDIDATES.size()

  val signedFieldDerivationSound =
    authenticateSignedVertex(EMPTY_VERTEX, EMPTY_VERTEX) and
      operationIdentity(EMPTY_VERTEX) == EMPTY_VERTEX.operation

  val witnessLocalIssueSuccess = state.localSuccessfulCount > 0
  val witnessLocalIssueFailure = state.localFailureCount > 0
  val witnessRemoteGap = state.gapObserved
  val witnessRemoteDuplicate = state.duplicateObserved
  val witnessEquivocationDetected =
    state.detectedEquivocationSequences.size() > 0
  val witnessLocalSignedRecordExposed =
    state.exposedIssuedRecords.size() > 0
  val witnessRemoteDecisionAfterHistory =
    state.seenEnvelopeIds.size() > 1 and
      VALID_ENVELOPE_IDS.exists(
        envelopeId =>
          state.seenEnvelopeIds.contains(envelopeId) and
            state.remoteDecisionByEnvelope.get(envelopeId)
      )
  val witnessBoundedStutter = boundedStateAtCapacity

  action step = any {
    issueLocalSuccess,
    issueLocalFailure,
    admitRemoteChoice,
    observeRemote,
    detectEquivocationChoice,
    boundedCapStutter,
  }

  run testSuccessfulLocalIssuanceIsContiguous =
    init
      .then(issueLocalSuccess)
      .then(issueLocalSuccess)
      .then(issueLocalSuccess)
      .then(check(successfulLocalIssuanceContiguous))
      .then(check(state.localNextSequence == 3))
      .then(check(state.issuedRecords.size() == 3))
      .then(check(state.exposedIssuedRecords == state.issuedRecords))

  run testFailedLocalIssuanceConsumesAndExposesNothing =
    init
      .then(issueLocalSuccess)
      .then(issueLocalFailure)
      .then(check(state.localNextSequence == 1))
      .then(check(state.issuedRecords.size() == 1))
      .then(check(state.exposedIssuedRecords.size() == 1))
      .then(check(failedLocalIssuanceOpaque))

  run testRemoteDuplicateAndGapRemainAdmissible =
    init
      .then(admitRemote("alice-2", ALICE_2, ALICE_2))
      .then(observeRemote)
      .then(admitRemote("alice-2", ALICE_2, ALICE_2))
      .then(observeRemote)
      .then(check(state.gapObserved))
      .then(check(state.duplicateObserved))
      .then(check(state.remoteDecisionByEnvelope.get("alice-2")))

  run testEquivocationDetectionAcrossBoundedSequences =
    init
      .then(admitRemote("alice-1a", ALICE_1A, ALICE_1A))
      .then(observeRemote)
      .then(admitRemote("alice-1b", ALICE_1B, ALICE_1B))
      .then(observeRemote)
      .then(detectEquivocation(1))
      .then(admitRemote("alice-2", ALICE_2, ALICE_2))
      .then(observeRemote)
      .then(admitRemote("alice-2b", ALICE_2B, ALICE_2B))
      .then(observeRemote)
      .then(detectEquivocation(2))
      .then(check(state.detectedEquivocationSequences.contains(1)))
      .then(check(state.detectedEquivocationSequences.contains(2)))

  run testBoundedCapsStutterWithoutGrowth =
    init
      .then(issueLocalSuccess)
      .then(issueLocalSuccess)
      .then(issueLocalSuccess)
      .then(issueLocalFailure)
      .then(issueLocalFailure)
      .then(admitRemote("alice-2", ALICE_2, ALICE_2))
      .then(observeRemote)
      .then(observeRemote)
      .then(observeRemote)
      .then(observeRemote)
      .then(observeRemote)
      .then(observeRemote)
      .then(observeRemote)
      .then(observeRemote)
      .then(admitRemote("alice-1a", ALICE_1A, ALICE_1A))
      .then(admitRemote("alice-0", ALICE_0, ALICE_0))
      .then(check(boundedStateAtCapacity))
      .then(boundedCapStutter)
      .then(check(boundedStateAtCapacity))

  run testSignedVertexFieldMutationsFailAuthentication =
    init
      .then(admitRemote("mut-kind", EMPTY_VERTEX, MUTATED_KIND))
      .then(check(not(state.currentAdmitted)))
      .then(init)
      .then(admitRemote("mut-protocol", EMPTY_VERTEX, MUTATED_PROTOCOL_MAJOR))
      .then(check(not(state.currentAdmitted)))
      .then(init)
      .then(admitRemote("mut-object", EMPTY_VERTEX, MUTATED_OBJECT_ID))
      .then(check(not(state.currentAdmitted)))
      .then(init)
      .then(admitRemote("mut-epoch", EMPTY_VERTEX, MUTATED_EPOCH))
      .then(check(not(state.currentAdmitted)))
      .then(init)
      .then(admitRemote("mut-anchor", EMPTY_VERTEX, MUTATED_ANCHOR))
      .then(check(not(state.currentAdmitted)))
      .then(init)
      .then(admitRemote("mut-author", EMPTY_VERTEX, MUTATED_AUTHOR))
      .then(check(not(state.currentAdmitted)))
      .then(init)
      .then(admitRemote("mut-sequence", EMPTY_VERTEX, MUTATED_AUTHOR_SEQUENCE))
      .then(check(not(state.currentAdmitted)))
      .then(init)
      .then(admitRemote("mut-time", EMPTY_VERTEX, MUTATED_LOGICAL_TIME))
      .then(check(not(state.currentAdmitted)))
      .then(init)
      .then(admitRemote(
        "mut-dependencies",
        EMPTY_VERTEX,
        MUTATED_DEPENDENCIES
      ))
      .then(check(not(state.currentAdmitted)))
      .then(init)
      .then(admitRemote("mut-operation", EMPTY_VERTEX, MUTATED_OPERATION))
      .then(check(not(state.currentAdmitted)))

  run testLocalIssueBindsSelectedSequenceIntoSignedRecord =
    init
      .then(issueLocalSuccess)
      .then(issueLocalSuccess)
      .then(check(
        state.issuedRecords.contains(localSignedVertex(0)) and
          state.issuedRecords.contains(localSignedVertex(1)) and
          state.exposedIssuedRecords == state.issuedRecords
      ))
      .then(check(localIssuedRecordsBindSelectedSequence))

  run testRemoteDecisionHistoryIndependentForValidCandidates =
    init
      .then(admitRemote("alice-2", ALICE_2, ALICE_2))
      .then(observeRemote)
      .then(admitRemote("alice-0", ALICE_0, ALICE_0))
      .then(observeRemote)
      .then(admitRemote("alice-2", ALICE_2, ALICE_2))
      .then(check(state.remoteDecisionByEnvelope.get("alice-2")))
      .then(check(validRemoteDecisionHistoryIndependent))
      .then(init)
      .then(admitRemote("alice-0", ALICE_0, ALICE_0))
      .then(observeRemote)
      .then(admitRemote("alice-2", ALICE_2, ALICE_2))
      .then(check(state.remoteDecisionByEnvelope.get("alice-2")))
      .then(check(validRemoteDecisionHistoryIndependent))

  run testSameOperationDuplicateIsNotEquivocation =
    init
      .then(admitRemote("alice-2", ALICE_2, ALICE_2))
      .then(observeRemote)
      .then(admitRemote("alice-2", ALICE_2, ALICE_2))
      .then(observeRemote)
      .then(check(state.duplicateObserved))
      .then(check(not(state.equivocationObserved)))

  run testDifferentOperationSameSlotDetectsEquivocation =
    init
      .then(admitRemote("alice-2", ALICE_2, ALICE_2))
      .then(observeRemote)
      .then(admitRemote("alice-2b", ALICE_2B, ALICE_2B))
      .then(observeRemote)
      .then(detectEquivocation(2))
      .then(check(state.equivocationObserved))
      .then(check(state.detectedEquivocationSequences.contains(2)))

  run testSignedFieldsDeriveFromTypedAuthenticatedVertex =
    init
      .then(check(authenticateSignedVertex(EMPTY_VERTEX, EMPTY_VERTEX)))
      .then(check(operationIdentity(EMPTY_VERTEX) == "operation-0"))
      .then(check(signedFieldDerivationSound))
}
