// Replay read-phase projection. Authentication, exact native snapshots and the
// FIFO's exclusion are premises. The model exposes the async boundaries where
// a queued read, source acquisition or stale completion can cross a transition.
module replayReadPhases {
  pure val REGS = Set(0, 1)
  pure val ATTEMPTS = Set(0, 1)
  type State = { current:int, phase:int -> str, retired:Set[int], prefix:int -> int,
    owner:int -> int, attemptReg:int -> int, previous:int -> str, kind:int -> str,
    status:int -> str, outcome:int -> str, acquiring:Set[int], ready:Set[int], sealedSource:int -> int,
    readReg:int, readStage:str, captureReg:int, captureOriginal:int, badRead:bool }
  var s: State
  pure def live(st: State, r: int): bool = r >= 0 and st.current == r and not(st.retired.contains(r))
  pure def readable(st: State, r: int): bool = live(st, r) and Set("active", "sealed").contains(st.phase.get(r))
  pure def owns(st: State, t: int): bool = ATTEMPTS.contains(t) and st.attemptReg.get(t) >= 0 and
    live(st, st.attemptReg.get(t)) and st.phase.get(st.attemptReg.get(t)) == "closing" and
    st.owner.get(st.attemptReg.get(t)) == t and st.status.get(t) == "pending"
  pure def retire(st: State, r: int): State = st.with("current", -1)
    .with("phase", st.phase.set(r, "retired")).with("retired", st.retired.union(Set(r)))
    .with("prefix", st.prefix.set(r, 0))
  pure def completedPhase(st: State, t: int): str =
    if (st.kind.get(t) == "pause" and st.outcome.get(t) == "ok") st.previous.get(t)
    else if (st.outcome.get(t) == "ok" and st.ready.contains(t)) "sealed" else "unavailable"
  pure def safetyOf(st: State): bool = and {
    st.retired.forall(r => st.phase.get(r) == "retired" and st.prefix.get(r) == 0 and st.current != r),
    REGS.forall(r => st.phase.get(r) == "sealed" implies
      (st.sealedSource.get(r) >= 0 and st.ready.contains(st.sealedSource.get(r)))),
    REGS.forall(r => (live(st, r) and st.owner.get(r) >= 0 and
      st.status.get(st.owner.get(r)) == "pending") implies st.phase.get(r) == "closing"),
    REGS.forall(r => (live(st, r) and st.owner.get(r) >= 0 and
      st.status.get(st.owner.get(r)) == "done") implies st.phase.get(r) == completedPhase(st, st.owner.get(r))),
    st.acquiring.forall(t => not(st.readStage == "native" and st.readReg == st.attemptReg.get(t))),
    REGS.forall(r => 0 <= st.prefix.get(r) and st.prefix.get(r) <= 2),
    not(st.badRead),
  }
  val safety = safetyOf(s)
  val reachedRetry = s.owner.get(0) == 1 and s.status.get(0) == "done"
  val reachedRetiredCapture = s.retired.contains(0) and s.captureReg == 0
  val neverSealed = not(s.phase.get(0) == "sealed")
  action init = s' = { current:0, phase:Map(0 -> "active", 1 -> "unavailable"), retired:Set(),
    prefix:REGS.mapBy(_ => 0), owner:REGS.mapBy(_ => -1), attemptReg:ATTEMPTS.mapBy(_ => -1),
    previous:ATTEMPTS.mapBy(_ => "unavailable"), kind:ATTEMPTS.mapBy(_ => "none"),
    status:ATTEMPTS.mapBy(_ => "unused"), outcome:ATTEMPTS.mapBy(_ => "unused"), acquiring:Set(), ready:Set(), sealedSource:REGS.mapBy(_ => -1),
    readReg:-1, readStage:"idle", captureReg:-1, captureOriginal:0, badRead:false }
  action queueRead = all { s.readStage == "idle", s.current >= 0,
    s' = s.with("readReg", s.current).with("readStage", "queued"),
  }
  action enterRead = all { s.readStage == "queued", readable(s, s.readReg),
    s' = s.with("readStage", "native"),
  }
  action finishRead = all { s.readStage == "native", s.captureReg == -1,
    // Stale reads release custody but cannot return a successful current result.
    s' = s.with("readStage", "idle").with("readReg", -1),
  }
  action dropQueued = all { s.readStage == "queued", not(live(s, s.readReg)),
    s' = s.with("readStage", "idle").with("readReg", -1),
  }
  action begin(t: int, kind: str): bool = all {
    s.current >= 0, s.status.get(t) == "unused", Set("close", "pause").contains(kind),
    not(Set("closing", "retired").contains(s.phase.get(s.current))),
    s' = s.with("previous", s.previous.set(t, s.phase.get(s.current)))
      .with("phase", s.phase.set(s.current, "closing")).with("owner", s.owner.set(s.current, t))
      .with("attemptReg", s.attemptReg.set(t, s.current)).with("kind", s.kind.set(t, kind))
      .with("status", s.status.set(t, "pending")),
  }
  action startSource(t: int): bool = all { owns(s, t), s.kind.get(t) == "close", s.acquiring == Set(),
    s.readStage != "native", not(s.ready.contains(t)), s' = s.with("acquiring", Set(t)),
  }
  action finishSource(t: int): bool = all { s.acquiring.contains(t),
    s' = s.with("acquiring", s.acquiring.exclude(Set(t)))
      .with("ready", if (owns(s, t)) s.ready.union(Set(t)) else s.ready),
  }
  action complete(t: int, successful: bool): bool = {
    val r = s.attemptReg.get(t)
    val exact = owns(s, t)
    val nextPhase = if (s.kind.get(t) == "pause" and successful) s.previous.get(t)
      else if (successful and s.ready.contains(t)) "sealed" else "unavailable"
    all { r >= 0,
      s' = s.with("status", s.status.set(t, "done"))
        .with("outcome", if (exact) s.outcome.set(t, if (successful) "ok" else "failed") else s.outcome)
        .with("phase", if (exact) s.phase.set(r, nextPhase) else s.phase)
        .with("sealedSource", if (exact and nextPhase == "sealed" and s.kind.get(t) == "close")
          s.sealedSource.set(r, t) else s.sealedSource),
    }
  }
  action handoff = all { s.current == 0,
    s' = retire(s, 0).with("current", 1).with("phase", s.phase.set(0, "retired").set(1, "active")),
  }
  action deactivate = all { s.current >= 0, s' = retire(s, s.current) }
  action beginCapture = all { s.readStage == "native", live(s, s.readReg), s.captureReg == -1,
    s' = s.with("captureReg", s.readReg).with("captureOriginal", s.prefix.get(s.readReg)),
  }
  action finishCapture = if (s.captureReg < 0) all { false, s' = s } else {
    val r = s.captureReg
    val prior = s.prefix.get(r)
    val count = if (live(s, r)) (if (prior < 2) prior + 1 else prior)
      else if (prior < s.captureOriginal) prior else s.captureOriginal
    all { r >= 0, s' = s.with("prefix", s.prefix.set(r, count)).with("captureReg", -1) }
  }
  action step = any {
    queueRead, enterRead, finishRead, dropQueued, beginCapture, finishCapture, handoff, deactivate,
    { nondet t = ATTEMPTS.oneOf()
      nondet kind = Set("close", "pause").oneOf()
      nondet successful = Set(false, true).oneOf()
      any { begin(t, kind), startSource(t), finishSource(t), complete(t, successful) } },
  }
  action unsafeQueuedReadUsesOldPhase = all { s.readStage == "queued", s.readReg == s.current,
    s' = s.with("readStage", "native"),
  }
  action unsafeLateCompletion(t: int): bool = all { s.attemptReg.get(t) >= 0,
    s' = s.with("phase", s.phase.set(s.attemptReg.get(t), s.previous.get(t))),
  }
  action unsafeFailedCloseRestores = all { s.current >= 0, s.phase.get(s.current) == "closing",
    s' = s.with("phase", s.phase.set(s.current, "active")),
  }
  action unsafeCompletedFailureRestores(t: int): bool = all { owns(s, t), s.kind.get(t) == "close",
    // A coherent wrong completion also marks its own callback done. The
    // completion postcondition must catch it without needing another race.
    s' = s.with("status", s.status.set(t, "done")).with("outcome", s.outcome.set(t, "failed"))
      .with("phase", s.phase.set(s.attemptReg.get(t), "active")),
  }
  action unsafeRollbackResurrectsPrefix = all { s.captureReg >= 0,
    s' = s.with("prefix", s.prefix.set(s.captureReg, s.captureOriginal)).with("captureReg", -1),
  }
  action unsafeStaleReadSucceeds = all { s.readStage == "native", not(live(s, s.readReg)),
    s' = s.with("badRead", true),
  }
  action unsafeStep = any { step, unsafeQueuedReadUsesOldPhase, unsafeFailedCloseRestores,
    unsafeRollbackResurrectsPrefix, unsafeStaleReadSucceeds,
    { nondet t = ATTEMPTS.oneOf() any { unsafeLateCompletion(t), unsafeCompletedFailureRestores(t) } } }
  run queuedReadYieldsBeforeSourceAcquisitionTest = init.then(queueRead).then(begin(0, "close"))
    .then(startSource(0)).expect(s.readStage == "queued" and safety)
    .then(finishSource(0)).then(complete(0, true)).then(enterRead).then(finishRead).expect(safety)
  run enteredReadDrainsBeforeCloseTest = init.then(queueRead).then(enterRead).then(begin(0, "close"))
    .then(finishRead).then(startSource(0)).then(finishSource(0)).then(complete(0, true)).expect(safety)
  run failedCloseRetryOwnsItsCompletionTest = init.then(begin(0, "close")).then(complete(0, false))
    .then(begin(1, "close")).then(complete(0, false)).expect(s.phase.get(0) == "closing" and safety)
    .then(startSource(1)).then(finishSource(1)).then(complete(1, true)).expect(s.phase.get(0) == "sealed" and safety)
  run retirementAbsorbsLateCompletionTest = init.then(begin(0, "close")).then(startSource(0))
    .then(handoff).then(finishSource(0)).then(complete(0, true)).expect(s.phase.get(0) == "retired" and safety)
  run readinessRestoresItsPriorPhaseTest = init.then(begin(0, "pause")).then(complete(0, true))
    .expect(s.phase.get(0) == "active" and safety)
  run failedCloseIsUnavailableWithoutAnotherRaceTest = init.then(begin(0, "close")).then(complete(0, false))
    .expect(s.phase.get(0) == "unavailable" and not(readable(s, 0)) and safety)
  run completedFailureRestoreCounterexampleTest = init.then(begin(0, "close"))
    .then(unsafeCompletedFailureRestores(0)).expect(not(safety))
  action captureOnePrefix = queueRead.then(enterRead).then(beginCapture).then(finishCapture).then(finishRead)
  run hotHandoffCannotRestoreCapturedPrefixTest = init.then(captureOnePrefix).then(queueRead).then(enterRead)
    .then(beginCapture).then(handoff).then(finishCapture).then(finishRead).expect(s.prefix.get(0) == 0 and safety)
  run sourceAcquisitionRaceCounterexampleTest = init.then(queueRead).then(begin(0, "close")).then(startSource(0))
    .then(unsafeQueuedReadUsesOldPhase).expect(not(safety))
  run staleRetryCompletionCounterexampleTest = init.then(begin(0, "close")).then(complete(0, false))
    .then(begin(1, "close")).then(unsafeLateCompletion(0)).expect(not(safety))
  run retirementCompletionCounterexampleTest = init.then(begin(0, "pause")).then(handoff)
    .then(unsafeLateCompletion(0)).expect(not(safety))
  run cacheRollbackCounterexampleTest = init.then(captureOnePrefix).then(queueRead).then(enterRead).then(beginCapture)
    .then(handoff).then(unsafeRollbackResurrectsPrefix).expect(not(safety))
  run staleReadReleaseCounterexampleTest = init.then(queueRead).then(enterRead).then(handoff)
    .then(unsafeStaleReadSucceeds).expect(not(safety))
}

// Reference-counted native journal custody. Parent revocation is prospective;
// physically held child references still join before the original native release.
module replayBorrowedCustody {
  pure val CHILDREN = Set(0, 1)
  type State = { parent:str, children:int -> str, refs:int, nativeReleased:bool, badReturn:bool, readOutcome:str }
  var s: State
  pure def childRefs(st: State): int = CHILDREN.filter(c => Set("acquiring", "held", "releasing").contains(st.children.get(c))).size()
  pure def safetyOf(st: State): bool = and {
    st.refs == childRefs(st) + (if (st.parent == "owned") 1 else 0),
    st.refs >= 0, st.refs <= 3, st.nativeReleased iff st.refs == 0, not(st.badReturn),
    (st.readOutcome == "ok").implies(st.parent == "owned"),
  }
  val safety = safetyOf(s)
  val neverBorrowed = not(CHILDREN.exists(c => s.children.get(c) == "held"))
  action init = s' = { parent:"owned", children:CHILDREN.mapBy(_ => "free"), refs:1, nativeReleased:false, badReturn:false, readOutcome:"" }
  action beginBorrow(c: int): bool = all { s.parent == "owned", s.children.get(c) == "free",
    s' = s.with("children", s.children.set(c, "acquiring")).with("refs", s.refs + 1),
  }
  action finishBorrow(c: int): bool = all { s.children.get(c) == "acquiring",
    s' = s.with("children", s.children.set(c, if (s.parent == "owned") "held" else "releasing")),
  }
  action beginChildRelease(c: int): bool = all { s.children.get(c) == "held",
    s' = s.with("children", s.children.set(c, "releasing")),
  }
  action finishChildRelease(c: int): bool = all { s.children.get(c) == "releasing",
    s' = s.with("children", s.children.set(c, "released")).with("refs", s.refs - 1)
      .with("nativeReleased", s.refs == 1),
  }
  action revokeParent = all { s.parent == "owned",
    s' = s.with("parent", "revoked").with("refs", s.refs - 1).with("nativeReleased", s.refs == 1).with("readOutcome", ""),
  }
  action readChild(c: int): bool = all { s.children.get(c) == "held",
    // A revoked parent causes refusal; it never revives through a child.
    s' = s.with("readOutcome", if (s.parent == "owned") "ok" else "refused"),
  }
  action step = any { revokeParent,
    { nondet c = CHILDREN.oneOf()
      any { beginBorrow(c), finishBorrow(c), beginChildRelease(c), finishChildRelease(c), readChild(c) } },
  }
  action indInit = {
    nondet parent = Set("owned", "revoked").oneOf()
    nondet children = CHILDREN.setOfMaps(Set("free", "acquiring", "held", "releasing", "released")).oneOf()
    nondet refs = 0.to(3).oneOf()
    nondet nativeReleased = Set(false, true).oneOf()
    nondet readOutcome = Set("", "ok", "refused").oneOf()
    val st: State = {parent:parent, children:children, refs:refs, nativeReleased:nativeReleased, badReturn:false, readOutcome:readOutcome}
    all { safetyOf(st), s' = st }
  }
  action unsafeChildReleaseDropsParent(c: int): bool = all { s.children.get(c) == "releasing",
    s' = s.with("children", s.children.set(c, "released")).with("refs", 0).with("nativeReleased", true),
  }
  action unsafeReturnAfterParentRevocation(c: int): bool = all {
    Set("acquiring", "held").contains(s.children.get(c)), s.parent != "owned",
    s' = s.with("children", s.children.set(c, "held")).with("badReturn", true),
  }
  action unsafeReadAfterParentRevocation(c: int): bool = all { s.children.get(c) == "held", s.parent != "owned",
    s' = s.with("readOutcome", "ok"),
  }
  action unsafeStep = any { step,
    { nondet c = CHILDREN.oneOf() any { unsafeChildReleaseDropsParent(c), unsafeReturnAfterParentRevocation(c), unsafeReadAfterParentRevocation(c) } },
  }
  run childReleasePreservesNativeParentTest = init.then(beginBorrow(0)).then(finishBorrow(0))
    .then(beginChildRelease(0)).then(finishChildRelease(0)).expect(s.refs == 1 and not(s.nativeReleased) and safety)
  run parentReleaseJoinsOutstandingChildrenTest = init.then(beginBorrow(0)).then(finishBorrow(0))
    .then(beginBorrow(1)).then(finishBorrow(1)).then(revokeParent).expect(s.refs == 2 and not(s.nativeReleased) and safety)
    .then(beginChildRelease(0)).then(finishChildRelease(0)).then(beginChildRelease(1)).then(finishChildRelease(1))
    .expect(s.nativeReleased and safety)
  run acquisitionRaceReleasesOnlyItsChildTest = init.then(beginBorrow(0)).then(revokeParent)
    .then(finishBorrow(0)).then(finishChildRelease(0)).expect(s.nativeReleased and safety)
  run childCancellationCounterexampleTest = init.then(beginBorrow(0)).then(finishBorrow(0))
    .then(beginChildRelease(0)).then(unsafeChildReleaseDropsParent(0)).expect(not(safety))
  run parentRevocationRaceCounterexampleTest = init.then(beginBorrow(0)).then(revokeParent)
    .then(unsafeReturnAfterParentRevocation(0)).expect(not(safety))
  run revokedParentRefusesAChildReadTest = init.then(beginBorrow(0)).then(finishBorrow(0)).then(revokeParent)
    .then(readChild(0)).expect(s.readOutcome == "refused" and safety)
  run revokedParentReadCounterexampleTest = init.then(beginBorrow(0)).then(finishBorrow(0)).then(revokeParent)
    .then(unsafeReadAfterParentRevocation(0)).expect(not(safety))
}
