// AA adjunct: the connection roster, not the bounded hint map, owns recurring
// sweep eligibility. A cancellation request does not settle a native send.
// Authentication/admission, a stable connected roster and timer dispatch are
// abstracted; payload replay, exact bytes and wall-clock delays are not modeled.
module roomRepairCustodySpec {
  const PEER_COUNT: int
  const SEND_LIMIT: int
  const HINT_LIMIT: int
  pure val PEERS = 0.to(PEER_COUNT - 1)
  type State = { cursor:int, native:Set[int], accounted:Set[int], cancelled:Set[int], awaiting:Set[int],
    hints:Set[int], asked:Set[int], admitted:Set[int], closed:bool, joined:bool }
  var s: State
  pure def chosen(st: State): int = {
    val available = PEERS.exclude(st.native)
    val after = available.filter(p => p > st.cursor)
    val candidates = if (after.size() > 0) after else available
    candidates.fold(PEER_COUNT, (best, p) => if (p < best) p else best)
  }
  pure def safetyOf(st: State): bool = and {
    st.native.subseteq(PEERS), st.accounted == st.native,
    st.cancelled.subseteq(st.native), st.native.size() <= SEND_LIMIT,
    st.hints.subseteq(PEERS), st.hints.size() <= HINT_LIMIT,
    st.asked.subseteq(PEERS), st.admitted.subseteq(st.asked), st.awaiting.subseteq(st.asked),
    -1 <= st.cursor and st.cursor < PEER_COUNT,
    st.joined.implies(st.closed and st.native == Set()),
  }
  val safety = safetyOf(s)
  val reachedUnrememberedPeer = s.asked.contains(PEER_COUNT - 1)
  val reachedCancelledNative = s.cancelled.size() > 0 and s.native == s.accounted
  val reachedQuietRepair = s.admitted == PEERS
  val neverUnrememberedPeer = not(reachedUnrememberedPeer)
  action init = s' = { cursor:-1, native:Set(), accounted:Set(), cancelled:Set(), awaiting:Set(),
    hints:0.to(HINT_LIMIT - 1), asked:Set(), admitted:Set(), closed:false, joined:false }
  action sweep = {
    val p = chosen(s)
    all { not(s.closed), s.accounted.size() < SEND_LIMIT, s.native.size() < PEER_COUNT,
    s' = s.with("cursor", p).with("native", s.native.union(Set(p)))
      .with("accounted", s.accounted.union(Set(p))).with("asked", s.asked.union(Set(p)))
      .with("awaiting", s.awaiting.union(Set(p))),
    }
  }
  // A native history-request send can settle before its separate answer arrives.
  // Its promise settles even if the answer is lost; this does not admit a row.
  action settle(p: int): bool = all { s.native.contains(p),
    s' = s.with("native", s.native.exclude(Set(p))).with("accounted", s.accounted.exclude(Set(p)))
      .with("cancelled", s.cancelled.exclude(Set(p))),
  }
  action answer(p: int): bool = all { s.awaiting.contains(p), not(s.closed),
    s' = s.with("awaiting", s.awaiting.exclude(Set(p))).with("admitted", s.admitted.union(Set(p))),
  }
  action loseAnswer(p: int): bool = all { s.awaiting.contains(p),
    s' = s.with("awaiting", s.awaiting.exclude(Set(p))),
  }
  action deadline(p: int): bool = all { s.native.contains(p),
    s' = s.with("cancelled", s.cancelled.union(Set(p))),
  }
  action close = s' = s.with("closed", true).with("cancelled", s.native)
  action join = all { s.closed, s.native == Set(), s' = s.with("joined", true) }
  action liveStep = any {
    sweep,
    { nondet p = PEERS.oneOf()
      any { settle(p), answer(p), loseAnswer(p) } },
    { nondet p = PEERS.oneOf()
      deadline(p) },
    s' = s,
  }
  action step = any { liveStep, close, join }
  action unsafeCancelReleasesSlot(p: int): bool = all { s.native.contains(p),
    s' = s.with("accounted", s.accounted.exclude(Set(p))).with("cancelled", s.cancelled.union(Set(p))),
  }
  action unsafeJoinOnCancel = all { s.closed, s.native == s.cancelled, s' = s.with("joined", true) }
  action unsafeHintOnlySweep = {
    nondet p = s.hints.exclude(s.native).oneOf()
    all { not(s.closed), s.accounted.size() < SEND_LIMIT,
    s' = s.with("cursor", p).with("native", s.native.union(Set(p)))
      .with("accounted", s.accounted.union(Set(p))).with("asked", s.asked.union(Set(p)))
      .with("awaiting", s.awaiting.union(Set(p))),
    }
  }
  action unsafeStep = any {
    step,
    { nondet p = PEERS.oneOf()
      unsafeCancelReleasesSlot(p) },
    unsafeJoinOnCancel,
  }
  // This is conditional liveness, not a promise under arbitrary delay. The
  // sender is scheduled, the roster stays connected, native sends eventually
  // settle, and an answer eventually arrives after infinitely many retries.
  temporal fairRepair = (sweep.weakFair(Set(s)) and
    PEERS.forall(p => settle(p).weakFair(Set(s)) and answer(p).strongFair(Set(s))))
      .implies(eventually(s.admitted == PEERS))
  action unsafeHintLiveStep = any {
    unsafeHintOnlySweep,
    { nondet p = PEERS.oneOf()
      any { settle(p), answer(p), loseAnswer(p) } },
    s' = s,
  }
  temporal fairHintRepair = (unsafeHintOnlySweep.weakFair(Set(s)) and
    PEERS.forall(p => settle(p).weakFair(Set(s)) and answer(p).strongFair(Set(s))))
      .implies(eventually(s.admitted == PEERS))
  run deadlineKeepsNativeSlotTest = init.then(sweep).then(deadline(0))
    .expect(s.native == Set(0) and s.accounted == Set(0) and safety)
  run closeJoinsNativeSettlementTest = init.then(sweep).then(close).expect(not(s.joined) and safety)
    .then(settle(0)).then(join).expect(s.joined and safety)
  run cancelledSlotCounterexampleTest = init.then(sweep).then(unsafeCancelReleasesSlot(0)).expect(not(safety))
  run prematureJoinCounterexampleTest = init.then(sweep).then(close).then(unsafeJoinOnCancel).expect(not(safety))
  run quietLostAnswerRetriesTest = init.then(sweep).then(settle(0)).then(loseAnswer(0))
    .expect(s.native == Set() and s.admitted == Set() and safety)
    .then((PEER_COUNT - 1).reps(i => sweep.then(settle(i + 1)).then(loseAnswer(i + 1))))
    .then(sweep).then(settle(0)).then(answer(0)).expect(s.admitted.contains(0) and safety)
  run boundedMapDoesNotLimitRosterTest = init
    .then(PEER_COUNT.reps(i => sweep.then(settle(i))))
    .expect(s.asked == PEERS and s.hints.size() == HINT_LIMIT and safety)
}

module roomRepairCustodySmall {
  import roomRepairCustodySpec(PEER_COUNT = 3, SEND_LIMIT = 2, HINT_LIMIT = 2).* from "./room-repair-custody"
}

module roomRepairCustody65 {
  import roomRepairCustodySpec(PEER_COUNT = 65, SEND_LIMIT = 2, HINT_LIMIT = 64).* from "./room-repair-custody"
}
