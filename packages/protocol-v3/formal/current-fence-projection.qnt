// A deliberately small overapproximation of one writer's issuance projection.
// Only epoch/start/next and row kind/epoch matter to the current-fence lemma.
// Mapping the actual Track J transitions to this relation remains a separate
// refinement obligation; this module is not full-contract induction.
module currentFenceProjection {
  pure val SLOTS = 0.to(4)
  type Row = {ep:int, kind:str}
  type State = {epoch:int, start:int, next:int, rows:int -> Row}
  var s: State
  pure def fenceOf(st: State): bool = st.epoch > 0 implies
    (0 <= st.start and st.start < st.next and st.rows.get(st.start) == {ep:st.epoch, kind:"fence"})
  val currentFence = fenceOf(s)
  val neverInstalled = s.epoch == 0
  action init = s' = {epoch:0, start:0, next:0, rows:SLOTS.mapBy(_ => {ep:0, kind:"none"})}
  action appendRow(kind: str): bool = all { s.next <= 4,
    s' = s.with("next", s.next + 1).with("rows", s.rows.set(s.next, {ep:s.epoch, kind:kind})),
  }
  // Successful install/readmission writes one fence followed by zero or more
  // replacement rows. Failed installs, expiration, pruning and metadata frame
  // the projection. Looser target guards are safe for this lemma.
  action install(target: int, count: int): bool = all {
    target > s.epoch, target <= 3, count >= 0, s.next + count <= 4,
    s' = {epoch:target, start:s.next, next:s.next + 1 + count,
      rows:SLOTS.mapBy(q => if (q == s.next) {ep:target, kind:"fence"}
        else if (q > s.next and q <= s.next + count) {ep:target, kind:"repl"} else s.rows.get(q))},
  }
  action step = any { s' = s,
    { nondet kind = Set("move", "repl").oneOf() appendRow(kind) },
    { nondet target = 1.to(3).oneOf() nondet count = 0.to(4).oneOf() install(target, count) },
  }
  action indInit = {
    nondet epoch = 0.to(3).oneOf()
    nondet start = SLOTS.oneOf()
    nondet nx = 0.to(5).oneOf()
    nondet eps = SLOTS.setOfMaps(0.to(3)).oneOf()
    nondet kinds = SLOTS.setOfMaps(Set("none", "fence", "move", "repl")).oneOf()
    val st: State = {epoch:epoch, start:start, next:nx, rows:SLOTS.mapBy(q => {ep:eps.get(q), kind:kinds.get(q)})}
    all { fenceOf(st), s' = st }
  }
  action unsafeAppendAtStart = all { s.epoch > 0,
    s' = s.with("rows", s.rows.set(s.start, {ep:s.epoch, kind:"move"})),
  }
  action unsafeStep = any { step, unsafeAppendAtStart }
  run installedFenceSurvivesLaterIssueTest = init.then(install(1, 1)).then(appendRow("move")).expect(currentFence)
  run freshReadmissionWritesItsOwnFenceTest = init.then(install(1, 0)).then(appendRow("move"))
    .then(install(3, 0)).expect(currentFence and s.start == 2)
  run fenceOverwriteCounterexampleTest = init.then(install(1, 0)).then(unsafeAppendAtStart).expect(not(currentFence))
}
