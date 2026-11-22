// Two observable callers plus arbitrarily recurring anonymous later demand.
// Every round reads one authenticated fixed two-row prefix. Native send success
// is abstracted; cancellation resolves a caller with failure, not false success.
module replayBroadcastRounds {
  pure val CALLERS = Set(0, 1)
  pure val ROWS = Set(0, 1)
  type State = { requested:Set[int], connected:Set[int], received:int -> Set[int], completed:Set[int], success:Set[int],
    current:Set[int], pending:Set[int], pendingExists:bool, active:bool, nextRow:int,
    native:bool, nativeReceivers:Set[int], retired:bool }
  var s: State
  pure def safetyOf(st: State): bool = and {
    st.requested == st.completed.union(st.current).union(st.pending),
    st.current.intersect(st.pending) == Set(), st.completed.intersect(st.current.union(st.pending)) == Set(),
    st.success.subseteq(st.completed), st.success.forall(c => st.received.get(c) == ROWS),
    st.native.implies(st.active), st.pendingExists.implies(st.active),
    (st.pending.size() > 0).implies(st.pendingExists),
    not(st.active).implies(st.current == Set() and st.pending == Set() and not(st.pendingExists) and st.nextRow == 0),
    0 <= st.nextRow and st.nextRow <= 2,
  }
  val safety = safetyOf(s)
  val neverComplete = s.completed == Set()
  action init = s' = { requested:Set(), connected:Set(), received:CALLERS.mapBy(_ => Set()), completed:Set(), success:Set(),
    current:Set(), pending:Set(), pendingExists:false, active:false, nextRow:0, native:false, nativeReceivers:Set(), retired:false }
  action request(c: int): bool = all { not(s.requested.contains(c)), not(s.retired),
    s' = s.with("requested", s.requested.union(Set(c))).with("connected", s.connected.union(Set(c)))
      .with("active", true)
      .with("current", if (s.active) s.current else Set(c))
      .with("pending", if (s.active) s.pending.union(Set(c)) else s.pending)
      .with("pendingExists", s.active or s.pendingExists),
  }
  action laterDemand = all { s.active, not(s.retired), s' = s.with("pendingExists", true) }
  action startSend = all { s.active, not(s.retired), not(s.native), s.nextRow < 2,
    s' = s.with("native", true).with("nativeReceivers", s.connected),
  }
  action nativeJoin = all { s.native,
    s' = s.with("native", false).with("nativeReceivers", Set())
      .with("received", if (s.retired) s.received else CALLERS.mapBy(c =>
        if (s.nativeReceivers.contains(c)) s.received.get(c).union(Set(s.nextRow)) else s.received.get(c)))
      .with("nextRow", if (s.retired) s.nextRow else s.nextRow + 1),
  }
  pure def finish(st: State): State = st.with("completed", st.completed.union(st.current))
    .with("success", st.success.union(st.current)).with("current", if (st.pendingExists) st.pending else Set())
    .with("pending", Set()).with("active", st.pendingExists).with("pendingExists", false).with("nextRow", 0)
  action finishRound = all { s.active, not(s.retired), not(s.native), s.nextRow == 2, s' = finish(s) }
  action retire = s' = s.with("retired", true)
  action abortFinish = all { s.active, s.retired, not(s.native),
    s' = s.with("completed", s.completed.union(s.current).union(s.pending)).with("current", Set()).with("pending", Set())
      .with("pendingExists", false).with("active", false).with("nextRow", 0),
  }
  action step = any {
    { nondet c = CALLERS.oneOf() request(c) },
    laterDemand, startSend, nativeJoin, finishRound, retire, abortFinish, s' = s,
  }
  temporal fairCompletion = (startSend.weakFair(Set(s)) and nativeJoin.weakFair(Set(s)) and
    finishRound.weakFair(Set(s)) and abortFinish.weakFair(Set(s)))
      .implies(CALLERS.forall(c => s.requested.contains(c).leadsTo(s.completed.contains(c))))
  action unsafeLateCallerJoinsCurrent(c: int): bool = all { s.active, not(s.retired), not(s.requested.contains(c)),
    s' = s.with("requested", s.requested.union(Set(c))).with("connected", s.connected.union(Set(c)))
      .with("current", s.current.union(Set(c))),
  }
  action unsafeFinishOnlyWhenQuiet = all { s.active, not(s.retired), not(s.native), s.nextRow == 2,
    s' = if (s.pendingExists) s.with("current", s.current.union(s.pending)).with("pending", Set())
      .with("pendingExists", false).with("nextRow", 0) else finish(s),
  }
  action unsafeSafetyStep = any { step, { nondet c = CALLERS.oneOf() unsafeLateCallerJoinsCurrent(c) } }
  action unsafeQuietStep = any {
    { nondet c = CALLERS.oneOf() request(c) },
    laterDemand, startSend, nativeJoin, unsafeFinishOnlyWhenQuiet, retire, abortFinish, s' = s,
  }
  temporal unsafeFairCompletion = (startSend.weakFair(Set(s)) and nativeJoin.weakFair(Set(s)) and
    unsafeFinishOnlyWhenQuiet.weakFair(Set(s)) and abortFinish.weakFair(Set(s)))
      .implies(CALLERS.forall(c => s.requested.contains(c).leadsTo(s.completed.contains(c))))
  action sendRow = startSend.then(nativeJoin)
  run latePeerGetsFullPendingRoundTest = init.then(request(0)).then(startSend).then(request(1)).then(nativeJoin)
    .then(sendRow).then(finishRound).expect(s.completed == Set(0) and s.received.get(1) == Set(1) and safety)
    .then(sendRow).then(sendRow).then(finishRound).expect(s.success == CALLERS and safety)
  run continuousDemandDoesNotExtendEarlierPromiseTest = init.then(request(0)).then(sendRow).then(laterDemand)
    .then(sendRow).then(laterDemand).then(finishRound).expect(s.completed.contains(0) and s.active and safety)
    .then(sendRow).then(laterDemand).then(sendRow).then(laterDemand).then(finishRound)
    .expect(s.completed.contains(0) and s.active and safety)
  run cancellationJoinsThenResolvesPendingCallersTest = init.then(request(0)).then(startSend).then(request(1)).then(retire)
    .expect(s.native and s.completed == Set() and safety).then(nativeJoin).then(abortFinish)
    .expect(s.completed == CALLERS and s.success == Set() and safety)
  run lateCurrentJoinCounterexampleTest = init.then(request(0)).then(startSend).then(unsafeLateCallerJoinsCurrent(1))
    .then(nativeJoin).then(sendRow).then(finishRound).expect(not(safety))
  run quietOnlyCompletionStaysPendingTest = init.then(request(0)).then(sendRow).then(laterDemand)
    .then(sendRow).then(unsafeFinishOnlyWhenQuiet).expect(not(s.completed.contains(0)) and s.active)
}
