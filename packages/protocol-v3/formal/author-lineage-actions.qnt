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

// Current-role effect boundary adjunct. Trust opening, signature verification,
// exact carriers and native atomicity remain source/native assumptions. This
// finite witness is not a profile-complete or temporal authorization proof.
// Scope: ordinary nonsettlement current-v1 work. Historical settlement and
// separately authenticated terminal authority are not represented here.
module currentOperationAuthority {
  type RoleState = {
    member: bool, writer: bool, admin: bool, permissionless: bool,
    nextWriter: bool, allowed: bool, signed: int, issued: int,
    journaled: int, delivered: int, folded: int, joinPrefix: int,
  }
  var role: RoleState
  action init = role' = {
    member: true, writer: false, admin: true, permissionless: false,
    nextWriter: false, allowed: true, signed: 0, issued: 0,
    journaled: 0, delivered: 0, folded: 0, joinPrefix: 0,
  }
  pure def permitted(member: bool, writer: bool, admin: bool, permissionless: bool, acl: bool): bool =
    member and (if (acl) admin else permissionless or writer)
  action stageWriter = role' = role.with("nextWriter", true)
  action setWriter = role' = role.with("writer", true)
  action setPermissionless = role' = role.with("permissionless", true)
  action removeMember = role' = role.with("member", false)
  action requestApplication = role' = role.with("allowed",
    permitted(role.member, role.writer, role.admin, role.permissionless, false))
  action joinAfterPreflight = role' = if(role.allowed)
    role.with("joinPrefix",1).with("signed",1).with("issued",1).with("journaled",1)
    else role
  action unsafeJoinBeforePreflight = role' =
    role.with("joinPrefix",1).with("signed",1).with("issued",1).with("journaled",1)
  action attempt(mode, acl, bypass) = all {
    Set("local", "ingress", "replay", "fold").contains(mode),
    val allowed = permitted(role.member, role.writer, role.admin, role.permissionless, acl)
    val effect = if (allowed or bypass) 1 else 0
    role' = role.with("allowed", allowed)
      .with("signed", if (mode == "local") effect else 0)
      .with("issued", if (mode == "local") effect else 0)
      .with("journaled", if (mode != "fold") effect else 0)
      .with("delivered", if (mode != "fold") effect else 0)
      .with("folded", if (mode == "fold") effect else 0),
  }
  val unauthorizedOperationHasNoEffects = role.allowed or (
    role.signed == 0 and role.issued == 0 and role.journaled == 0 and
    role.delivered == 0 and role.folded == 0 and role.joinPrefix == 0)
  action check(condition) = all { condition, role' = role }
  run testCurrentLocalNonwriterRefusal = init
    .then(attempt("local", false, false))
    .then(check(not(role.allowed) and unauthorizedOperationHasNoEffects))
  run testCurrentIngressNonwriterRefusal = init
    .then(attempt("ingress", false, false))
    .then(check(not(role.allowed) and unauthorizedOperationHasNoEffects))
  run testCurrentReplayNonwriterRefusal = init
    .then(attempt("replay", false, false))
    .then(check(not(role.allowed) and unauthorizedOperationHasNoEffects))
  run testCurrentAdminOnlyFoldProgress = init
    .then(attempt("fold", true, false))
    .then(check(role.allowed and role.folded == 1 and not(role.writer)))
  run testCurrentStagedWriterNoEscalation = init.then(stageWriter)
    .then(attempt("local", false, false))
    .then(check(role.nextWriter and not(role.allowed) and unauthorizedOperationHasNoEffects))
  run testCurrentWriterPositive = init.then(setWriter)
    .then(attempt("local", false, false))
    .then(check(role.allowed and role.signed == 1 and role.issued == 1 and role.journaled == 1))
  run testCurrentPermissionlessStillRequiresMembership = init.then(setPermissionless)
    .then(attempt("local", false, false)).then(check(role.allowed))
    .then(removeMember).then(attempt("local", false, false))
    .then(check(not(role.allowed) and unauthorizedOperationHasNoEffects))
  run testCurrentWriterBypassMutationDetected = init
    .then(attempt("local", false, true))
    .then(check(not(unauthorizedOperationHasNoEffects)))
  run testCurrentFrontierPreflightRefusesPrefix = init.then(stageWriter)
    .then(requestApplication).then(joinAfterPreflight)
    .then(check(not(role.allowed) and unauthorizedOperationHasNoEffects))
  run testCurrentFrontierJoinOrderingMutationDetected = init
    .then(requestApplication).then(unsafeJoinBeforePreflight)
    .then(check(not(unauthorizedOperationHasNoEffects)))
}

