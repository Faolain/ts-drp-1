// Source-age induction projection. An assigned disposition means replOf != -1
// (replacement, expiry, or review). Row epoch bounded by installed epoch is a
// necessary supporting law; source age alone admits impossible future rows.
// The actual-machine refinement obligation is separate from this finite proof.
module sourceAgeProjection {
  pure val SLOTS = 0.to(4)
  type State = {epoch:int, next:int, rowEpoch:int -> int, assigned:Set[int]}
  var s: State
  pure def issued(st: State): Set[int] = SLOTS.filter(q => q < st.next)
  pure def sourceAgeOf(st: State): bool = st.assigned.forall(q => st.rowEpoch.get(q) < st.epoch)
  pure def safetyOf(st: State): bool = and {
    st.assigned.subseteq(issued(st)), sourceAgeOf(st),
    issued(st).forall(q => 0 <= st.rowEpoch.get(q) and st.rowEpoch.get(q) <= st.epoch),
  }
  val sourceAge = sourceAgeOf(s)
  val safety = safetyOf(s)
  val neverAssigned = s.assigned == Set()
  action init = s' = {epoch:0, next:0, rowEpoch:SLOTS.mapBy(_ => -1), assigned:Set()}
  action appendRow = all { s.next <= 4,
    s' = s.with("next", s.next + 1).with("rowEpoch", s.rowEpoch.set(s.next, s.epoch)),
  }
  // Install/readmission may assign any previously issued source, a looser
  // guard than the actual displaced/unfinished-source selection. Existing
  // dispositions persist; manual resolution changes their value, not presence.
  action install(target: int, count: int, sources: Set[int]): bool = all {
    target > s.epoch, target <= 3, count >= 0, s.next + count <= 4, sources.subseteq(issued(s)),
    s' = s.with("epoch", target).with("next", s.next + 1 + count).with("assigned", s.assigned.union(sources))
      .with("rowEpoch", SLOTS.mapBy(q => if (q >= s.next and q <= s.next + count) target else s.rowEpoch.get(q))),
  }
  action step = any { s' = s, appendRow,
    { nondet target = 1.to(3).oneOf() nondet count = 0.to(4).oneOf() nondet sources = SLOTS.powerset().oneOf()
      install(target, count, sources) },
  }
  action arbitrary(strong: bool): bool = {
    nondet epoch = 0.to(3).oneOf()
    nondet nx = 0.to(5).oneOf()
    nondet rowEpoch = SLOTS.setOfMaps((-1).to(3)).oneOf()
    nondet assigned = SLOTS.powerset().oneOf()
    val st: State = {epoch:epoch, next:nx, rowEpoch:rowEpoch, assigned:assigned}
    all { if (strong) safetyOf(st) else sourceAgeOf(st) and st.assigned.subseteq(issued(st)), s' = st }
  }
  action indInit = arbitrary(true)
  action weakIndInit = arbitrary(false)
  action unsafeAssignCurrent(q: int): bool = all { issued(s).contains(q), s.rowEpoch.get(q) == s.epoch,
    s' = s.with("assigned", s.assigned.union(Set(q))),
  }
  action unsafeStep = any { step, { nondet q = SLOTS.oneOf() unsafeAssignCurrent(q) } }
  run installAssignsOnlyOlderSourcesTest = init.then(appendRow).then(install(1, 1, Set(0))).expect(safety)
  run laterApplicationIssuePreservesSourceAgeTest = init.then(appendRow).then(install(1, 0, Set(0)))
    .then(appendRow).then(install(3, 0, Set(2))).expect(safety and s.assigned == Set(0, 2))
  run currentEpochDispositionCounterexampleTest = init.then(appendRow).then(unsafeAssignCurrent(0)).expect(not(safety))
}
