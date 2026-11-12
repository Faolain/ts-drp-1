// Adjunct to journal-retirement.qnt (design for sign-off, not yet native law): retire a closed
// journal's detail in row-level PARTIAL prefixes that each fit the journal observation carrier.
//
// Today the classifier collects whole-scope prefixes only (a scope whose rows were not all read is
// retained as "unclassified-prefix") and a drain plan carries every collectible row's frame. Near a
// full journal (J close to the carrier cap C) no whole scope fits beside J, so the drain cannot start.
// Here a drain episode selects, deterministically from its pre-drain base, the longest run of
// eligible rows (per scope a prefix by sequence; scopes in order) whose plan width fits the budget
// C - J - c; the plan's highWatermark per scope is the last selected sequence (below the scope's own).
// Readiness keeps J + c + RESERVE <= C (RESERVE = the widest single row's plan width), so any
// episode with an eligible row selects at least one. Retired rows leave the base of the next episode.
//
// Finite abstraction: rows are (scope, sequence); a row's carrier width w and plan width w + 1 (frame
// + metadata). authentic stands for the authenticated closed-membership / covered-historical class
// of that row (signatures, native transactions and byte encodings are premises, not modelled);
// covered stands for throughEpoch - 2 coverage plus member progress. Absence is never evidence: a
// row is eligible only by its own authentic class and its scope's coverage, and a scope's prefix
// stops at its first row that is not eligible.
module journalPartialPrefixDrain {
  type Row = { scope:int, seq:int }
  type Pick = { taken:List[Row], used:int, stopped:Set[int], full:bool }
  type State = {
    mode:str, journal:Set[Row], appended:Set[Row], retired:Set[Row], count:Row -> int,
    covered:Set[int], authentic:Set[Row], active:bool, plan:List[Row], base:Set[Row], cursor:int,
    crashed:bool, mismatch:bool, refused:bool, maxCarrier:int, maxClassifier:int, episodes:int }
  var s:State

  pure val C = 12        // the carrier's encode cap
  pure val OVERHEAD = 1  // control + image beside the rows
  pure val RESERVE = 3   // the widest single row's plan width (w <= 2, metadata 1)
  // The successor's mandatory fence quote checks J + FENCE_HORIZON + c <= C (its fence, the next successor's
  // header and that successor's fence). Readiness reserves exactly that horizon; it covers the drain reserve.
  pure val FENCE_HORIZON = 3
  pure val CURRENT = 2   // the open epoch's scope: never covered
  pure val ALL:List[Row] = [
    {scope:0,seq:0},{scope:0,seq:1},{scope:0,seq:2},
    {scope:1,seq:0},{scope:1,seq:1},{scope:1,seq:2},
    {scope:2,seq:0},{scope:2,seq:1},{scope:2,seq:2}]
  pure val ROWS:Set[Row] = ALL.foldl(Set(), (acc, r) => acc.union(Set(r)))
  pure val EMPTY_PICK:Pick = {taken:List(), used:0, stopped:Set(), full:false}
  pure def max2(a:int, b:int):int = if (a >= b) a else b
  pure def w(r:Row):int = 1 + r.seq % 2
  pure def pw(r:Row):int = w(r) + 1
  pure def width(rows:Set[Row]):int = rows.fold(0, (acc, r) => acc + w(r))
  pure def planWidth(p:List[Row]):int = p.foldl(0, (acc, r) => acc + pw(r))
  pure def planSet(p:List[Row]):Set[Row] = p.foldl(Set(), (acc, r) => acc.union(Set(r)))
  pure def eligible(covered:Set[int], authentic:Set[Row], r:Row):bool =
    covered.contains(r.scope) and authentic.contains(r)

