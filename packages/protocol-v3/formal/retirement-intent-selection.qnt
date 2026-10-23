// A fixed through-epoch is not an intent identity. Authentication of both
// digests, journal custody, and complete publication are premises here. Source
// identity is the authenticated reconstructed image, not physical DELETE alone.
module retirementIntentSelection {
  pure val ROWS = Set(0, 1, 2)
  // Row 0 depends on replacement 1. Row 2 is independent.
  type State = { journal:Set[int], retired:Set[int], prior:str,
    decision:int, source:int, holes:Set[int], selected:Set[int], checked:bool,
    requestedDecision:int, requestedSource:int, allowed:bool }
  var s: State
  pure def eligible(st: State): Set[int] = ROWS.exclude(st.journal).exclude(st.retired)
  pure def retirementCandidates(st: State): Set[int] = {
    val candidates = eligible(st)
    // The greatest retirement set preserves a replacement while its source
    // remains live. Already retired sources do not acquire new authority.
    if (not(candidates.contains(0)) and not(st.retired.contains(0))) candidates.exclude(Set(1)) else candidates
  }
  // Native holes are protectedRecords: rows retained above the logical floor,
  // not the rows selected for deletion. Completed retirement never resurrects.
  pure def derive(st: State): Set[int] = ROWS.exclude(st.retired).exclude(retirementCandidates(st))
  pure def same(st: State, d: int, p: int): bool = st.prior != "none" and st.decision == d and st.source == p
  pure def choose(st: State, d: int, p: int): Set[int] = if (same(st, d, p)) st.holes else derive(st)
  pure def allowed(st: State, d: int, p: int): bool = st.prior != "active" or same(st, d, p)
  pure def safetyOf(st: State): bool = and {
    st.retired.contains(1).implies(st.retired.contains(0)),
    st.holes.intersect(st.retired) == Set(), st.holes.contains(0).implies(st.holes.contains(1)),
    st.checked.implies(st.allowed == allowed(st, st.requestedDecision, st.requestedSource)),
    (st.checked and st.allowed).implies(st.selected == choose(st, st.requestedDecision, st.requestedSource)),
    (st.checked and st.allowed).implies(st.selected.intersect(st.retired) == Set() and
      st.selected.contains(0).implies(st.selected.contains(1))),
  }
  val safety = safetyOf(s)
  val neverFreshSameFloor = not(s.checked and s.prior == "completed" and s.allowed and s.requestedSource != s.source)
  action init = s' = {journal:Set(0, 1), retired:Set(), prior:"none", decision:0, source:0, holes:Set(),
    selected:Set(), checked:false, requestedDecision:0, requestedSource:0, allowed:false}
  action selectIntent(d: int, p: int): bool = s' = s.with("selected", choose(s, d, p)).with("checked", true)
    .with("requestedDecision", d).with("requestedSource", p).with("allowed", allowed(s, d, p))
  action prepare(d: int, p: int): bool = all { allowed(s, d, p), s.prior != "active",
    s' = s.with("prior", "active").with("decision", d).with("source", p)
      .with("holes", choose(s, d, p)).with("checked", false),
  }
  action complete = all { s.prior == "active",
    s' = s.with("prior", "completed").with("retired", s.retired.union(ROWS.exclude(s.holes))).with("checked", false),
  }
  action drain(j: int): bool = all { s.journal.contains(j),
    s' = s.with("journal", s.journal.exclude(Set(j))).with("checked", false),
  }
  action step = any { complete,
    { nondet j = ROWS.oneOf() drain(j) },
    { nondet d = Set(0, 1).oneOf() nondet p = Set(0, 1).oneOf() any { selectIntent(d, p), prepare(d, p) } },
  }
  action unsafeSameFloorReuse(d: int, p: int): bool = all { s.prior != "none",
    s' = s.with("selected", s.holes).with("checked", true)
      .with("requestedDecision", d).with("requestedSource", p).with("allowed", true),
  }
  action unsafeUnclosedSelection = all { s.prior == "none",
    s' = s.with("selected", ROWS.exclude(s.retired).exclude(eligible(s))).with("checked", true).with("allowed", true),
  }
  action unsafeStep = any { step, unsafeUnclosedSelection,
    { nondet d = Set(0, 1).oneOf() nondet p = Set(0, 1).oneOf() unsafeSameFloorReuse(d, p) },
  }
  run reconstructedActiveRetryKeepsOriginalHolesTest = init.then(prepare(0, 0)).then(drain(0)).then(drain(1))
    .then(selectIntent(0, 0)).expect(s.allowed and s.selected == Set(0, 1) and safety)
  run freshSameFloorSourceRederivesHolesTest = init.then(prepare(0, 0)).then(drain(0)).then(drain(1)).then(complete)
    .then(selectIntent(0, 1)).expect(s.allowed and s.selected == Set() and safety)
  run freshSameFloorDecisionRederivesHolesTest = init.then(prepare(0, 0)).then(drain(0)).then(drain(1)).then(complete)
    .then(selectIntent(1, 0)).expect(s.allowed and s.selected == Set() and safety)
  run activeForeignIntentRefusesTest = init.then(prepare(0, 0)).then(selectIntent(0, 1)).expect(not(s.allowed) and safety)
  run replacementWaitsForItsSourceTest = init.then(drain(1)).then(selectIntent(0, 0))
    .expect(s.selected == Set(0, 1) and safety)
  run completedRowsNeverReenterNewSelectionTest = init.then(prepare(0, 0)).then(complete).then(selectIntent(1, 0))
    .expect(s.selected == Set(0, 1) and not(s.selected.contains(2)) and safety)
  run sameFloorReuseCounterexampleTest = init.then(prepare(0, 0)).then(drain(0)).then(drain(1)).then(complete)
    .then(unsafeSameFloorReuse(0, 1)).expect(not(safety))
  run dependencyClosureCounterexampleTest = init.then(drain(1)).then(unsafeUnclosedSelection).expect(not(safety))
}
