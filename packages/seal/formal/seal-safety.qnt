module sealSafety {
  pure val HONEST = Set("A", "B", "C")
  pure val ALL = HONEST.union(Set("Z"))
  pure val VALUES = Set("value-X", "value-Y")
  pure val QUORUM = 3
  pure val EMPTY_VALUE = ""

  type Vote = {
    signer: str,
    round: int,
    phase: str,
    valueDigest: str,
    proposalHash: str,
  }

  type ModelState = {
    enteredRound: str -> int,
    lockedValueDigest: str -> str,
    lockRound: str -> int,
    highestPrepareRound: str -> int,
    committedValueDigest: str -> str,
    slots: Set[Vote],
    outbox: Set[Vote],
    volatileMessages: Set[Vote],
    delivered: Set[Vote],
    revision: int,
    crashed: bool,
  }

  var state: ModelState

  pure def proposalHash(valueDigest: str, round: int): str =
    if (valueDigest == "value-X")
      if (round == 0) "proposal-X-round-0" else "proposal-X-round-1"
    else if (round == 0) "proposal-Y-round-0" else "proposal-Y-round-1"

  pure def vote(signer: str, round: int, phase: str, valueDigest: str): Vote = {
    signer: signer,
    round: round,
    phase: phase,
    valueDigest: valueDigest,
    proposalHash: proposalHash(valueDigest, round),
  }

  pure def sameSlot(left: Vote, right: Vote): bool =
    left.signer == right.signer and
      left.round == right.round and
      left.phase == right.phase

  pure def validTuple(candidate: Vote): bool =
    ALL.contains(candidate.signer) and
      VALUES.contains(candidate.valueDigest) and
      Set("prepare", "commit").contains(candidate.phase) and
      candidate.round >= 0 and
      candidate.proposalHash == proposalHash(candidate.valueDigest, candidate.round)

  def canPersist(candidate: Vote): bool =
    validTuple(candidate) and
      candidate.round >= state.enteredRound.get(candidate.signer) and
      not(state.slots.exists(existing => sameSlot(existing, candidate))) and
      (if (candidate.phase == "prepare")
        state.lockedValueDigest.get(candidate.signer) == EMPTY_VALUE or
          state.lockedValueDigest.get(candidate.signer) == candidate.valueDigest
      else
        state.lockedValueDigest.get(candidate.signer) == candidate.valueDigest and
          state.highestPrepareRound.get(candidate.signer) <= candidate.round)

  action init = {
    state' = {
      enteredRound: ALL.mapBy(_ => 0),
      lockedValueDigest: ALL.mapBy(_ => EMPTY_VALUE),
      lockRound: ALL.mapBy(_ => 0),
      highestPrepareRound: ALL.mapBy(_ => 0),
      committedValueDigest: ALL.mapBy(_ => EMPTY_VALUE),
      slots: Set(),
      outbox: Set(),
      volatileMessages: Set(),
      delivered: Set(),
      revision: 0,
      crashed: false,
    }
  }

  action enterRound(signer, round) = all {
    ALL.contains(signer),
    round >= state.enteredRound.get(signer),
    state' = state
      .with("enteredRound", state.enteredRound.set(signer, round))
      .with("revision", state.revision + 1),
  }

  action persist(candidate) = all {
    not(state.crashed),
    canPersist(candidate),
    val nextLockedValue =
      if (candidate.phase == "prepare")
        state.lockedValueDigest.set(candidate.signer, candidate.valueDigest)
      else state.lockedValueDigest
    val nextLockRound =
      if (candidate.phase == "prepare")
        state.lockRound.set(candidate.signer, candidate.round)
      else state.lockRound
    val nextHighestPrepare =
      if (candidate.phase == "prepare")
        state.highestPrepareRound.set(candidate.signer, candidate.round)
      else state.highestPrepareRound
    val nextCommitted =
      if (candidate.phase == "commit")
        state.committedValueDigest.set(candidate.signer, candidate.valueDigest)
      else state.committedValueDigest
    state' = state
      .with("lockedValueDigest", nextLockedValue)
      .with("lockRound", nextLockRound)
      .with("highestPrepareRound", nextHighestPrepare)
      .with("committedValueDigest", nextCommitted)
      .with("slots", state.slots.union(Set(candidate)))
      .with("outbox", state.outbox.union(Set(candidate)))
      .with("volatileMessages", state.volatileMessages.union(Set(candidate)))
      .with("revision", state.revision + 1),
  }

  action deliver(candidate) = all {
    not(state.crashed),
    state.outbox.contains(candidate),
    state.volatileMessages.contains(candidate),
    state' = state.with("delivered", state.delivered.union(Set(candidate))),
  }

  action crash = {
    state' = state.with("volatileMessages", Set()).with("crashed", true)
  }

  action restart = all {
    state.crashed,
    state' = state.with("volatileMessages", state.outbox).with("crashed", false),
  }

  action check(condition) = all {
    condition,
    state' = state,
  }

  val exactSlotIntegrity =
    state.slots.forall(left =>
      state.slots.forall(right => not(sameSlot(left, right)) or left == right))

  val roundMonotonicity =
    ALL.forall(signer =>
      state.enteredRound.get(signer) >= state.lockRound.get(signer) and
        state.highestPrepareRound.get(signer) >= state.lockRound.get(signer))

  val lockSafety =
    ALL.forall(signer =>
      state.committedValueDigest.get(signer) == EMPTY_VALUE or
        state.committedValueDigest.get(signer) == state.lockedValueDigest.get(signer))

  val qcTupleAuthorityIsolation = state.slots.forall(validTuple)

  val durableBeforeGossip =
    state.delivered.forall(candidate =>
      state.outbox.contains(candidate) and state.slots.contains(candidate))

  val crashPreservesDurableState =
    state.outbox == state.slots and
      ALL.forall(signer =>
        state.lockedValueDigest.get(signer) == EMPTY_VALUE or state.lockRound.get(signer) >= 0)

  val agreement =
    VALUES
      .filter(valueDigest =>
        ALL.filter(signer => state.committedValueDigest.get(signer) == valueDigest).size() >= QUORUM)
      .size() <= 1

  val allSafety =
    exactSlotIntegrity and
      roundMonotonicity and
      lockSafety and
      qcTupleAuthorityIsolation and
      durableBeforeGossip and
      crashPreservesDurableState and
      agreement

  run testAgreement =
    init
      .then(persist(vote("A", 0, "prepare", "value-X")))
      .then(persist(vote("B", 0, "prepare", "value-X")))
      .then(persist(vote("C", 0, "prepare", "value-X")))
      .then(persist(vote("A", 0, "commit", "value-X")))
      .then(persist(vote("B", 0, "commit", "value-X")))
      .then(enterRound("A", 1))
      .then(enterRound("B", 1))
      .then(enterRound("C", 1))
      .then(persist(vote("A", 1, "prepare", "value-X")))
      .then(persist(vote("B", 1, "prepare", "value-X")))
      .then(persist(vote("C", 1, "prepare", "value-X")))
      .then(persist(vote("A", 1, "commit", "value-X")))
      .then(persist(vote("B", 1, "commit", "value-X")))
      .then(persist(vote("C", 1, "commit", "value-X")))
      .then(enterRound("Z", 1))
      .then(persist(vote("Z", 1, "prepare", "value-Y")))
      .then(persist(vote("Z", 1, "commit", "value-Y")))
      .then(check(allSafety))

  run testSameValueRoundCarryover =
    init
      .then(persist(vote("A", 0, "prepare", "value-X")))
      .then(enterRound("A", 1))
      .then(persist(vote("A", 1, "prepare", "value-X")))
      .then(check(
        proposalHash("value-X", 0) != proposalHash("value-X", 1) and
          state.lockedValueDigest.get("A") == "value-X" and
          allSafety))

  run testDurableBeforeGossip =
    init
      .then(persist(vote("A", 0, "prepare", "value-X")))
      .then(check(state.delivered.size() == 0 and state.outbox.size() == 1 and allSafety))
      .then(deliver(vote("A", 0, "prepare", "value-X")))
      .then(check(state.delivered.size() == 1 and allSafety))

  run testCrashPreservesLock =
    init
      .then(persist(vote("A", 0, "prepare", "value-X")))
      .then(persist(vote("A", 0, "commit", "value-X")))
      .then(crash)
      .then(check(state.volatileMessages.size() == 0 and state.outbox.size() == 2 and allSafety))
      .then(restart)
      .then(check(
        state.lockedValueDigest.get("A") == "value-X" and
          state.committedValueDigest.get("A") == "value-X" and
          state.volatileMessages == state.outbox and
          allSafety))
}