  // The ONE selection law: deterministic in (base, covered, authentic). Its budget comes from the
  // base itself, so a resume over the reconstructed base reproduces it exactly. The classifier's
  // result is this list: bounded by the budget, never every collectible row.
  pure def pickPrefix(base:Set[Row], covered:Set[int], authentic:Set[Row], budget:int, checkClass:bool):List[Row] =
    ALL.foldl(EMPTY_PICK, (acc, r) =>
      if (not(base.contains(r)) or acc.full or acc.stopped.contains(r.scope)) acc
      else if (not(covered.contains(r.scope)) or (checkClass and not(authentic.contains(r))))
        acc.with("stopped", acc.stopped.union(Set(r.scope)))
      else if (acc.used + pw(r) > budget) acc.with("full", true)
      else acc.with("taken", acc.taken.append(r)).with("used", acc.used + pw(r))).taken
  pure def budgetOf(base:Set[Row]):int = C - width(base) - OVERHEAD
  // Mutant "ineligible": the selection skips the authentic-class check.
  def selection(st:State, base:Set[Row]):List[Row] =
    pickPrefix(base, st.covered, st.authentic, budgetOf(base), st.mode != "ineligible")
  // Mutant "residual": resume re-selects over the CURRENT residual journal, not the base.
  def resumeSelection(st:State):List[Row] = if (st.mode == "residual") selection(st, st.journal) else selection(st, st.base)
  def carrier(st:State):int = width(st.journal) + (if (st.active) planWidth(st.plan) else 0) + OVERHEAD