// Local historical replacement adjunct, not portable ingress/replay authority.
// authenticatedSource/Writer and the immutable deterministic application policy
// are semantic inputs established by their original implementation owners.
// held models AHE/floor custody through delivery, journalHeld protects the
// original native issuance job, and the journal writer checks its own expected
// source before appending. Its read reservation must join BEFORE that write.
// The original prepared head remains fixed for this registration. Source reading
// captures the whole-floor image, including control-only changes; acquisition
// cannot refresh either a stale registration or a stale source capability.
// SQLite/IndexedDB exclusion, signature verification and atomic paired writes
// are PREMISES, not facts proved by this model. Separate acquire/sign/commit/
// delivery/release boundaries retain the sign-to-commit race explicitly.
module localSourceSettlementAuthority {
  type State = {
    source: bool, sourceWriter: bool, applicationSource: bool,
    policyBound: bool, candidateMatches: bool, planMatches: bool,
    member: bool, referee: bool, admissionsOpen: bool,
    head: int, floor: int, image: int, journal: int,
    sourceHead: int, sourceFloor: int,
    capturedHead: int, capturedFloor: int, capturedImage: int,
    capturedJournal: int, journalHeld: bool, journalJoined: bool, journalAppended: bool,
    held: bool, admitted: bool, signed: bool, committed: bool,
    delivered: bool, deliveryWasCurrent: bool, released: bool, refused: bool, debt: bool,
  }
  var s: State
  action init = s' = {
    source: false, sourceWriter: false, applicationSource: false,
    policyBound: false, candidateMatches: false, planMatches: false,
    member: true, referee: true, admissionsOpen: true,
    head: 0, floor: 0, image: 0, journal: 0,
    sourceHead: 0, sourceFloor: 0,
    capturedHead: 0, capturedFloor: 0, capturedImage: 0,
    capturedJournal: 0, journalHeld: false, journalJoined: false, journalAppended: false,
    held: false, admitted: false, signed: false, committed: false,
    delivered: false, deliveryWasCurrent: false, released: false, refused: false, debt: false,
  }
  action bindSource(writer: bool, application: bool): bool = all {
    not(s.admitted),
    s' = s.with("source",true).with("sourceWriter",writer)
      .with("applicationSource",application).with("policyBound",true)
      .with("candidateMatches",true).with("planMatches",true)
      .with("sourceFloor",s.floor),
  }
  action alterCandidate = all { not(s.admitted), s' = s.with("candidateMatches",false) }
  action alterPlan = all { not(s.admitted), s' = s.with("planMatches",false) }
  action losePolicyBinding = all { not(s.admitted), s' = s.with("policyBound",false) }
  val sourceAuthorized = s.source and s.sourceWriter and s.applicationSource and
    s.policyBound and s.candidateMatches and s.planMatches and s.member and s.referee
  val currency = s.head == s.capturedHead and s.floor == s.capturedFloor and
    s.image == s.capturedImage and s.journal == s.capturedJournal
  action acquire = all {
    not(s.admitted),
    val allowed = s.admissionsOpen and sourceAuthorized and
      s.head == s.sourceHead and s.floor == s.sourceFloor
    s' = s.with("admitted",allowed).with("held",allowed).with("refused",not(allowed))
      .with("journalHeld",allowed).with("capturedJournal",s.journal)
      .with("capturedHead",s.head).with("capturedFloor",s.floor).with("capturedImage",s.image),
  }
  action unsafeAcquireRefreshingSourceCheckpoint = all {
    not(s.admitted), s.admissionsOpen, sourceAuthorized,
    s' = s.with("admitted",true).with("held",true).with("journalHeld",true)
      .with("capturedJournal",s.journal).with("capturedHead",s.head)
      .with("capturedFloor",s.floor).with("capturedImage",s.image),
  }
  action sign = all { s.admitted, s.held, s.journalHeld, sourceAuthorized, currency, not(s.signed), s' = s.with("signed",true) }
  action commit = all { s.signed, s.held, s.journalHeld, currency, not(s.committed), s' = s.with("committed",true) }
  action joinJournalReads = all { s.committed, s.journalHeld, s' = s.with("journalHeld",false).with("journalJoined",true) }
  action appendJournal = all {
    s.committed, s.held, s.journalJoined, currency, not(s.journalAppended),
    s' = s.with("journal",s.journal+1).with("capturedJournal",s.journal+1).with("journalAppended",true),
  }
  action refuseStaleJournal = all {
    s.committed, s.journalJoined, not(currency),
    s' = s.with("refused",true).with("debt",true),
  }
  action deliver = all {
    s.committed, s.journalAppended, s.held, currency, not(s.delivered),
    s' = s.with("delivered",true).with("deliveryWasCurrent",currency),
  }
  // Closing revokes NEW admission immediately, but does not cancel admitted work.
  action closeAdmissions = s' = s.with("admissionsOpen",false)
  action release = all {
    s.held, s.delivered or (s.committed and s.refused and s.journalJoined),
    s' = s.with("held",false).with("released",true),
  }
  // Native exclusion is deliberately visible rather than hidden in sign/commit.
  action foreignHead = all { not(s.held), s' = s.with("head",s.head+1) }
  action foreignFloor = all { not(s.held), s' = s.with("floor",s.floor+1) }
  action foreignImage = all { not(s.held), s' = s.with("image",s.image+1) }
  action foreignJournal = all { not(s.journalHeld), s' = s.with("journal",s.journal+1) }
  action unsafeReleaseAfterSign = all { s.signed, not(s.committed), s' = s.with("held",false).with("released",true) }
  action unsafeCommitAfterHeadChange = all {
    s.signed,
    s' = s.with("head",s.head+1).with("committed",true).with("delivered",true).with("deliveryWasCurrent",false),
  }
  val sourceBoundEffects = not(s.signed or s.committed or s.delivered) or sourceAuthorized
  val sourceCheckpointBeforeAdmission = not(s.admitted) or
    (s.capturedHead == s.sourceHead and s.capturedFloor == s.sourceFloor)
  val currencyBeforeDelivery = not(s.delivered) or s.deliveryWasCurrent
  val admittedWorkJoinedBeforeRelease = not(s.released) or s.delivered or (s.committed and s.refused and s.journalJoined and s.debt)
  val wholeJobCustody = not(s.admitted) or s.held or s.delivered or (s.committed and s.refused and s.debt)
  val safety = sourceBoundEffects and sourceCheckpointBeforeAdmission and
    currencyBeforeDelivery and admittedWorkJoinedBeforeRelease and wholeJobCustody
  action check(condition: bool): bool = all { condition, s' = s }
  // Conditional progress witnesses under actual service of sign/commit/delivery;
  // not universal eventuality or fairness, crash or resource guarantees.
  run testLocalSettlementHistoricalRefereeContinuation = init.then(bindSource(true,true))
    .then(acquire).then(sign).then(commit).then(joinJournalReads).then(appendJournal).then(deliver).then(release)
    .then(check(safety and s.delivered and s.released))
  run testLocalSettlementClosingJoinsAdmitted = init.then(bindSource(true,true))
    .then(acquire).then(closeAdmissions).then(sign).then(commit).then(joinJournalReads).then(appendJournal).then(deliver).then(release)
    .then(check(safety and not(s.admissionsOpen) and s.delivered))
  run testLocalSettlementClosedAliasRefusesNewAdmission = init.then(bindSource(true,true))
    .then(closeAdmissions).then(acquire).then(check(safety and s.refused and not(s.admitted)))
  run testLocalSettlementMissingSourceRefusal = init.then(acquire).then(check(safety and s.refused and not(s.signed)))
  run testLocalSettlementOriginalNonwriterRefusal = init.then(bindSource(false,true))
    .then(acquire).then(check(safety and s.refused))
  run testLocalSettlementControlSourceRefusal = init.then(bindSource(true,false))
    .then(acquire).then(check(safety and s.refused))
  run testLocalSettlementAlteredCandidateRefusal = init.then(bindSource(true,true)).then(alterCandidate)
    .then(acquire).then(check(safety and s.refused))
  run testLocalSettlementAlteredPlanRefusal = init.then(bindSource(true,true)).then(alterPlan)
    .then(acquire).then(check(safety and s.refused))
  run testLocalSettlementPolicyBindingRefusal = init.then(bindSource(true,true)).then(losePolicyBinding)
    .then(acquire).then(check(safety and s.refused))
  run testLocalSettlementCurrentWholeStateAcquisition = init
    .then(foreignFloor).then(foreignImage).then(bindSource(true,true)).then(acquire)
    .then(sign).then(commit).then(joinJournalReads).then(appendJournal).then(deliver).then(release).then(check(safety and currency))
  run testLocalSettlementFloorChangeAfterSourceReadRefuses = init.then(bindSource(true,true))
    .then(foreignFloor).then(acquire)
    .then(check(safety and s.refused and not(s.admitted) and not(s.signed) and not(s.committed)))
  run testLocalSettlementHeadChangeAfterSourceReadRefuses = init.then(bindSource(true,true))
    .then(foreignHead).then(acquire)
    .then(check(safety and s.refused and not(s.admitted) and not(s.signed) and not(s.committed)))
  run testLocalSettlementSourceRefreshMutationDetected = init.then(bindSource(true,true))
    .then(foreignFloor).then(unsafeAcquireRefreshingSourceCheckpoint).then(check(not(safety)))
  run testLocalSettlementJournalReleaseRaceRefusesWithDebt = init.then(bindSource(true,true))
    .then(acquire).then(sign).then(commit).then(joinJournalReads).then(foreignJournal)
    .then(refuseStaleJournal).then(release).then(check(safety and s.debt and not(s.delivered)))
  run testLocalSettlementLaterChangesDoNotRewritePastDelivery = init.then(bindSource(true,true))
    .then(acquire).then(sign).then(commit).then(joinJournalReads).then(appendJournal).then(deliver).then(release)
    .then(foreignHead).then(foreignFloor).then(foreignImage).then(foreignJournal).then(check(safety))
  run testLocalSettlementEarlyReleaseMutationDetected = init.then(bindSource(true,true))
    .then(acquire).then(sign).then(unsafeReleaseAfterSign).then(check(not(safety)))
  run testLocalSettlementStaleDeliveryMutationDetected = init.then(bindSource(true,true))
    .then(acquire).then(sign).then(unsafeCommitAfterHeadChange).then(check(not(safety)))
}

// Public room input-custody adjunct, independent of historical settlement
// authority above. Exact canonical byte lengths, authenticated signed limits,
// native exclusion, crypto and storage atomicity are implementation premises.
// Capturing is split from entry reservation to expose synchronous reentry.
// Settled callers still retain their bytes until the frozen batch joins.
// Encoding temporaries and physical heap/RSS are deliberately not modeled.
module roomPublicInputCustody {
  val IDS = Set(0,1,2,3)
  val ENTRY_LIMIT = 3
  val BYTE_LIMIT = 8
  type State = { phase:int->int, bytes:int->int, charge:int->int,
    batch:Set[int], accepting:bool, refused:bool, joined:bool }
  var s:State
  action init = s' = {phase:IDS.mapBy(_=>0),bytes:IDS.mapBy(_=>0),charge:IDS.mapBy(_=>0),
    batch:Set(),accepting:true,refused:false,joined:false}
  val held = IDS.filter(id=>s.phase.get(id)>0)
  val charged = IDS.fold(0,(sum,id)=>sum+s.charge.get(id))
  val retained = IDS.fold(0,(sum,id)=>sum+s.bytes.get(id))
  val safety = held.size()<=ENTRY_LIMIT and charged<=BYTE_LIMIT and charged>=0 and
    charged==retained and IDS.forall(id=>
      (s.phase.get(id)<2 implies s.bytes.get(id)==0) and
      (s.phase.get(id)>=2 implies s.bytes.get(id)>=1))
  action reserve(id:int):bool = all {
    s.phase.get(id)==0,
    s' = if(s.accepting and held.size()<ENTRY_LIMIT)
      s.with("phase",s.phase.set(id,1)) else s.with("refused",true),
  }
  action capture(id:int,cost:int):bool = all {
    s.phase.get(id)==1, cost>=1, cost<=4,
    s' = if(cost<=BYTE_LIMIT-charged)
      s.with("phase",s.phase.set(id,2)).with("bytes",s.bytes.set(id,cost)).with("charge",s.charge.set(id,cost))
      else s.with("phase",s.phase.set(id,0)).with("refused",true),
  }
  // Runtime batches copy one operation at a time; phase5 is private partial
  // preparation, not an admitted native task. Reentrant capture can consume
  // remaining credit between chunks. Failure discards every unescaped chunk.
  action captureChunk(id:int,cost:int):bool = all {
    Set(1,5).contains(s.phase.get(id)),cost>=1,cost<=4,
    s'=if(cost<=BYTE_LIMIT-charged)
      s.with("phase",s.phase.set(id,5)).with("bytes",s.bytes.set(id,s.bytes.get(id)+cost))
        .with("charge",s.charge.set(id,s.charge.get(id)+cost))
      else s.with("phase",s.phase.set(id,0)).with("bytes",s.bytes.set(id,0))
        .with("charge",s.charge.set(id,0)).with("refused",true),
  }
  action finishCapture(id:int):bool = all {s.phase.get(id)==5,s'=s.with("phase",s.phase.set(id,2))}
  action transfer(id:int):bool = all {s.phase.get(id)==2,s'=s.with("phase",s.phase.set(id,3))}
  action releaseBeforeTransfer(id:int):bool = all {
    Set(1,2,5).contains(s.phase.get(id)),
    s'=s.with("phase",s.phase.set(id,0)).with("bytes",s.bytes.set(id,0)).with("charge",s.charge.set(id,0)),
  }
  action enterBatch = {
    val pending = IDS.filter(id=>s.phase.get(id)==3)
    all {s.batch.size()==0,pending.size()>0,s'=s.with("batch",pending)}
  }
  action settle(id:int):bool = all {
    s.batch.contains(id),s.phase.get(id)==3,s'=s.with("phase",s.phase.set(id,4)),
  }
  action joinBatch = all {
    s.batch.size()>0,s.batch.forall(id=>s.phase.get(id)==4),
    s'=s.with("phase",IDS.mapBy(id=>if(s.batch.contains(id))0 else s.phase.get(id)))
      .with("bytes",IDS.mapBy(id=>if(s.batch.contains(id))0 else s.bytes.get(id)))
      .with("charge",IDS.mapBy(id=>if(s.batch.contains(id))0 else s.charge.get(id)))
      .with("batch",Set()).with("joined",true),
  }
  action revoke = s'=s.with("accepting",false)
  action unsafeRefundSettled(id:int):bool = all {
    s.phase.get(id)==4,s'=s.with("charge",s.charge.set(id,0)),
  }
  action check(condition:bool):bool = all {condition,s'=s}
  action step = {
    nondet id = IDS.oneOf()
    nondet cost = Set(1,2,3,4).oneOf()
    any {reserve(id),capture(id,cost),captureChunk(id,cost),finishCapture(id),transfer(id),releaseBeforeTransfer(id),
      enterBatch,settle(id),joinBatch,revoke,s'=s}
  }
  // Conditional continuation when the admitted batch is actually serviced;
  // this is not universal fairness or a bounded native-work guarantee.
  run testRoomInputRetainedUntilBatchJoin = init.then(reserve(0)).then(capture(0,4)).then(transfer(0))
    .then(reserve(1)).then(capture(1,4)).then(transfer(1)).then(enterBatch).then(settle(0))
    .then(check(safety and charged==8)).then(reserve(2)).then(capture(2,1))
    .then(check(safety and s.refused and charged==8)).then(settle(1)).then(joinBatch)
    .then(reserve(2)).then(capture(2,4)).then(transfer(2)).then(enterBatch).then(settle(2)).then(joinBatch)
    .then(check(safety and s.joined and charged==0))
  run testRoomInputReentryUsesCurrentRemainingBytes = init.then(reserve(0)).then(reserve(1))
    .then(capture(1,4)).then(reserve(2)).then(capture(2,4)).then(capture(0,1))
    .then(check(safety and s.refused and s.phase.get(0)==0 and charged==8))
  run testRoomInputRevocationJoinsAdmitted = init.then(reserve(0)).then(capture(0,4)).then(transfer(0))
    .then(revoke).then(reserve(1)).then(enterBatch).then(settle(0)).then(joinBatch)
    .then(check(safety and s.refused and not(s.accepting) and charged==0))
  run testRoomInputEarlyRefundRejected = init.then(reserve(0)).then(capture(0,4)).then(transfer(0))
    .then(enterBatch).then(settle(0)).then(unsafeRefundSettled(0)).then(check(not(safety)))
  run testRuntimeInputPartialCaptureReentryRefusesAndReturnsCredit = init.then(reserve(0)).then(captureChunk(0,4))
    .then(reserve(1)).then(captureChunk(1,3)).then(captureChunk(0,2))
    .then(check(safety and s.refused and s.phase.get(0)==0 and charged==3))
    .then(finishCapture(1)).then(transfer(1)).then(enterBatch).then(settle(1)).then(joinBatch)
    .then(reserve(0)).then(captureChunk(0,4)).then(captureChunk(0,4)).then(finishCapture(0))
    .then(transfer(0)).then(enterBatch).then(settle(0)).then(joinBatch).then(check(safety and charged==0))
  action brokenInit = init.then(reserve(0)).then(capture(0,4)).then(transfer(0)).then(enterBatch).then(settle(0))
  action brokenStep = unsafeRefundSettled(0)
}

// Read-control admission adjunct. Native protected closure/currency/crypto and
// storage exclusion retain their original semantic owners and premises. Counts
// include entered reads until their native work and callback actually join.
// Waiting inputs are only those admitted behind the terminal barrier, not an
// abstraction permitting a transition to bypass an earlier native input job.
// The terminal capability adjunct covers one queued/entered publication until
// join, not its raw input bytes, authentication, storage effects or physical heap.
module readControlAdmission {
  val LIMIT = 3
  val PUBLICATION_BYTE_LIMIT = 3
  type State = { reads:int, enteredRead:bool, joinedReads:int, waitingInputs:int,
    queuedTransition:int, activeTransition:bool, barrier:bool, current:bool,
    refusals:int, lastAdmissionCurrent:bool, publications:int,
    enteredPublication:bool, terminal:bool, releasesJoined:bool,
    publicationBytes:int, sealedPublicationBytes:int, callerBytes:int,
    egressGate:int, egressQueuedGate:int, egressQueuedSelector:int,
    egressQueued:bool, egressEntered:bool, egressJoinedGate:int,
    egressExpectedGate:int, egressJoinedSelector:int, egressExpectedSelector:int }
  var s:State
  action init = s'={reads:0,enteredRead:false,joinedReads:0,waitingInputs:0,
    queuedTransition:0,activeTransition:false,barrier:false,current:true,
    refusals:0,lastAdmissionCurrent:true,publications:0,enteredPublication:false,
    terminal:false,releasesJoined:true,publicationBytes:0,sealedPublicationBytes:0,callerBytes:1,
    egressGate:0,egressQueuedGate:-1,egressQueuedSelector:-1,egressQueued:false,egressEntered:false,
    egressJoinedGate:-1,egressExpectedGate:-1,egressJoinedSelector:-1,egressExpectedSelector:-1}
  val safety = s.reads>=0 and s.reads<=LIMIT and s.waitingInputs>=0 and s.waitingInputs<=LIMIT and
    s.queuedTransition>=0 and s.queuedTransition<=1 and
    (s.enteredRead implies s.reads>0) and
    (s.activeTransition implies s.queuedTransition==0 and s.barrier) and
    (s.queuedTransition>0 implies s.barrier) and s.lastAdmissionCurrent and
    s.publications>=0 and s.publications<=1 and
    (s.publications>0 implies s.activeTransition and s.barrier) and
    (s.enteredPublication implies s.publications==1) and s.releasesJoined and
    s.publicationBytes>=0 and s.publicationBytes<=PUBLICATION_BYTE_LIMIT and
    (s.publications==1 implies s.publicationBytes==s.sealedPublicationBytes and s.publicationBytes>0) and
    (s.publications==0 implies s.publicationBytes==0) and
    s.egressQueuedGate<=s.egressGate and
    s.egressJoinedGate==s.egressExpectedGate and s.egressJoinedSelector==s.egressExpectedSelector
  action admitRead = s'=if(s.current and s.reads<LIMIT)
    s.with("reads",s.reads+1).with("lastAdmissionCurrent",s.current)
    else s.with("refusals",s.refusals+1)
  action enterRead = all {s.reads>0,not(s.enteredRead),s'=s.with("enteredRead",true)}
  action joinRead = all {s.enteredRead,s'=s.with("reads",s.reads-1)
    .with("enteredRead",false).with("joinedReads",s.joinedReads+1)}
  action requestTransition = s'=if(s.current and not(s.terminal) and s.queuedTransition==0 and not(s.activeTransition))
    s.with("queuedTransition",1).with("barrier",true).with("lastAdmissionCurrent",s.current)
    else s.with("refusals",s.refusals+1)
  action reserveWaitingInput = s'=if(s.current and s.barrier and s.waitingInputs<LIMIT)
    s.with("waitingInputs",s.waitingInputs+1).with("lastAdmissionCurrent",s.current)
    else s.with("refusals",s.refusals+1)
  action enterTransition = all {s.current,s.queuedTransition==1,s.reads==0,not(s.enteredRead),
    s'=s.with("queuedTransition",0).with("activeTransition",true)}
  action resume = s'=if(s.current and s.activeTransition and s.publications==0)
    s.with("activeTransition",false).with("barrier",false) else s.with("refusals",s.refusals+1)
  // Finite encoded-width classes. The canonical encoder/copy implementation,
  // opaque callbacks, temporary/physical heap and native proof are not modeled.
  action changeCaller(bytes:int):bool = s'=s.with("callerBytes",bytes)
  action requestPublication = s'=if(s.current and s.activeTransition and s.publications==0 and
      s.callerBytes>0 and s.callerBytes<=PUBLICATION_BYTE_LIMIT)
    s.with("publications",1).with("lastAdmissionCurrent",s.current)
      .with("publicationBytes",s.callerBytes).with("sealedPublicationBytes",s.callerBytes)
    else s.with("refusals",s.refusals+1)
  action enterPublication = all {s.current,s.publications==1,not(s.enteredPublication),s.reads==0,
    s'=s.with("enteredPublication",true)}
  // Permission only: the original protected/authenticated/native maintenance
  // census, forecast bytes and storage atomicity are separate semantic premises.
  val terminalMaintenanceAllowed = s.current and s.activeTransition and
    s.publications==1 and s.enteredPublication
  action observeTerminalMaintenance = all {terminalMaintenanceAllowed,s'=s}
  action joinAbsentPublication = all {s.enteredPublication,
    s'=s.with("publications",0).with("enteredPublication",false).with("publicationBytes",0)}
  // Commit or outcome-unknown consumes the terminal capability; native effects
  // and their terminal disposition remain implementation/native premises.
  action joinTerminalPublication = all {s.enteredPublication,
    s'=s.with("publications",0).with("enteredPublication",false).with("terminal",true).with("publicationBytes",0)
      .with("activeTransition",false).with("barrier",false)}
  action cancelRevokedPublication = all {not(s.current),s.publications==1,not(s.enteredPublication),s.reads==0,
    s'=s.with("publications",0).with("publicationBytes",0)}
  action joinWaitingInput = all {not(s.barrier),s.waitingInputs>0,s'=s.with("waitingInputs",s.waitingInputs-1)}
  action revoke = s'=s.with("current",false)
  action cancelRevokedTransition = all {not(s.current),s.queuedTransition==1,
    s'=s.with("queuedTransition",0).with("barrier",false)}
  action check(condition:bool):bool = all {condition,s'=s}
  // Latest replayable gate marker only, not a model of all queued tasks or a
  // universal resource bound. Selectors abstract immutable exact identities;
  // authentication, lawful replacement and native compare-and-mark are premises.
  // Pending one-row/FIFO publication is deliberately NOT a replayable request.
  action requestReplayable(selector:int):bool = s'=if(not(s.current))
    s.with("refusals",s.refusals+1)
    else if(s.egressQueued and s.egressQueuedGate==s.egressGate and s.egressQueuedSelector==selector)
      s.with("egressJoinedGate",s.egressQueuedGate).with("egressExpectedGate",s.egressGate)
        .with("egressJoinedSelector",s.egressQueuedSelector).with("egressExpectedSelector",selector)
    else s.with("egressGate",s.egressGate+1).with("egressQueuedGate",s.egressGate+1)
      .with("egressQueuedSelector",selector).with("egressQueued",true)
  action queueEgressCut = s'=s.with("egressGate",s.egressGate+1)
  action enterReplayable = all {s.egressQueued,s.egressQueuedGate==s.egressGate,not(s.egressEntered),
    s'=s.with("egressQueued",false).with("egressEntered",true)}
  action joinReplayable = all {s.egressEntered,s'=s.with("egressEntered",false)}
  // Reservation precedes caller inspection; reentered work advances the tail.
  // The outer capture cannot join or replace a marker at that newer tail.
  action reentrantReplayable = all {s.current,s'=s.with("egressGate",s.egressGate+2)}
  action step = any {admitRead,enterRead,joinRead,requestTransition,reserveWaitingInput,
    enterTransition,resume,joinWaitingInput,revoke,cancelRevokedTransition,
    requestPublication,enterPublication,observeTerminalMaintenance,joinAbsentPublication,joinTerminalPublication,cancelRevokedPublication,
    changeCaller(1),changeCaller(2),changeCaller(3),changeCaller(4),
    requestReplayable(0),requestReplayable(1),requestReplayable(2),queueEgressCut,
    enterReplayable,joinReplayable,reentrantReplayable,s'=s}
  // Conditional service witnesses, not universal fairness/eventuality claims.
  run testReadControlFullPoolJoinsThenRequiredTransitionContinues = init.then(admitRead).then(enterRead)
    .then(admitRead).then(admitRead).then(admitRead).then(requestTransition).then(requestTransition)
    .then(reserveWaitingInput).then(reserveWaitingInput).then(reserveWaitingInput)
    .then(check(safety and s.reads==LIMIT and s.queuedTransition==1 and s.waitingInputs==LIMIT and s.refusals==2))
    .then(joinRead).then(enterRead).then(joinRead).then(enterRead).then(joinRead)
    .then(enterTransition).then(resume).then(joinWaitingInput).then(joinWaitingInput).then(joinWaitingInput)
    .then(admitRead).then(enterRead).then(joinRead)
    .then(check(safety and s.reads==0 and s.waitingInputs==0 and s.joinedReads==4))
  run testReadControlRevocationRefusesAndJoinsAdmitted = init.then(admitRead).then(enterRead)
    .then(requestTransition).then(revoke).then(admitRead).then(requestTransition)
    .then(joinRead).then(cancelRevokedTransition).then(check(safety and s.reads==0 and s.refusals==2 and not(s.barrier)))
  action unsafeOverbookRead = s'=s.with("reads",s.reads+1)
  action brokenInit = init.then(admitRead).then(admitRead).then(admitRead)
  action brokenStep = unsafeOverbookRead
  run testReadControlOverbookMutationRejected = brokenInit.then(brokenStep).then(check(not(safety)))
  run testTerminalPublicationRefusesThenAbsentRetryJoins = init.then(requestTransition).then(enterTransition)
    .then(requestPublication).then(requestPublication).then(resume)
    .then(check(safety and s.publications==1 and s.barrier and s.refusals==2))
    .then(enterPublication).then(resume).then(joinAbsentPublication).then(requestPublication)
    .then(enterPublication).then(joinAbsentPublication).then(resume)
    .then(check(safety and s.publications==0 and not(s.barrier) and s.refusals==3))
  run testTerminalPublicationCommitsAndReleasesJoined = init.then(requestTransition).then(enterTransition)
    .then(requestPublication).then(check(not(terminalMaintenanceAllowed)))
    .then(enterPublication).then(observeTerminalMaintenance).then(resume).then(joinTerminalPublication)
    .then(requestTransition).then(requestPublication)
    .then(check(safety and s.terminal and not(s.barrier) and s.refusals==3))
  run testTerminalPublicationRevocationJoinsBeforeRelease = init.then(requestTransition).then(enterTransition)
    .then(requestPublication).then(enterPublication).then(revoke).then(requestPublication).then(resume)
    .then(check(safety and s.barrier and s.publications==1 and s.refusals==2 and not(terminalMaintenanceAllowed)))
    .then(joinAbsentPublication).then(check(safety and s.publications==0))
  action brokenPublicationInit = init.then(requestTransition).then(enterTransition).then(requestPublication)
  action brokenPublicationStep = s'=s.with("barrier",false).with("releasesJoined",false)
  run testTerminalPublicationPrematureReleaseMutationRejected = brokenPublicationInit.then(brokenPublicationStep).then(check(not(safety)))
  run testTerminalCopiedInputMutationJoinsThenRetry = init.then(requestTransition).then(enterTransition)
    .then(requestPublication).then(changeCaller(4)).then(requestPublication).then(resume)
    .then(check(safety and s.publicationBytes==1 and s.sealedPublicationBytes==1 and s.refusals==2))
    .then(enterPublication).then(joinAbsentPublication).then(check(safety and s.publicationBytes==0))
    .then(requestPublication).then(check(safety and s.publications==0 and s.refusals==3))
    .then(changeCaller(1)).then(requestPublication).then(enterPublication).then(joinAbsentPublication).then(resume)
    .then(check(safety and s.publicationBytes==0 and not(s.barrier)))
  run testTerminalCopiedInputFullWaitingPoolStillCommits = init.then(requestTransition).then(enterTransition)
    .then(reserveWaitingInput).then(reserveWaitingInput).then(reserveWaitingInput)
    .then(changeCaller(3)).then(requestPublication).then(changeCaller(4)).then(enterPublication).then(joinTerminalPublication)
    .then(check(safety and s.terminal and s.publicationBytes==0 and s.waitingInputs==LIMIT))
    .then(joinWaitingInput).then(joinWaitingInput).then(joinWaitingInput).then(check(safety and s.waitingInputs==0))
  action brokenCopiedInputInit = init.then(requestTransition).then(enterTransition).then(requestPublication).then(changeCaller(4))
  action brokenCopiedInputStep = s'=s.with("publicationBytes",s.callerBytes)
  run testTerminalCopiedInputAliasMutationRejected = brokenCopiedInputInit.then(brokenCopiedInputStep).then(check(not(safety)))
  run testReplayableSameIdentityCutJoinsThenFreshContinuation = init.then(requestReplayable(1)).then(requestReplayable(1))
    .then(check(safety and s.egressGate==1 and s.egressJoinedGate==1))
    .then(queueEgressCut).then(requestReplayable(1)).then(check(safety and s.egressGate==3))
    .then(enterReplayable).then(requestReplayable(1)).then(check(safety and s.egressGate==4 and s.egressEntered))
    .then(joinReplayable).then(enterReplayable).then(joinReplayable)
    .then(revoke).then(requestReplayable(1)).then(check(safety and not(s.egressQueued) and s.refusals==1))
  run testReplayableDifferentIdentityAndReentryStayFresh = init.then(requestReplayable(1)).then(requestReplayable(2))
    .then(check(safety and s.egressGate==2)).then(reentrantReplayable).then(requestReplayable(2))
    .then(check(safety and s.egressGate==5 and s.egressQueuedGate==5))
    .then(enterReplayable).then(joinReplayable).then(check(safety and not(s.egressQueued) and not(s.egressEntered)))
  action brokenReplayableInit = init.then(requestReplayable(1)).then(queueEgressCut)
  action brokenReplayableStep = s'=s.with("egressJoinedGate",s.egressQueuedGate).with("egressExpectedGate",s.egressGate)
    .with("egressJoinedSelector",s.egressQueuedSelector).with("egressExpectedSelector",1)
  run testReplayableStaleCutMutationRejected = brokenReplayableInit.then(brokenReplayableStep).then(check(not(safety)))
}

// Approved Chat carried-capacity adjunct. Existing native current-Writer and
// authenticated settlement owners remain semantic owners; this is not another
// authority or a portable proof. Domains: two authenticated enrolled members,
// four distinct message identities, charge=2 abstract units, total=8, epochs0..2.
// Complete canonical message/ledger framing, genuine signatures/source claims,
// current head/whole safety floors, native admission exclusion/atomicity and
// snapshot/settlement authentication are PREMISES. Units are NOT encoded bytes,
// proof charges, hard memory, storage usage or a performance threshold.
// Genesis dormant enrollment is the approved target policy, not a claim that
// the earlier Writer-only MAIN initializer implements it. Newer settled
// incarnation is authenticated input; terminalThrough/local completion is not.
// This models initial carrying plus conditional authenticated reallocation from
// one revoked source to the sole other current Writer; multi-Writer quotient/
// remainder distribution and allocation metadata operations are not modeled.
// implementation/native trace conformance and import/replay remain separate.
module carriedChatCapacity {
  pure val MEMBERS = Set(0,1)
  pure val IDS = Set(0,1,2,3)
  pure val TOTAL = 8
  pure val CHARGE = 2
  pure def author(id:int):int = if(id<2)0 else 1
  pure val INITIAL_CEILINGS = Map(0->4,1->4)
  type State = {
    epoch:int, writers:Set[int], nextWriters:Set[int],
    ceilings:int->int, sourceClaims:int->int, allocationIncarnation:int->int,
    settledIncarnation:int->int, terminalThrough:int->int,
    pending:Set[int], completed:Set[int], admitted:Set[int], joined:Set[int],
    committed:Set[int], protectedMessages:Set[int], refused:bool,
    releases:int, lastReleaseIncarnation:int, lastReleaseSourceIncarnation:int,
    lastReleaseJoined:bool,
    lastRollover:bool, carriedCeilings:int->int, carriedSourceClaims:int->int,
    carriedCommitted:Set[int], carriedPending:Set[int],
  }
  var s:State
  action init = s'={
    epoch:0,writers:Set(0),nextWriters:Set(0),
    ceilings:INITIAL_CEILINGS,sourceClaims:INITIAL_CEILINGS,
    allocationIncarnation:Map(0->0,1->0),settledIncarnation:Map(0->-1,1->-1),terminalThrough:Map(0->-1,1->-1),
    pending:Set(),completed:Set(),admitted:Set(),joined:Set(),committed:Set(),protectedMessages:Set(),refused:false,
    releases:0,lastReleaseIncarnation:-1,lastReleaseSourceIncarnation:-1,lastReleaseJoined:true,lastRollover:false,
    carriedCeilings:INITIAL_CEILINGS,carriedSourceClaims:INITIAL_CEILINGS,carriedCommitted:Set(),carriedPending:Set(),
  }
  def used(member:int):int = s.committed.filter(id=>author(id)==member).size()*CHARGE
  def charged(member:int):int = s.committed.union(s.pending).filter(id=>author(id)==member).size()*CHARGE
  def canReserve(member:int,id:int):bool = MEMBERS.contains(member) and IDS.contains(id) and author(id)==member and
    s.writers.contains(member) and not(s.admitted.contains(id)) and charged(member)+CHARGE<=s.ceilings.get(member)
  action reserve(member:int,id:int):bool = all {
    canReserve(member,id),
    s'=s.with("pending",s.pending.union(Set(id))).with("admitted",s.admitted.union(Set(id)))
      .with("refused",false).with("lastRollover",false),
  }
  action refuse(member:int,id:int):bool = all {
    not(canReserve(member,id)),s'=s.with("refused",true).with("lastRollover",false),
  }
  action commit(id:int):bool = all {
    s.pending.contains(id),not(s.committed.contains(id)),
    s'=s.with("committed",s.committed.union(Set(id))).with("protectedMessages",s.protectedMessages.union(Set(id)))
      .with("lastRollover",false),
  }
  action complete(id:int):bool = all {
    s.pending.contains(id),not(s.completed.contains(id)),
    s'=s.with("completed",s.completed.union(Set(id))).with("lastRollover",false),
  }
  // Completion/cancellation does not release retained native reservations.
  // This boundary is the actual joined release, including abort of uncommitted
  // input. Committed message bytes remain protected after their job joins.
  action joinWork(id:int):bool = all {
    s.pending.contains(id),s.completed.contains(id),
    s'=s.with("pending",s.pending.exclude(Set(id))).with("joined",s.joined.union(Set(id)))
      .with("lastRollover",false),
  }
  action stageRole(member:int,writer:bool):bool = all {
    MEMBERS.contains(member),
    s'=s.with("nextWriters",if(writer)s.nextWriters.union(Set(member)) else s.nextWriters.exclude(Set(member)))
      .with("lastRollover",false),
  }
  val canRollover = s.epoch<2 and s.pending==Set()
  action rollover = all {
    canRollover,
    s'=s.with("epoch",s.epoch+1).with("writers",s.nextWriters).with("lastRollover",true)
      .with("carriedCeilings",s.ceilings).with("carriedSourceClaims",s.sourceClaims)
      .with("carriedCommitted",s.committed).with("carriedPending",s.pending),
  }
  action terminalObservation(member:int):bool = all {
    MEMBERS.contains(member),s'=s.with("terminalThrough",s.terminalThrough.set(member,3)).with("lastRollover",false),
  }
  // The authentication/current floor check is a premise of this native input,
  // not encoded cryptography. Never derive this action from terminalObservation.
  action authenticatedSettlement(member:int,incarnation:int):bool = all {
    MEMBERS.contains(member),incarnation>=0,incarnation<=s.epoch,
    incarnation>s.settledIncarnation.get(member),
    s'=s.with("settledIncarnation",s.settledIncarnation.set(member,incarnation)).with("lastRollover",false),
  }
  def canReallocate(source:int,target:int):bool = MEMBERS.contains(source) and MEMBERS.contains(target) and source!=target and
    not(s.writers.contains(source)) and s.writers.contains(target) and s.pending==Set() and
    s.settledIncarnation.get(source)>s.allocationIncarnation.get(source)
  action reallocate(source:int,target:int):bool = all {
    canReallocate(source,target),
    val kept=used(source)
    val released=s.ceilings.get(source)-kept
    val granted=s.ceilings.get(target)+released
    s'=s.with("ceilings",s.ceilings.set(source,kept).set(target,granted))
      .with("sourceClaims",s.sourceClaims.set(source,kept).set(target,granted))
      .with("allocationIncarnation",s.allocationIncarnation.set(source,s.settledIncarnation.get(source)))
      .with("releases",s.releases+1).with("lastReleaseIncarnation",s.settledIncarnation.get(source))
      .with("lastReleaseSourceIncarnation",s.allocationIncarnation.get(source))
      .with("lastReleaseJoined",s.pending==Set()).with("lastRollover",false),
  }
  val finiteDisjointEntitlements = s.ceilings.get(0)>=0 and s.ceilings.get(1)>=0 and
    s.ceilings.get(0)+s.ceilings.get(1)==TOTAL
  val protectedSourceCharges = MEMBERS.forall(member=>charged(member)<=s.ceilings.get(member) and
    s.sourceClaims.get(member)<=s.ceilings.get(member) and s.sourceClaims.get(member)>=used(member)) and
    s.committed==s.protectedMessages
  val reservationsRetainedUntilJoin = s.pending==s.admitted.exclude(s.joined) and
    s.joined.subseteq(s.completed) and s.committed.subseteq(s.admitted)
  val ceilingsAndClaimsCarried = not(s.lastRollover) or
    (s.ceilings==s.carriedCeilings and s.sourceClaims==s.carriedSourceClaims and
      s.committed==s.carriedCommitted and s.pending==s.carriedPending)
  val releaseRequiresNewerSettlement = s.releases==0 or
    (s.lastReleaseIncarnation>s.lastReleaseSourceIncarnation and s.lastReleaseJoined)
  val safety = finiteDisjointEntitlements and protectedSourceCharges and reservationsRetainedUntilJoin and
    ceilingsAndClaimsCarried and releaseRequiresNewerSettlement and s.epoch>=0 and s.epoch<=2
  val enrolledWriterMessageWitness = s.protectedMessages.contains(2)
  val legitimateReleaseWitness = s.releases>0 and s.protectedMessages.contains(0) and s.protectedMessages.contains(2)
  action check(condition:bool):bool = all {condition,s'=s}
  // Genuine nondeterministic action selection; witness schedules below are
  // existence/anti-vacuity checks, not universal progress or fairness claims.
  action reserveChoice = {
    nondet id=IDS.filter(candidate=>canReserve(author(candidate),candidate)).oneOf()
    reserve(author(id),id)
  }
  action completeChoice = {
    nondet id=s.pending.exclude(s.completed).oneOf()
    complete(id)
  }
  action commitChoice = {
    nondet id=s.pending.exclude(s.committed).oneOf()
    commit(id)
  }
  action joinChoice = {
    nondet id=s.pending.intersect(s.completed).oneOf()
    joinWork(id)
  }
  action stageChoice = {
    nondet member=MEMBERS.oneOf()
    nondet writer=Set(true,false).oneOf()
    stageRole(member,writer)
  }
  action settlementChoice = {
    nondet member=MEMBERS.filter(candidate=>s.settledIncarnation.get(candidate)<s.epoch).oneOf()
    authenticatedSettlement(member,s.epoch)
  }
  action reallocateChoice = {
    nondet source=MEMBERS.filter(candidate=>canReallocate(candidate,1-candidate)).oneOf()
    reallocate(source,1-source)
  }
  action terminalChoice = {
    nondet member=MEMBERS.oneOf()
    terminalObservation(member)
  }
  action step = any {reserveChoice,completeChoice,commitChoice,joinChoice,stageChoice,rollover,settlementChoice,reallocateChoice,terminalChoice,s'=s}
  run testCarriedCapacityDormantGrantAndMessage = init.then(refuse(1,2)).then(stageRole(1,true)).then(refuse(1,2))
    .then(check(safety and s.refused and s.ceilings.get(1)==4 and s.admitted==Set()))
    .then(rollover).then(reserve(1,2)).then(commit(2)).then(complete(2)).then(joinWork(2))
    .then(check(safety and enrolledWriterMessageWitness and s.sourceClaims.get(1)==4))
  run testCarriedCapacityRolloverPreservesClaimsAndMessages = init.then(reserve(0,0)).then(commit(0)).then(complete(0)).then(joinWork(0))
    .then(stageRole(1,true)).then(rollover).then(terminalObservation(0)).then(rollover)
    .then(check(safety and s.ceilings==INITIAL_CEILINGS and s.sourceClaims==INITIAL_CEILINGS and s.protectedMessages==Set(0)))
  run testCarriedCapacityCompletionStillHoldsUntilJoin = init.then(reserve(0,0)).then(complete(0))
    .then(check(safety and charged(0)==2 and s.pending==Set(0) and not(canRollover)))
    .then(joinWork(0)).then(check(safety and charged(0)==0 and s.sourceClaims.get(0)==4 and s.ceilings.get(0)==4))
  run testCarriedCapacityTerminalThroughDoesNotRelease = init.then(stageRole(0,false)).then(stageRole(1,true)).then(rollover)
    .then(terminalObservation(0)).then(authenticatedSettlement(0,0))
    .then(check(safety and not(canReallocate(0,1)) and s.sourceClaims.get(0)==4 and s.ceilings.get(0)==4))
  run testCarriedCapacityAuthenticatedReleaseAndReallocation = init.then(reserve(0,0)).then(commit(0)).then(complete(0)).then(joinWork(0))
    .then(stageRole(0,false)).then(stageRole(1,true)).then(rollover).then(authenticatedSettlement(0,1))
    .then(reserve(1,2)).then(complete(2)).then(check(safety and not(canReallocate(0,1))))
    .then(commit(2)).then(joinWork(2)).then(reallocate(0,1)).then(reserve(1,3)).then(commit(3)).then(complete(3)).then(joinWork(3))
    .then(check(safety and legitimateReleaseWitness and s.ceilings.get(0)==2 and s.ceilings.get(1)==6 and s.protectedMessages==Set(0,2,3)))
  // Deliberately refill the epoch budget: total and carried-source laws must
  // reject this, rather than clearing pending/protected bytes to hide overflow.
  action unsafeRefresh = all {
    canRollover,
    s'=s.with("epoch",s.epoch+1).with("writers",s.nextWriters)
      .with("ceilings",s.ceilings.set(0,s.ceilings.get(0)+4).set(1,s.ceilings.get(1)+4))
      .with("lastRollover",true).with("carriedCeilings",s.ceilings).with("carriedSourceClaims",s.sourceClaims)
      .with("carriedCommitted",s.committed).with("carriedPending",s.pending),
  }
  action brokenInit = init
  action brokenStep = unsafeRefresh
  run testCarriedCapacityRefreshMutationRejected = init.then(unsafeRefresh).then(check(not(safety)))
}

module issuanceNativeRetirementParticipant {
  var s: {revision:int, image:int, capturedRevision:int, capturedImage:int, held:bool, used:bool, active:bool, completed:bool, frontier:int, holes:Set[int], permanentFrontier:int, permanentHoles:Set[int], epochs:int->int, pending:Set[int], next:int, watermark:int, observedNew:bool, refused:bool, unsafeAdmission:bool, signCalls:int, signPending:bool, signCancelled:bool}
  action init = s' = {revision:0,image:0,capturedRevision:0,capturedImage:0,held:false,used:false,active:false,completed:false,frontier:-1,holes:Set(),permanentFrontier:-1,permanentHoles:Set(),epochs:Map(0->0,1->1,2->2),pending:Set(),next:3,watermark:-1,observedNew:false,refused:false,unsafeAdmission:false,signCalls:0,signPending:false,signCancelled:false}
  action capture = s' = s.with("capturedRevision",s.revision).with("capturedImage",s.image).with("used",false).with("refused",false)
  val currency = not(s.held) and not(s.used) and s.capturedRevision==s.revision and s.capturedImage==s.image
  pure def permits(frontier,holes,epoch,seq) = epoch>frontier or holes.contains(seq)
  def prepareAllowed(frontier:int,holes:Set[int]):bool = all {
    currency, not(s.active), frontier>=s.frontier,
    holes.forall(seq=>s.epochs.keys().contains(seq) and s.epochs.get(seq)<=frontier and (s.epochs.get(seq)>s.frontier or s.holes.contains(seq))),
    s.pending.forall(seq=>permits(frontier,holes,s.epochs.get(seq),seq))
  }
  action prepare(frontier:int,holes:Set[int]):bool = all{prepareAllowed(frontier,holes),s'=s.with("active",true).with("frontier",frontier).with("holes",holes).with("used",true).with("revision",s.revision+1)
  }
  action commit = all {currency,s.active,s'=s.with("active",false).with("completed",true).with("permanentFrontier",s.frontier).with("permanentHoles",s.holes).with("used",true).with("revision",s.revision+1)}
  action abort = all {currency,s.active,s'=s.with("active",false).with("frontier",s.permanentFrontier).with("holes",s.permanentHoles).with("used",true).with("revision",s.revision+1)}
  action oldPublication(seq:int):bool = all {s.epochs.keys().contains(seq),permits(s.frontier,s.holes,s.epochs.get(seq),seq),s'=s.with("pending",s.pending.exclude(Set(seq))).with("image",s.image+1).with("revision",s.revision+1)}
  action issue(epoch:int):bool = all {epoch>s.frontier,s'=s.with("epochs",s.epochs.put(s.next,epoch)).with("pending",s.pending.union(Set(s.next))).with("next",s.next+1).with("image",s.image+1).with("revision",s.revision+1)}
  action foreignRow = s'=s.with("image",s.image+1)
  action foreignControl = s'=s.with("revision",s.revision+1)
  action hold = s'=s.with("held",true)
  action join = s'=s.with("held",false)
  action busy = all {currency,s'=s.with("used",true).with("refused",true)}
  action loseAck = all {s.active,s'=s.with("observedNew",true)}
  val safety = s.watermark==-1 and s.next>=3 and s.holes.forall(seq=>s.epochs.keys().contains(seq)) and not(s.unsafeAdmission)
  run issuanceParticipantRowCurrencyTest = init.then(capture).then(foreignRow).then(all{not(prepareAllowed(0,Set())),s'=s}).expect(safety)
  run issuanceParticipantControlCurrencyTest = init.then(capture).then(foreignControl).then(all{not(prepareAllowed(0,Set())),s'=s}).expect(safety)
  run issuanceParticipantPendingHoleTest = init.then(s'=s.with("pending",Set(1))).then(capture).then(all{not(prepareAllowed(1,Set())),s'=s}).then(prepare(1,Set(1))).expect(s.active and safety)
  run issuanceParticipantFutureSequenceTest = init.then(capture).then(prepare(1,Set())).then(issue(3)).expect(s.next==4 and s.epochs.get(3)==3 and safety)
  run issuanceParticipantOldPublicationTest = init.then(capture).then(prepare(1,Set(1))).then(all{not(permits(s.frontier,s.holes,s.epochs.get(0),0)),s'=s}).then(oldPublication(1)).expect(safety)
  run issuanceParticipantReleaseJoinTest = init.then(capture).then(hold).then(all{not(prepareAllowed(0,Set())),s'=s}).then(join).then(prepare(0,Set())).expect(safety)
  run issuanceParticipantBusyConsumedTest = init.then(capture).then(busy).then(all{not(prepareAllowed(0,Set())),s'=s}).expect(s.used and safety)
  run issuanceParticipantCommitNoAbortTest = init.then(capture).then(prepare(0,Set())).then(capture).then(commit).then(capture).then(all{not(currency and s.active),s'=s}).expect(safety)
  run issuanceParticipantHoleDropTest = init.then(capture).then(prepare(1,Set(1))).then(capture).then(commit).then(capture).then(prepare(2,Set())).then(capture).then(commit).then(capture).then(all{not(prepareAllowed(3,Set(1))),s'=s}).expect(safety)
  run issuanceParticipantLostAckTest = init.then(capture).then(prepare(0,Set())).then(loseAck).expect(s.active and s.observedNew and safety)
  run issuanceParticipantMissingFenceKilledTest = init.then(capture).then(prepare(1,Set())).then(s'=s.with("epochs",s.epochs.put(s.next,0)).with("next",s.next+1).with("unsafeAdmission",true)).expect(not(safety))
  run issuanceParticipantMissingImageKilledTest = init.then(capture).then(foreignRow).then(all{not(s.held),not(s.used),s.capturedRevision==s.revision,s'=s.with("active",true).with("unsafeAdmission",s.capturedImage!=s.image)}).expect(not(safety))
  // Atomic settlement effects validate the complete native candidate postimage,
  // not the pre-insert image. Native plan/CAS and signatures remain premises.
  def futureSettlementRefsAllowed(epoch:int,postimage:bool):bool = {
    val rows=if(postimage)s.epochs.put(s.next,epoch) else s.epochs
    Set(2,s.next).forall(seq=>rows.keys().contains(seq) and permits(s.frontier,s.holes,rows.get(seq),seq))
  }
  run issuanceParticipantActiveSettlementPostimageTest = init.then(capture).then(prepare(0,Set()))
    .then(all{not(futureSettlementRefsAllowed(2,false)),futureSettlementRefsAllowed(2,true),s'=s})
    .then(issue(2)).expect(s.next==4 and s.epochs.get(3)==2 and safety)
  run issuanceParticipantCommittedSettlementPostimageTest = init.then(capture).then(prepare(0,Set()))
    .then(capture).then(commit)
    .then(all{not(futureSettlementRefsAllowed(2,false)),futureSettlementRefsAllowed(2,true),s'=s})
    .then(issue(2)).expect(s.completed and s.next==4 and s.epochs.get(3)==2 and safety)
  // Original native sign reservation excludes prepare through callback join.
  // The real serialized epoch, native locking and crypto remain native premises.
  action nativeSignStart(epoch:int):bool = all {not(s.signCancelled),not(s.held),epoch>s.frontier,
    s'=s.with("held",true).with("signPending",true).with("signCalls",s.signCalls+1)}
  action nativeSignClose = s'=s.with("signCancelled",true)
  action nativeSignJoin = s'=s.with("held",false).with("signPending",false)
  val signSafety = safety and (not(s.signCancelled) or s.next==3) and
    (not(s.signPending) or s.held)
  run issuanceParticipantRetiredPresignRefusalTest = init.then(capture).then(prepare(0,Set()))
    .then(all{not(0>s.frontier),s'=s}).expect(s.signCalls==0 and signSafety)
  run issuanceParticipantHeldPresignFenceTest = init.then(capture).then(nativeSignStart(1))
    .then(all{not(prepareAllowed(0,Set())),s'=s}).then(nativeSignJoin)
    .then(prepare(0,Set())).then(issue(1)).expect(s.next==4 and s.signCalls==1 and signSafety)
  run issuanceParticipantPresignCloseJoinTest = init.then(nativeSignStart(1)).then(nativeSignClose)
    .then(all{s.signPending,s.signCancelled,s'=s}).then(nativeSignJoin)
    .expect(s.next==3 and not(s.signPending) and signSafety)
  run issuanceParticipantCloseRetainsNativeSignExclusionTest = init.then(capture).then(nativeSignStart(1))
    .then(nativeSignClose).then(all{s.signPending,s.held,not(prepareAllowed(0,Set())),s'=s})
    .then(nativeSignJoin).expect(s.signCancelled and not(s.signPending) and not(s.held) and signSafety)
  run issuanceParticipantEarlyCloseReleaseKilledTest = init.then(nativeSignStart(1))
    .then(s'=s.with("held",false).with("signCancelled",true)).expect(not(signSafety))
}
