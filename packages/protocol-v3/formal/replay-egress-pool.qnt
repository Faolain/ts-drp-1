// One network instance and stable room topic. A stream reserves a slot until
// its original completion; each detached encoded message stays charged until
// the physical native send joins. Epoch retirement is not native completion.
module replayEgressPoolSpec {
  const JOB_COUNT: int
  const SLOT_LIMIT: int
  const BYTE_LIMIT: int
  pure val JOBS = 0.to(JOB_COUNT - 1)
  pure val REGS = Set(0, 1, 2)
  type State = { current:int, generation:int, retired:Set[int], used:Set[int], owner:int -> int,
    jobs:Set[int], accounted:Set[int], native:Set[int], cancelled:Set[int], weights:int -> int, bytes:int,
    idle:int, resolved:Set[int], waiting:bool, waitingOn:int, awake:bool, joined:bool, shutdownReg:int, badJoin:bool }
  var s: State
  pure def physicalBytes(st: State): int = st.native.fold(0, (total, j) => total + st.weights.get(j))
  pure def safetyOf(st: State): bool = and {
    st.jobs == st.accounted, st.jobs.subseteq(st.used), st.native.subseteq(st.jobs), st.cancelled.subseteq(st.jobs),
    st.jobs.size() <= SLOT_LIMIT, st.bytes == physicalBytes(st), 0 <= st.bytes and st.bytes <= BYTE_LIMIT,
    JOBS.forall(j => if (st.native.contains(j)) 1 <= st.weights.get(j) and st.weights.get(j) <= 2
      else st.weights.get(j) == 0),
    st.used.forall(j => 0 <= st.owner.get(j) and st.owner.get(j) <= st.generation),
    st.retired.forall(r => r <= st.generation),
    (st.current >= 0).implies(st.current == st.generation and not(st.retired.contains(st.current))),
    (st.jobs.size() > 0).implies(not(st.resolved.contains(st.idle))),
    st.resolved.forall(g => 0 <= g and g <= st.idle), 0 <= st.idle and st.idle <= st.used.size(),
    st.joined.implies(st.jobs == Set()), not(st.badJoin),
  }
  val safety = safetyOf(s)
  val reachedRetiredNative = s.native.exists(j => s.retired.contains(s.owner.get(j)))
  val neverRetiredNative = not(reachedRetiredNative)
  action init = s' = { current:0, generation:0, retired:Set(), used:Set(), owner:JOBS.mapBy(_ => -1),
    jobs:Set(), accounted:Set(), native:Set(), cancelled:Set(), weights:JOBS.mapBy(_ => 0), bytes:0,
    idle:0, resolved:Set(), waiting:false, waitingOn:0, awake:false, joined:false, shutdownReg:-1, badJoin:false }
  pure def admitEnabled(st: State, j: int): bool = st.current >= 0 and not(st.joined) and
    not(st.used.contains(j)) and st.accounted.size() < SLOT_LIMIT
  action admit(j: int): bool = all { admitEnabled(s, j),
    s' = s.with("used", s.used.union(Set(j))).with("owner", s.owner.set(j, s.current))
      .with("jobs", s.jobs.union(Set(j))).with("accounted", s.accounted.union(Set(j)))
      .with("idle", if (s.jobs == Set()) s.idle + 1 else s.idle),
  }
  action startNative(j: int, weight: int): bool = all {
    s.jobs.contains(j), not(s.native.contains(j)), not(s.cancelled.contains(j)), s.owner.get(j) == s.current,
    1 <= weight and weight <= 2, s.bytes + weight <= BYTE_LIMIT,
    s' = s.with("native", s.native.union(Set(j))).with("weights", s.weights.set(j, weight))
      .with("bytes", s.bytes + weight),
  }
  action nativeJoin(j: int): bool = all { s.native.contains(j),
    s' = s.with("native", s.native.exclude(Set(j))).with("weights", s.weights.set(j, 0))
      .with("bytes", s.bytes - s.weights.get(j)),
  }
  action cancel(j: int): bool = all { s.jobs.contains(j), s' = s.with("cancelled", s.cancelled.union(Set(j))) }
  action finish(j: int): bool = all { s.jobs.contains(j), not(s.native.contains(j)),
    s' = s.with("jobs", s.jobs.exclude(Set(j))).with("accounted", s.accounted.exclude(Set(j)))
      .with("cancelled", s.cancelled.exclude(Set(j)))
      .with("resolved", if (s.jobs == Set(j)) s.resolved.union(Set(s.idle)) else s.resolved),
  }
  pure def retireCurrent(st: State): State = if (st.current < 0) st else
    st.with("retired", st.retired.union(Set(st.current)))
      .with("cancelled", st.cancelled.union(st.jobs.filter(j => st.owner.get(j) == st.current)))
      .with("current", -1)
  action handoff = all { s.current >= 0, s.generation < 2, not(s.joined),
    s' = retireCurrent(s).with("generation", s.generation + 1).with("current", s.generation + 1),
  }
  action activate = all { s.current == -1, s.generation < 2, not(s.joined),
    s' = s.with("generation", s.generation + 1).with("current", s.generation + 1),
  }
  action beginShutdown = all { not(s.waiting), not(s.joined),
    s' = retireCurrent(s).with("waiting", true).with("shutdownReg", s.current)
      .with("waitingOn", s.idle).with("awake", s.jobs == Set()),
  }
  action observeIdleWake = all { s.waiting, s.jobs == Set() or s.resolved.contains(s.waitingOn),
    s' = s.with("awake", true),
  }
  action recheckShutdown = all { s.waiting, s.awake,
    s' = if (s.jobs == Set()) s.with("waiting", false).with("joined", true)
      else s.with("awake", false).with("waitingOn", s.idle),
  }
  action step = any { handoff, activate, beginShutdown, observeIdleWake, recheckShutdown,
    { nondet j = JOBS.oneOf()
      nondet weight = Set(1, 2).oneOf()
      any { admit(j), startNative(j, weight), nativeJoin(j), cancel(j), finish(j) } },
    s' = s,
  }
  // Quiescent shutdown: no replacement starts while this close is waiting;
  // physical sends settle and their admitted stream finalizers are scheduled.
  temporal quiescentShutdown = (always(s.waiting.implies(s.current == -1)) and
    JOBS.forall(j => nativeJoin(j).weakFair(Set(s)) and finish(j).weakFair(Set(s))) and
    observeIdleWake.weakFair(Set(s)) and recheckShutdown.weakFair(Set(s)))
      .implies(s.waiting.leadsTo(s.joined))
  action unsafeResetEpochSlots = all { s.current >= 0, s' = s.with("accounted", Set()) }
  action unsafeCancelReleasesBytes(j: int): bool = all { s.native.contains(j),
    s' = s.with("bytes", s.bytes - s.weights.get(j)).with("cancelled", s.cancelled.union(Set(j))),
  }
  action unsafeJoinCurrentEpochOnly = all { s.waiting,
    not(s.jobs.exists(j => s.owner.get(j) == s.shutdownReg)),
    s' = s.with("joined", true).with("waiting", false).with("badJoin", s.jobs != Set()),
  }
  action unsafeJoinOnOldWake = all { s.waiting, s.awake,
    s' = s.with("joined", true).with("waiting", false).with("badJoin", s.jobs != Set()),
  }
  action unsafeReuseResolvedIdle(j: int): bool = all { admitEnabled(s, j), s.jobs == Set(),
    s' = s.with("used", s.used.union(Set(j))).with("owner", s.owner.set(j, s.current))
      .with("jobs", Set(j)).with("accounted", Set(j)),
  }
  action unsafeStep = any { step, unsafeResetEpochSlots, unsafeJoinCurrentEpochOnly, unsafeJoinOnOldWake,
    { nondet j = JOBS.oneOf() any { unsafeCancelReleasesBytes(j), unsafeReuseResolvedIdle(j) } },
  }
  action indInit = {
    nondet current = (-1).to(2).oneOf()
    nondet generation = REGS.oneOf()
    nondet retired = REGS.powerset().oneOf()
    nondet used = JOBS.powerset().oneOf()
    nondet owner = JOBS.setOfMaps((-1).to(2)).oneOf()
    nondet jobs = JOBS.powerset().oneOf()
    nondet accounted = JOBS.powerset().oneOf()
    nondet native = JOBS.powerset().oneOf()
    nondet cancelled = JOBS.powerset().oneOf()
    nondet weights = JOBS.setOfMaps(0.to(2)).oneOf()
    nondet bytes = 0.to(BYTE_LIMIT).oneOf()
    nondet idle = 0.to(JOB_COUNT).oneOf()
    nondet resolved = 0.to(JOB_COUNT).powerset().oneOf()
    nondet waiting = Set(false, true).oneOf()
    nondet waitingOn = 0.to(JOB_COUNT).oneOf()
    nondet awake = Set(false, true).oneOf()
    nondet joined = Set(false, true).oneOf()
    nondet shutdownReg = (-1).to(2).oneOf()
    val st: State = {current:current, generation:generation, retired:retired, used:used, owner:owner,
      jobs:jobs, accounted:accounted, native:native, cancelled:cancelled, weights:weights, bytes:bytes,
      idle:idle, resolved:resolved, waiting:waiting, waitingOn:waitingOn, awake:awake, joined:joined,
      shutdownReg:shutdownReg, badJoin:false}
    all { safetyOf(st), s' = st }
  }
  run oldHeldSendSurvivesHotHandoffTest = init.then(admit(0)).then(startNative(0, 1)).then(handoff)
    .then(admit(1)).then(startNative(1, 1)).expect(s.native == Set(0, 1) and s.bytes == 2 and safety)
  run cancelledSendKeepsSlotAndBytesTest = init.then(admit(0)).then(startNative(0, 2)).then(cancel(0))
    .expect(s.jobs == Set(0) and s.bytes == 2 and safety).then(nativeJoin(0)).then(finish(0))
    .expect(s.jobs == Set() and s.bytes == 0 and safety)
  run currentCloseJoinsRetiredSendTest = init.then(admit(0)).then(startNative(0, 1)).then(handoff)
    .then(beginShutdown).expect(not(s.joined) and safety).then(nativeJoin(0)).then(finish(0))
    .then(observeIdleWake).then(recheckShutdown).expect(s.joined and safety)
  action oldIdleWake = admit(0).then(startNative(0, 1)).then(beginShutdown)
    .then(nativeJoin(0)).then(finish(0)).then(observeIdleWake).then(activate)
    .then(admit(1)).then(startNative(1, 1))
  run oldIdleWakeRechecksNewGenerationTest = init.then(oldIdleWake).then(recheckShutdown)
    .expect(not(s.joined) and not(s.awake) and safety).then(nativeJoin(1)).then(finish(1))
    .then(observeIdleWake).then(recheckShutdown).expect(s.joined and safety)
  run epochSlotResetCounterexampleTest = init.then(admit(0)).then(startNative(0, 1)).then(handoff)
    .then(unsafeResetEpochSlots).expect(not(safety))
  run cancelledByteRefundCounterexampleTest = init.then(admit(0)).then(startNative(0, 2))
    .then(unsafeCancelReleasesBytes(0)).expect(not(safety))
  run currentOnlyShutdownCounterexampleTest = init.then(admit(0)).then(startNative(0, 1)).then(handoff)
    .then(beginShutdown).then(unsafeJoinCurrentEpochOnly).expect(not(safety))
  run staleIdleWakeCounterexampleTest = init.then(oldIdleWake).then(unsafeJoinOnOldWake).expect(not(safety))
  run reusedIdlePromiseCounterexampleTest = init.then(admit(0)).then(finish(0))
    .then(unsafeReuseResolvedIdle(1)).expect(not(safety))
}

module replayEgressPoolSmall {
  import replayEgressPoolSpec(JOB_COUNT = 3, SLOT_LIMIT = 2, BYTE_LIMIT = 3).* from "./replay-egress-pool"
}

module replayEgressPool32 {
  import replayEgressPoolSpec(JOB_COUNT = 33, SLOT_LIMIT = 32, BYTE_LIMIT = 32).* from "./replay-egress-pool"
  run predecessorSendsLeaveThirtyCurrentSlotsTest = init.then(admit(0)).then(startNative(0, 1)).then(handoff)
    .then(admit(1)).then(startNative(1, 1)).then(handoff)
    .then(30.reps(i => admit(i + 2).then(startNative(i + 2, 1))))
    .expect(s.jobs.size() == 32 and s.bytes == 32 and not(admitEnabled(s, 32)) and safety)
    .then(nativeJoin(0)).then(finish(0)).then(admit(32)).then(startNative(32, 1))
    .expect(s.jobs.size() == 32 and s.bytes == 32 and safety)
}