  // A near-cap journal: scopes 0 and 1 hold 8 of the 8 bytes readiness allows (C - OVERHEAD - RESERVE).
  action initWith(mode:str):bool = {
    val start = ROWS.filter(r => r.scope != CURRENT)
    s' = { mode:mode, journal:start, appended:start, retired:Set(), count:ROWS.mapBy(r => 0),
      covered:Set(0), authentic:ROWS.exclude(Set({scope:1,seq:2})), active:false, plan:List(),
      base:Set(), cursor:0, crashed:false, mismatch:false, refused:false,
      maxCarrier:width(start) + OVERHEAD, maxClassifier:0, episodes:0 }
  }
  action init = initWith("healthy")
  action initResidualMutant = initWith("residual")
  action initIneligibleMutant = initWith("ineligible")
  // Mutant "shortReserve": readiness reserves less than the fence horizon (only the current close's rows, as
  // before j22): an admitted append leaves the mandatory fence refused.
  action initShortReserveMutant = initWith("shortReserve")
  def reserveOf(st:State):int = if (st.mode == "shortReserve") FENCE_HORIZON - 1 else FENCE_HORIZON

  // Readiness: an ordinary append keeps J + c + RESERVE <= C; none while a drain is active.
  action appendRow(r:Row):bool = s' =
    if (not(s.crashed) and not(s.active) and r.scope == CURRENT and not(s.appended.contains(r)) and
      ROWS.forall(q => (q.scope == r.scope and q.seq < r.seq).implies(s.appended.contains(q))) and
      width(s.journal) + w(r) + OVERHEAD + reserveOf(s) <= C)
      s.with("journal", s.journal.union(Set(r))).with("appended", s.appended.union(Set(r)))
    else s.with("refused", true)
  action cover = s' = s.with("covered", s.covered.union(Set(1)))
  action begin = {
    val picked = selection(s, s.journal)
    s' = if (not(s.crashed) and not(s.active) and picked.length() > 0)
      s.with("active", true).with("plan", picked).with("base", s.journal).with("cursor", 0)
        .with("episodes", s.episodes + 1)
        .with("maxCarrier", max2(s.maxCarrier, width(s.journal) + planWidth(picked) + OVERHEAD))
        .with("maxClassifier", max2(s.maxClassifier, planWidth(picked)))
      else s.with("refused", true)
  }
  // One durable batch: the next planned row leaves the journal atomically with the cursor.
  action batch = s' =
    if (not(s.crashed) and s.active and not(s.mismatch) and s.cursor < s.plan.length()) {
      val r = s.plan[s.cursor]
      val after = s.journal.exclude(Set(r))
      s.with("journal", after).with("retired", s.retired.union(Set(r)))
        .with("count", s.count.set(r, s.count.get(r) + 1)).with("cursor", s.cursor + 1)
        .with("maxCarrier", max2(s.maxCarrier, width(after) + planWidth(s.plan) + OVERHEAD))
    } else s.with("refused", true)
  action finish = s' =
    if (not(s.crashed) and s.active and not(s.mismatch) and s.cursor == s.plan.length())
      s.with("active", false).with("plan", List()).with("base", Set()).with("cursor", 0)
    else s.with("refused", true)
  action crash = s' = s.with("crashed", true)
  // Reopen: the base is the adapter's reconstruction (residual + the plan's retired frames); the
  // resume equality re-selects and must find exactly the persisted plan, or refuse (no progress).
  action reopen = s' =
    if (s.crashed) s.with("crashed", false).with("mismatch", s.mismatch or (s.active and resumeSelection(s) != s.plan))
    else s.with("refused", true)
  action stutter = s' = s
  action step = {
    nondet r = ROWS.oneOf()
    any { appendRow(r), cover, begin, batch, finish, crash, reopen, stutter }
  }

  // No row retired before it is eligible (its own authentic class and its scope's coverage).
  val noIneligibleRetired = s.retired.forall(r => eligible(s.covered, s.authentic, r))
  // Exactly once: never retired twice, never both retained and retired, never lost.
  val exactlyOnce = ROWS.forall(r => s.count.get(r) <= 1) and s.journal.intersect(s.retired) == Set() and
    s.journal.union(s.retired) == s.appended
  // A crash or reopen at any batch reproduces the same selection.
  val resumeReproduces = not(s.mismatch)
  // Every carrier the drain holds (residual + plan + overhead) and the classifier's result fit the cap.
  val carrierBound = s.maxCarrier <= C and s.maxClassifier <= C
  // Liveness core: between episodes, an eligible row reachable as a scope prefix is always selected.
  val reachable = s.journal.filter(r => eligible(s.covered, s.authentic, r) and
    s.journal.forall(q => (q.scope == r.scope and q.seq < r.seq).implies(eligible(s.covered, s.authentic, q))))
  val progress = (not(s.active) and not(s.crashed) and not(s.mismatch) and reachable != Set())
    .implies(selection(s, s.journal).length() > 0)
  // The reserve equals the fence horizon: the successor's mandatory fence always fits, and so does a drain.
  val readinessBound = width(s.journal) + OVERHEAD + FENCE_HORIZON <= C and FENCE_HORIZON >= RESERVE
  val safety = noIneligibleRetired and exactlyOnce and resumeReproduces and carrierBound and progress and readinessBound

  // Deterministic drain loop for the run tests: finish, else batch, else begin.
  action drive = if (s.active and s.cursor == s.plan.length()) finish else if (s.active) batch else begin

  // Retirable: scope 0 whole, scope 1 up to its unauthentic third row (retained, never evidence).
  pure val RETIRABLE:Set[Row] = Set({scope:0,seq:0},{scope:0,seq:1},{scope:0,seq:2},{scope:1,seq:0},{scope:1,seq:1})
  run nearCapJournalDrainsAcrossEpisodesTest = init.then(cover).then(20.reps(_ => drive))
    .expect(safety and not(s.active) and reachable == Set() and s.retired == RETIRABLE and s.episodes >= 3)
  run crashMidDrainReopenCompletesTest = init.then(cover).then(begin).then(batch).then(crash).then(reopen)
    .then(20.reps(_ => drive)).expect(safety and s.retired == RETIRABLE)
  run appendsResumeAfterDrainTest = init.then(cover).then(20.reps(_ => drive))
    .then(appendRow({scope:2,seq:0})).then(appendRow({scope:2,seq:1})).expect(safety and s.journal.contains({scope:2,seq:1}))
  run nearCapAppendRefusedTest = init.then(appendRow({scope:2,seq:0})).expect(s.refused and safety)
  // Mutant: resume re-selects over the residual journal (a bigger budget): the plan differs.
  run residualSelectionMutantTest = initResidualMutant.then(cover).then(begin).then(batch).then(crash).then(reopen)
    .expect(not(resumeReproduces))
  run shortReserveMutantTest = initShortReserveMutant.then(appendRow({scope:2,seq:0})).expect(not(readinessBound))
  // Mutant: the selection skips the authentic class: an ineligible row is retired.
  run ineligibleRetirementMutantTest = initIneligibleMutant.then(cover).then(30.reps(_ => drive))
    .expect(not(noIneligibleRetired))
}
