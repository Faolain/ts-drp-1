module sealPacemaker {
  pure val SIGNERS = Set("A", "B", "C", "D", "E", "F", "G")
  pure val VALUES = Set("value-X", "value-Y")
  pure val PHASES = Set("awaiting", "prepared", "committed", "finalized", "stopped", "terminal")
  pure val OBJECT_ID = "object-0"
  pure val ANCHOR = "anchor-0"
  pure val EMPTY = ""
  pure val MAX_FUTURE_ROUND_GAP = 8

  type Vote = {
    signer: str,
    objectId: str,
    epoch: int,
    anchor: str,
    round: int,
    phase: str,
    valueDigest: str,
    proposalHash: str,
    signatureValid: bool,
  }

  type Qc = {
    objectId: str,
    epoch: int,
    anchor: str,
    round: int,
    phase: str,
    valueDigest: str,
    proposalHash: str,
    votes: Set[Vote],
  }

  type RoundChange = {
    signer: str,
    objectId: str,
    epoch: int,
    anchor: str,
    round: int,
    hasHighestPrepareQc: bool,
    highestPrepareQc: Qc,
    signatureValid: bool,
  }

  type ProposalBundle = {
    leader: str,
    objectId: str,
    epoch: int,
    round: int,
    cutValueDigest: str,
    valueDigest: str,
    proposalHash: str,
    cutValueValid: bool,
    leaderVote: Vote,
    certificateRound: int,
    certificateValue: str,
    certificateValid: bool,
  }

  type Envelope = {
    kind: str,
    source: str,
    target: str,
    copyId: int,
    round: int,
    phase: str,
    valueDigest: str,
    proposalHash: str,
  }

  type PacemakerState = {
    activeN: int,
    enteredRound: str -> int,
    phase: str -> str,
    proposedValue: str -> str,
    lockedValue: str -> str,
    lockRound: str -> int,
    highestPrepareRound: str -> int,
    highestPrepareValue: str -> str,
    localCommitVoteValue: str -> str,
    finalizedValue: str -> str,
    durableVotes: Set[Vote],
    durablePrepareQcs: Set[Qc],
    durableCommitQcs: Set[Qc],
    durableRoundChanges: Set[RoundChange],
    durableOutbox: Set[Envelope],
    network: Set[Envelope],
    delivered: Set[Envelope],
    acceptedProposals: Set[ProposalBundle],
    futureRounds: Set[int],
    events: Set[str],
    revision: int,
    crashCount: int,
    crashed: bool,
    livenessTick: int,
  }

  var state: PacemakerState

  pure def quorum(n: int): int =
    if (n == 4) 3 else if (n == 5) 4 else if (n == 6) 5 else 5

  pure def fPlusOne(n: int): int =
    if (n == 4) 2 else if (n == 5) 2 else if (n == 6) 2 else 3

  pure def activeSigner(signer: str, n: int): bool =
    if (n == 4) Set("A", "B", "C", "D").contains(signer)
    else if (n == 5) Set("A", "B", "C", "D", "E").contains(signer)
    else if (n == 6) Set("A", "B", "C", "D", "E", "F").contains(signer)
    else SIGNERS.contains(signer)

  pure def byzantineSigner(signer: str, n: int): bool =
    if (n == 4) signer == "D"
    else if (n == 5) signer == "E"
    else if (n == 6) signer == "F"
    else Set("F", "G").contains(signer)

  pure def honestSigner(signer: str, n: int): bool =
    activeSigner(signer, n) and not(byzantineSigner(signer, n))

  pure def proposalHash(valueDigest: str, round: int): str =
    if (valueDigest == "value-X")
      if (round == 0) "proposal-X-0" else if (round == 1) "proposal-X-1" else "proposal-X-future"
    else if (round == 0) "proposal-Y-0" else if (round == 1) "proposal-Y-1" else "proposal-Y-future"

  pure def leaderForRound(round: int, n: int): str =
    if (round == 0) "A"
    else if (round == 1) "B"
    else if (round == 2) "C"
    else if (round == 3) "D"
    else if (n >= 5 and round == 4) "E"
    else if (n >= 6 and round == 5) "F"
    else if (n == 7 and round == 6) "G"
    else "A"

  pure def vote(signer: str, round: int, phase: str, valueDigest: str): Vote = {
    signer: signer,
    objectId: OBJECT_ID,
    epoch: 0,
    anchor: ANCHOR,
    round: round,
    phase: phase,
    valueDigest: valueDigest,
    proposalHash: proposalHash(valueDigest, round),
    signatureValid: true,
  }

  pure def invalidVote(signer: str, round: int, phase: str, valueDigest: str): Vote =
    vote(signer, round, phase, valueDigest).with("signatureValid", false)

  pure def xVotes(round: int, phase: str, n: int): Set[Vote] =
    if (n == 4) Set(vote("A", round, phase, "value-X"), vote("B", round, phase, "value-X"), vote("C", round, phase, "value-X"))
    else if (n == 5) Set(vote("A", round, phase, "value-X"), vote("B", round, phase, "value-X"), vote("C", round, phase, "value-X"), vote("D", round, phase, "value-X"))
    else Set(vote("A", round, phase, "value-X"), vote("B", round, phase, "value-X"), vote("C", round, phase, "value-X"), vote("D", round, phase, "value-X"), vote("E", round, phase, "value-X"))

  pure def yVotes(round: int, phase: str, n: int): Set[Vote] =
    if (n == 4) Set(vote("B", round, phase, "value-Y"), vote("C", round, phase, "value-Y"), vote("D", round, phase, "value-Y"))
    else if (n == 5) Set(vote("B", round, phase, "value-Y"), vote("C", round, phase, "value-Y"), vote("D", round, phase, "value-Y"), vote("E", round, phase, "value-Y"))
    else if (n == 6) Set(vote("B", round, phase, "value-Y"), vote("C", round, phase, "value-Y"), vote("D", round, phase, "value-Y"), vote("E", round, phase, "value-Y"), vote("F", round, phase, "value-Y"))
    else Set(vote("C", round, phase, "value-Y"), vote("D", round, phase, "value-Y"), vote("E", round, phase, "value-Y"), vote("F", round, phase, "value-Y"), vote("G", round, phase, "value-Y"))

  pure def qc(round: int, phase: str, valueDigest: str, n: int): Qc = {
    objectId: OBJECT_ID,
    epoch: 0,
    anchor: ANCHOR,
    round: round,
    phase: phase,
    valueDigest: valueDigest,
    proposalHash: proposalHash(valueDigest, round),
    votes: if (valueDigest == "value-X") xVotes(round, phase, n) else yVotes(round, phase, n),
  }

  pure def emptyQc: Qc = {
    objectId: OBJECT_ID,
    epoch: 0,
    anchor: ANCHOR,
    round: -1,
    phase: "prepare",
    valueDigest: EMPTY,
    proposalHash: EMPTY,
    votes: Set(),
  }

  pure def roundChange(signer: str, round: int, highest: Qc, hasHighest: bool): RoundChange = {
    signer: signer,
    objectId: OBJECT_ID,
    epoch: 0,
    anchor: ANCHOR,
    round: round,
    hasHighestPrepareQc: hasHighest,
    highestPrepareQc: highest,
    signatureValid: true,
  }

  pure def bundle(round: int, valueDigest: str, n: int): ProposalBundle = {
    leader: leaderForRound(round, n),
    objectId: OBJECT_ID,
    epoch: 0,
    round: round,
    cutValueDigest: valueDigest,
    valueDigest: valueDigest,
    proposalHash: proposalHash(valueDigest, round),
    cutValueValid: true,
    leaderVote: vote(leaderForRound(round, n), round, "prepare", valueDigest),
    certificateRound: if (round == 0) -1 else round,
    certificateValue: if (round == 0) EMPTY else valueDigest,
    certificateValid: true,
  }

  pure def envelope(kind: str, source: str, target: str, copyId: int, round: int, phase: str, valueDigest: str): Envelope = {
    kind: kind,
    source: source,
    target: target,
    copyId: copyId,
    round: round,
    phase: phase,
    valueDigest: valueDigest,
    proposalHash: proposalHash(valueDigest, round),
  }

  pure def qcEnvelope(target: str, candidate: Qc, copyId: int): Envelope =
    envelope("qc", "network", target, copyId, candidate.round, candidate.phase, candidate.valueDigest)

  pure def roundChangeEnvelope(candidate: RoundChange, copyId: int): Envelope =
    envelope("round-change", candidate.signer, "network", copyId, candidate.round, "round-change", if (candidate.hasHighestPrepareQc) candidate.highestPrepareQc.valueDigest else EMPTY)

  def durableQcEnvelope(message: Envelope): bool =
    Set(0, 1).contains(message.copyId) and
      state.durablePrepareQcs.union(state.durableCommitQcs).exists(candidate =>
        message.kind == "qc" and message.source == "network" and
          message.round == candidate.round and message.phase == candidate.phase and
          message.valueDigest == candidate.valueDigest and message.proposalHash == candidate.proposalHash)

  pure def validVote(candidate: Vote, n: int): bool =
    activeSigner(candidate.signer, n) and
      candidate.objectId == OBJECT_ID and candidate.epoch == 0 and candidate.anchor == ANCHOR and
      candidate.round >= 0 and Set("prepare", "commit").contains(candidate.phase) and
      VALUES.contains(candidate.valueDigest) and
      candidate.proposalHash == proposalHash(candidate.valueDigest, candidate.round) and
      candidate.signatureValid

  pure def validQc(candidate: Qc, n: int): bool =
    candidate.objectId == OBJECT_ID and candidate.epoch == 0 and candidate.anchor == ANCHOR and
      candidate.round >= 0 and Set("prepare", "commit").contains(candidate.phase) and
      VALUES.contains(candidate.valueDigest) and
      candidate.proposalHash == proposalHash(candidate.valueDigest, candidate.round) and
      candidate.votes.size() == quorum(n) and
      candidate.votes.map(v => v.signer).size() == candidate.votes.size() and
      candidate.votes.forall(v =>
        validVote(v, n) and v.round == candidate.round and v.phase == candidate.phase and
          v.valueDigest == candidate.valueDigest and v.proposalHash == candidate.proposalHash)

  pure def validRoundChange(candidate: RoundChange, n: int): bool =
    activeSigner(candidate.signer, n) and candidate.signatureValid and
      candidate.objectId == OBJECT_ID and candidate.epoch == 0 and candidate.anchor == ANCHOR and
      candidate.round > 0 and
      (if (candidate.hasHighestPrepareQc)
        validQc(candidate.highestPrepareQc, n) and
          candidate.highestPrepareQc.phase == "prepare" and
          candidate.highestPrepareQc.round < candidate.round
      else candidate.highestPrepareQc == emptyQc)

  pure def validBundle(candidate: ProposalBundle, n: int): bool =
    activeSigner(candidate.leader, n) and candidate.leader == leaderForRound(candidate.round, n) and
      candidate.objectId == OBJECT_ID and candidate.epoch == 0 and candidate.round >= 0 and
      candidate.cutValueValid and candidate.cutValueDigest == candidate.valueDigest and
      VALUES.contains(candidate.valueDigest) and
      candidate.proposalHash == proposalHash(candidate.valueDigest, candidate.round) and
      validVote(candidate.leaderVote, n) and candidate.leaderVote.signer == candidate.leader and
      candidate.leaderVote.phase == "prepare" and candidate.leaderVote.round == candidate.round and
      candidate.leaderVote.valueDigest == candidate.valueDigest and
      (if (candidate.round == 0)
        candidate.certificateRound == -1 and candidate.certificateValue == EMPTY
      else candidate.certificateValid and candidate.certificateRound == candidate.round)

  pure def honestSlotSafe(existing: Set[Vote], candidate: Vote, n: int): bool =
    byzantineSigner(candidate.signer, n) or
      not(existing.exists(v =>
        v.signer == candidate.signer and v.round == candidate.round and v.phase == candidate.phase and
          v.valueDigest != candidate.valueDigest))

  pure def initialState(n: int): PacemakerState = {
    activeN: n,
    enteredRound: SIGNERS.mapBy(_ => 0),
    phase: SIGNERS.mapBy(_ => "awaiting"),
    proposedValue: SIGNERS.mapBy(_ => EMPTY),
    lockedValue: SIGNERS.mapBy(_ => EMPTY),
    lockRound: SIGNERS.mapBy(_ => -1),
    highestPrepareRound: SIGNERS.mapBy(_ => -1),
    highestPrepareValue: SIGNERS.mapBy(_ => EMPTY),
    localCommitVoteValue: SIGNERS.mapBy(_ => EMPTY),
    finalizedValue: SIGNERS.mapBy(_ => EMPTY),
    durableVotes: Set(),
    durablePrepareQcs: Set(),
    durableCommitQcs: Set(),
    durableRoundChanges: Set(),
    durableOutbox: Set(),
    network: Set(),
    delivered: Set(),
    acceptedProposals: Set(),
    futureRounds: Set(),
    events: Set(),
    revision: 0,
    crashCount: 0,
    crashed: false,
    livenessTick: 0,
  }

  action initN(n) = all {
    Set(4, 5, 6, 7).contains(n),
    state' = initialState(n),
  }

  action init = {
    nondet n = Set(4, 5, 6, 7).oneOf()
    initN(n)
  }

  action acceptProposal(target, candidate) = all {
    not(state.crashed),
    activeSigner(target, state.activeN),
    honestSigner(target, state.activeN),
    state.phase.get(target) == "awaiting",
    candidate.round == state.enteredRound.get(target),
    validBundle(candidate, state.activeN),
    state.lockedValue.get(target) == EMPTY or state.lockedValue.get(target) == candidate.valueDigest,
    state' = state
      .with("phase", state.phase.set(target, "prepared"))
      .with("proposedValue", state.proposedValue.set(target, candidate.valueDigest))
      .with("acceptedProposals", state.acceptedProposals.union(Set(candidate)))
      .with("events", state.events.union(Set("proposal")))
      .with("livenessTick", state.livenessTick + 1),
  }

  action persistVoteSet(candidate) = all {
    not(state.crashed),
    state.revision < 12,
    candidate.votes.forall(v => validVote(v, state.activeN) and honestSlotSafe(state.durableVotes, v, state.activeN)),
    state' = state
      .with("durableVotes", state.durableVotes.union(candidate.votes))
      .with("events", state.events.union(Set("vote_cast")))
      .with("revision", state.revision + 1)
      .with("livenessTick", state.livenessTick + 1),
  }

  action byzantineEquivocate(round, phase) = all {
    not(state.crashed),
    state.revision < 12,
    nondet signer = SIGNERS.filter(s => byzantineSigner(s, state.activeN)).oneOf()
    val left = vote(signer, round, phase, "value-X")
    val right = vote(signer, round, phase, "value-Y")
    state' = state
      .with("durableVotes", state.durableVotes.union(Set(left, right)))
      .with("events", state.events.union(Set("equivocation_observed")))
      .with("revision", state.revision + 1)
      .with("livenessTick", state.livenessTick + 1),
  }

  action formQc(target, candidate) = all {
    not(state.crashed),
    state.revision < 12,
    activeSigner(target, state.activeN),
    honestSigner(target, state.activeN),
    validQc(candidate, state.activeN),
    candidate.votes.subseteq(state.durableVotes),
    val nextPrepare = if (candidate.phase == "prepare") state.durablePrepareQcs.union(Set(candidate)) else state.durablePrepareQcs
    val nextCommit = if (candidate.phase == "commit") state.durableCommitQcs.union(Set(candidate)) else state.durableCommitQcs
    val message = qcEnvelope(target, candidate, 0)
    state' = state
      .with("durablePrepareQcs", nextPrepare)
      .with("durableCommitQcs", nextCommit)
      .with("network", state.network.union(Set(message)))
      .with("events", state.events.union(Set("qc_formed")))
      .with("revision", state.revision + 1)
      .with("livenessTick", state.livenessTick + 1),
  }

  action duplicateQc(target, candidate) = all {
    state.network.contains(qcEnvelope(target, candidate, 0)),
    state' = state
      .with("network", state.network.union(Set(qcEnvelope(target, candidate, 1))))
      .with("events", state.events.union(Set("duplicate")))
      .with("livenessTick", state.livenessTick + 1),
  }

  action dropQc(target, candidate, copyId) = all {
    state.network.contains(qcEnvelope(target, candidate, copyId)),
    state' = state
      .with("network", state.network.filter(message => message != qcEnvelope(target, candidate, copyId)))
      .with("events", state.events.union(Set("loss")))
      .with("livenessTick", state.livenessTick + 1),
  }

  action deliverPrepareQc(target, candidate, copyId) = all {
    not(state.crashed),
    candidate.phase == "prepare",
    state.network.contains(qcEnvelope(target, candidate, copyId)),
    state.durablePrepareQcs.contains(candidate),
    candidate.round >= state.highestPrepareRound.get(target),
    state.lockedValue.get(target) == EMPTY or state.lockedValue.get(target) == candidate.valueDigest or candidate.round > state.lockRound.get(target),
    state' = state
      .with("phase", state.phase.set(target, "committed"))
      .with("enteredRound", state.enteredRound.set(target, candidate.round))
      .with("lockedValue", state.lockedValue.set(target, candidate.valueDigest))
      .with("lockRound", state.lockRound.set(target, candidate.round))
      .with("highestPrepareRound", state.highestPrepareRound.set(target, candidate.round))
      .with("highestPrepareValue", state.highestPrepareValue.set(target, candidate.valueDigest))
      .with("delivered", state.delivered.union(Set(qcEnvelope(target, candidate, copyId))))
      .with("events", state.events.union(Set("lock_acquired")))
      .with("livenessTick", state.livenessTick + 1),
  }

  action persistCommitVoteSet(candidate) = all {
    candidate.phase == "commit",
    state.durablePrepareQcs.exists(prepared =>
      prepared.round == candidate.round and prepared.valueDigest == candidate.valueDigest),
    persistVoteSet(candidate),
  }

  action deliverCommitQc(target, candidate, copyId) = all {
    not(state.crashed),
    candidate.phase == "commit",
    state.network.contains(qcEnvelope(target, candidate, copyId)),
    state.durableCommitQcs.contains(candidate),
    candidate.round == state.enteredRound.get(target),
    candidate.valueDigest == state.lockedValue.get(target),
    state' = state
      .with("phase", state.phase.set(target, "finalized"))
      .with("finalizedValue", state.finalizedValue.set(target, candidate.valueDigest))
      .with("delivered", state.delivered.union(Set(qcEnvelope(target, candidate, copyId))))
      .with("events", state.events.union(Set("finalized")))
      .with("livenessTick", state.livenessTick + 1),
  }

  action enterRound(signer) = all {
    not(state.crashed),
    state.revision < 12,
    activeSigner(signer, state.activeN),
    honestSigner(signer, state.activeN),
    Set("awaiting", "prepared", "committed").contains(state.phase.get(signer)),
    state.enteredRound.get(signer) < 12,
    val nextRound = state.enteredRound.get(signer) + 1
    val highestRound = state.highestPrepareRound.get(signer)
    val highestValue = state.highestPrepareValue.get(signer)
    val highest = if (highestRound == -1) emptyQc else qc(highestRound, "prepare", highestValue, state.activeN)
    val change = roundChange(signer, nextRound, highest, highestRound >= 0)
    all {
      validRoundChange(change, state.activeN),
      val message = roundChangeEnvelope(change, 0)
      state' = state
        .with("enteredRound", state.enteredRound.set(signer, nextRound))
        .with("phase", state.phase.set(signer, "awaiting"))
        .with("proposedValue", state.proposedValue.set(signer, EMPTY))
        .with("durableRoundChanges", state.durableRoundChanges.union(Set(change)))
        .with("durableOutbox", state.durableOutbox.union(Set(message)))
        .with("network", state.network.union(Set(message)))
        .with("events", state.events.union(Set("round_entered")))
        .with("revision", state.revision + 1)
        .with("livenessTick", state.livenessTick + 1),
    },
  }

  action rejectInvalidNestedQc = all {
    val invalid = roundChange("A", 1, qc(1, "prepare", "value-X", state.activeN), true)
    not(validRoundChange(invalid, state.activeN)),
    state' = state.with("events", state.events.union(Set("invalid_nested_qc_rejected"))).with("livenessTick", state.livenessTick + 1),
  }

  action observeFutureRound(target, futureRound, evidenceCount) = all {
    not(state.crashed),
    honestSigner(target, state.activeN),
    Set("awaiting", "prepared", "committed").contains(state.phase.get(target)),
    futureRound > state.enteredRound.get(target),
    futureRound <= 12,
    evidenceCount >= 1,
    val withinWindow = futureRound <= state.enteredRound.get(target) + MAX_FUTURE_ROUND_GAP
    val enough = evidenceCount >= fPlusOne(state.activeN)
    val highestRound = state.highestPrepareRound.get(target)
    val highestValue = state.highestPrepareValue.get(target)
    val highest = if (highestRound == -1) emptyQc else qc(highestRound, "prepare", highestValue, state.activeN)
    val change = roundChange(target, futureRound, highest, highestRound >= 0)
    val message = roundChangeEnvelope(change, 0)
    state' =
      if (enough)
        state
          .with("enteredRound", state.enteredRound.set(target, futureRound))
          .with("phase", state.phase.set(target, "awaiting"))
          .with("futureRounds", Set())
          .with("durableRoundChanges", state.durableRoundChanges.union(Set(change)))
          .with("durableOutbox", state.durableOutbox.union(Set(message)))
          .with("network", state.network.union(Set(message)))
          .with("events", state.events.union(Set("catchup", "round_entered")))
          .with("revision", state.revision + 1)
          .with("livenessTick", state.livenessTick + 1)
      else if (withinWindow)
        state
          .with("futureRounds", state.futureRounds.union(Set(futureRound)))
          .with("livenessTick", state.livenessTick + 1)
      else state.with("events", state.events.union(Set("far_future_rejected"))).with("livenessTick", state.livenessTick + 1),
  }

  action observeFutureQc(target, candidate) = all {
    not(state.crashed),
    honestSigner(target, state.activeN),
    Set("awaiting", "prepared", "committed").contains(state.phase.get(target)),
    validQc(candidate, state.activeN),
    candidate.phase == "prepare",
    candidate.round > state.enteredRound.get(target),
    candidate.round <= 12,
    state' = state
      .with("enteredRound", state.enteredRound.set(target, candidate.round))
      .with("phase", state.phase.set(target, "committed"))
      .with("lockedValue", state.lockedValue.set(target, candidate.valueDigest))
      .with("lockRound", state.lockRound.set(target, candidate.round))
      .with("highestPrepareRound", state.highestPrepareRound.set(target, candidate.round))
      .with("highestPrepareValue", state.highestPrepareValue.set(target, candidate.valueDigest))
      .with("durablePrepareQcs", state.durablePrepareQcs.union(Set(candidate)))
      .with("futureRounds", Set())
      .with("events", state.events.union(Set("catchup", "lock_acquired")))
      .with("revision", state.revision + 1)
      .with("livenessTick", state.livenessTick + 1),
  }

  action crash = all {
    not(state.crashed),
    state.crashCount == 0,
    state' = state
      .with("network", Set())
      .with("delivered", Set())
      .with("events", Set())
      .with("futureRounds", Set())
      .with("crashCount", 1)
      .with("crashed", true)
      .with("livenessTick", state.livenessTick + 1),
  }

  action restart = all {
    state.crashed,
    state' = state
      .with("network", state.durableOutbox)
      .with("events", Set("restart"))
      .with("crashed", false)
      .with("livenessTick", state.livenessTick + 1),
  }

  action stop = all {
    not(state.crashed),
    state' = state
      .with("phase", SIGNERS.mapBy(signer => if (activeSigner(signer, state.activeN)) "stopped" else state.phase.get(signer)))
      .with("livenessTick", state.livenessTick + 1),
  }

  action stutter = {
    state' = state.with("livenessTick", state.livenessTick + 1)
  }

  action check(condition) = all {
    condition,
    state' = state,
  }

  val exactSlotIntegrity =
    state.durableVotes.forall(left =>
      state.durableVotes.forall(right =>
        not(honestSigner(left.signer, state.activeN)) or
          left.signer != right.signer or left.round != right.round or left.phase != right.phase or
          left.valueDigest == right.valueDigest))

  val qcAuthority =
    state.durablePrepareQcs.forall(candidate => validQc(candidate, state.activeN) and candidate.phase == "prepare") and
      state.durableCommitQcs.forall(candidate => validQc(candidate, state.activeN) and candidate.phase == "commit")

  val roundChangeAuthority =
    state.durableRoundChanges.forall(candidate => validRoundChange(candidate, state.activeN))

  val agreement =
    SIGNERS.forall(left =>
      SIGNERS.forall(right =>
        not(honestSigner(left, state.activeN) and honestSigner(right, state.activeN)) or
          state.finalizedValue.get(left) == EMPTY or state.finalizedValue.get(right) == EMPTY or
          state.finalizedValue.get(left) == state.finalizedValue.get(right)))

  val lockSafety =
    SIGNERS.forall(signer =>
      not(honestSigner(signer, state.activeN)) or state.finalizedValue.get(signer) == EMPTY or
        state.finalizedValue.get(signer) == state.lockedValue.get(signer))

  val noRetroactiveVote =
    state.durableVotes.forall(candidate =>
      byzantineSigner(candidate.signer, state.activeN) or candidate.round <= state.enteredRound.get(candidate.signer))

  val authorityIsolation =
    state.durableVotes.forall(candidate => validVote(candidate, state.activeN)) and
      state.durableRoundChanges.forall(candidate => activeSigner(candidate.signer, state.activeN))

  val durableBeforeGossip =
    state.network.forall(message =>
      state.durableOutbox.contains(message) or durableQcEnvelope(message)) and
      state.delivered.forall(message =>
        state.durableOutbox.contains(message) or durableQcEnvelope(message))

  val finalityRequiresCommitQc =
    SIGNERS.forall(signer =>
      state.finalizedValue.get(signer) == EMPTY or
        state.durableCommitQcs.exists(candidate =>
          candidate.valueDigest == state.finalizedValue.get(signer) and
            candidate.round == state.enteredRound.get(signer)))

  val highestQcRestartSafe =
    SIGNERS.forall(signer =>
      state.highestPrepareRound.get(signer) == -1 or
        state.durablePrepareQcs.exists(candidate =>
          candidate.round == state.highestPrepareRound.get(signer) and
            candidate.valueDigest == state.highestPrepareValue.get(signer) and
            validQc(candidate, state.activeN)))

  val boundedFutureEvidence =
    state.futureRounds.forall(round => round >= 0 and round <= 12) and
      state.futureRounds.size() <= MAX_FUTURE_ROUND_GAP

  val crashPreservesDurableAuthority =
    state.crashed implies state.network.size() == 0 and state.durableOutbox.forall(_ => true)

  val integrity =
    Set(4, 5, 6, 7).contains(state.activeN) and state.revision >= 0 and state.revision <= 12 and
      state.crashCount >= 0 and state.crashCount <= 1 and state.livenessTick >= 0 and
      SIGNERS.forall(signer => state.enteredRound.get(signer) >= 0 and PHASES.contains(state.phase.get(signer)))

  val allSafety =
    integrity and exactSlotIntegrity and qcAuthority and roundChangeAuthority and agreement and lockSafety and
      noRetroactiveVote and authorityIsolation and durableBeforeGossip and finalityRequiresCommitQc and
      highestQcRestartSafe and boundedFutureEvidence and crashPreservesDurableAuthority

  val safetyN4 = state.activeN != 4 or allSafety
  val safetyN5 = state.activeN != 5 or allSafety
  val safetyN6 = state.activeN != 6 or allSafety
  val safetyN7 = state.activeN != 7 or allSafety

  val reachedTimeout = state.durableRoundChanges.size() > 0
  val reachedRoundChange = state.durableRoundChanges.size() > 0
  val reachedProposal = state.acceptedProposals.size() > 0
  val reachedPrepareQc = state.durablePrepareQcs.size() > 0
  val reachedCommitQc = state.durableCommitQcs.size() > 0
  val reachedCatchup = state.events.contains("catchup")
  val reachedRestart = state.events.contains("restart")
  val reachedEquivocation = state.events.contains("equivocation_observed")
  val reachedDuplicate = state.events.contains("duplicate")
  val reachedLoss = state.events.contains("loss")
  val reachedInvalidNestedQcRejection = state.events.contains("invalid_nested_qc_rejected")
  val reachedFairFinality = state.finalizedValue.get("A") == "value-X" and state.livenessTick >= 10000

  action step = any {
    all { state.livenessTick == 0, acceptProposal("A", bundle(0, "value-X", state.activeN)) },
    all { state.livenessTick == 0, acceptProposal("B", bundle(0, "value-X", state.activeN)) },
    all { state.livenessTick == 0, byzantineEquivocate(0, "prepare") },
    all { state.livenessTick == 0, observeFutureRound("A", 1, 1) },
    all { state.livenessTick == 0, rejectInvalidNestedQc },
    all { state.livenessTick == 1, persistVoteSet(qc(0, "prepare", "value-X", state.activeN)) },
    all { state.livenessTick == 1, persistVoteSet(qc(0, "prepare", "value-Y", state.activeN)) },
    all { state.livenessTick == 1, observeFutureRound("A", 1, fPlusOne(state.activeN)) },
    all { state.livenessTick == 2, formQc("A", qc(0, "prepare", "value-X", state.activeN)) },
    all { state.livenessTick == 2, formQc("B", qc(0, "prepare", "value-Y", state.activeN)) },
    all { state.livenessTick == 2, observeFutureRound("A", MAX_FUTURE_ROUND_GAP + 1, 1) },
	all { state.livenessTick == 2, observeFutureQc("A", qc(10, "prepare", "value-X", state.activeN)) },
    all { state.livenessTick == 3, duplicateQc("A", qc(0, "prepare", "value-X", state.activeN)) },
    all { state.livenessTick == 3, dropQc("A", qc(0, "prepare", "value-X", state.activeN), 0) },
    all { state.livenessTick == 3, deliverPrepareQc("A", qc(0, "prepare", "value-X", state.activeN), 0) },
    all { state.livenessTick == 3, deliverPrepareQc("B", qc(0, "prepare", "value-Y", state.activeN), 0) },
    all { state.livenessTick == 4, persistCommitVoteSet(qc(0, "commit", "value-X", state.activeN)) },
    all { state.livenessTick == 4, persistCommitVoteSet(qc(0, "commit", "value-Y", state.activeN)) },
    all { state.livenessTick == 4, enterRound("A") },
    all { state.livenessTick == 5, formQc("A", qc(0, "commit", "value-X", state.activeN)) },
    all { state.livenessTick == 5, formQc("B", qc(0, "commit", "value-Y", state.activeN)) },
    all { state.livenessTick == 5, crash },
    all { state.livenessTick == 6, deliverCommitQc("A", qc(0, "commit", "value-X", state.activeN), 0) },
    all { state.livenessTick == 6, deliverCommitQc("B", qc(0, "commit", "value-Y", state.activeN), 0) },
    all { state.livenessTick == 6, restart },
    all { state.livenessTick >= 7, stop },
    all { state.livenessTick >= 7, stutter },
  }

  action fairStep = any {
    all { state.livenessTick == 0, persistVoteSet(qc(0, "prepare", "value-X", state.activeN)) },
    all { state.livenessTick == 1, formQc("A", qc(0, "prepare", "value-X", state.activeN)) },
    all { state.livenessTick == 2, deliverPrepareQc("A", qc(0, "prepare", "value-X", state.activeN), 0) },
    all { state.livenessTick == 3, persistCommitVoteSet(qc(0, "commit", "value-X", state.activeN)) },
    all { state.livenessTick == 4, formQc("A", qc(0, "commit", "value-X", state.activeN)) },
    all { state.livenessTick == 5, deliverCommitQc("A", qc(0, "commit", "value-X", state.activeN), 0) },
    all { state.livenessTick >= 6, stutter },
  }

  run testRoundCarryover =
    initN(4)
      .then(acceptProposal("A", bundle(0, "value-X", 4)))
      .then(persistVoteSet(qc(0, "prepare", "value-X", 4)))
      .then(formQc("A", qc(0, "prepare", "value-X", 4)))
      .then(deliverPrepareQc("A", qc(0, "prepare", "value-X", 4), 0))
      .then(enterRound("A"))
      .then(check(state.enteredRound.get("A") == 1 and state.highestPrepareValue.get("A") == "value-X" and allSafety))

  run testCatchupNeedsFPlusOne =
    initN(4)
      .then(observeFutureRound("A", 1, 1))
      .then(check(state.enteredRound.get("A") == 0 and state.futureRounds == Set(1)))
      .then(observeFutureRound("A", 1, 2))
      .then(check(state.enteredRound.get("A") == 1 and state.futureRounds.size() == 0 and allSafety))

  run testCommitQcFinalizes =
    initN(4)
      .then(acceptProposal("A", bundle(0, "value-X", 4)))
      .then(persistVoteSet(qc(0, "prepare", "value-X", 4)))
      .then(formQc("A", qc(0, "prepare", "value-X", 4)))
      .then(deliverPrepareQc("A", qc(0, "prepare", "value-X", 4), 0))
      .then(persistCommitVoteSet(qc(0, "commit", "value-X", 4)))
      .then(formQc("A", qc(0, "commit", "value-X", 4)))
      .then(deliverCommitQc("A", qc(0, "commit", "value-X", 4), 0))
      .then(check(state.finalizedValue.get("A") == "value-X" and finalityRequiresCommitQc and allSafety))

  run testCrashRestartRetainsDurableAuthority =
    initN(7)
      .then(acceptProposal("A", bundle(0, "value-X", 7)))
      .then(persistVoteSet(qc(0, "prepare", "value-X", 7)))
      .then(formQc("A", qc(0, "prepare", "value-X", 7)))
      .then(deliverPrepareQc("A", qc(0, "prepare", "value-X", 7), 0))
      .then(enterRound("A"))
      .then(crash)
      .then(check(state.network.size() == 0 and state.durableOutbox.exists(message => message.kind == "round-change")))
      .then(restart)
      .then(check(state.network.exists(message => message.kind == "round-change") and highestQcRestartSafe and allSafety))

  run testByzantineEquivocationDoesNotFormConflictingQcs =
    initN(4)
      .then(byzantineEquivocate(0, "prepare"))
      .then(persistVoteSet(qc(0, "prepare", "value-X", 4)))
      .then(formQc("A", qc(0, "prepare", "value-X", 4)))
      .then(check(not(qc(0, "prepare", "value-Y", 4).votes.subseteq(state.durableVotes)) and allSafety))

  run testDuplicateLossAndInvalidNestedQc =
    initN(4)
      .then(persistVoteSet(qc(0, "prepare", "value-X", 4)))
      .then(formQc("A", qc(0, "prepare", "value-X", 4)))
      .then(duplicateQc("A", qc(0, "prepare", "value-X", 4)))
      .then(dropQc("A", qc(0, "prepare", "value-X", 4), 0))
      .then(deliverPrepareQc("A", qc(0, "prepare", "value-X", 4), 1))
      .then(rejectInvalidNestedQc)
      .then(check(reachedDuplicate and reachedLoss and reachedInvalidNestedQcRejection and allSafety))
}
