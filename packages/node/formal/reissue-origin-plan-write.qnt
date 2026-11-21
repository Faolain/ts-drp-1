// MODEL (fix/reissue-origins-slow-member 34a36003, track 46): a settlement plan write keeps exactly the
// reissue-origin entries it computed, including none.
//
// A Writer's given-back move is offered again by the application (`reissue`): its row consumes the
// move's hand-back record and adds a reissueOrigins entry (reissueSequence -> origin) in its own issuance
// transaction. The entry is owed until the move settles: the creator's signed frontier admits its
// chain's last carrier (seen by the next plan write), or the move is given back again (its origin then passes to
// the new record in the same write). Every install merges the plan (writeMergedSettlementPlan): it
// computes the entries to keep (settlementWindowHandBacks drops the entry of a move the window gives
// back again; settlementReissueOriginsUnsettled drops the entries the frontier admitted) and writes
// them through mergedSettlementPlan. The refused-replay hand-back (row 97, handBackRefusedReplay) is a
// separate write that drops its move's entry itself.
//
// The backlog V3RoomLocalBacklogFull bounds (settlementBacklogMoves, V3_ROOM_LOCAL_BACKLOG_LIMIT = 64,
// here BOUND) counts every unconsumed record, every reissueOrigins entry (pending on its chain's last
// carrier; creatorReachedOwnSequences is per epoch, so a later epoch never discharges it) and every
// accepted new move until the creator admits it. A new move is refused while the backlog is full.
//
// Variants (`mode`):
//   fixed              34a36003: the write passes {handBacks, reissueOrigins}; an undefined field is
//                      "none", so a write that drops the last entry writes none.
//   keepOldWhenEmpty   before 34a36003: mergedSettlementPlan's trailing default parameter
//                      (reissueOrigins = current?.reissueOrigins) turned "none" (undefined) back into
//                      the current entries, so an entry was dropped only while another one stayed.
//   dropAll            an over-correction: every merge writes no entry (an owed move loses its origin).
//
// Invariants:
//   droppedStaysDropped  an entry a write dropped is never in the plan again (until a new reissue of
//                        that move adds a fresh one);
//   entriesOwed          every entry belongs to a reissued move still owed (not settled, not given back);
//   owedHasEntry         every owed reissued move still has its entry (no over-drop);
//   backlogOwed          the backlog counts only owed work, so stale entries can never fill it.
//   safety = all four.
//
// Commands (packages/node/formal; JAVA_HOME=$(brew --prefix openjdk@17), PATH=$JAVA_HOME/bin:$PATH):
//   quint typecheck reissue-origin-plan-write.qnt
//   quint test reissue-origin-plan-write.qnt --main reissueOriginPlanWrite --match 'Test$'
//   quint verify reissue-origin-plan-write.qnt --main reissueOriginPlanWrite --init init --step step \
//     --backend apalache --apalache-version=0.56.1 --max-steps=8 --invariants safety           # [ok]
//   quint verify ... --init initKeepOldWhenEmpty ... --invariants safety                       # violation
//   quint verify ... --init initDropAll ... --invariants safety                                # violation
//   Simulator: quint run reissue-origin-plan-write.qnt --main reissueOriginPlanWrite --init <init> \
//     --step step --invariant safety --max-samples 20000 --max-steps 12 --seed 11
module reissueOriginPlanWrite {
  pure val MOVES = Set(1, 2)
  pure val BOUND = 2       // V3_ROOM_LOCAL_BACKLOG_LIMIT (64)
  pure val MAX_NEW = 2     // new moves the Writer offers

  var given: Set[int]      // moves with an unconsumed hand-back record (owed to the application)
  var entries: Set[int]    // the plan's reissueOrigins entries, by move
  var owed: Set[int]       // ghost: reissued moves not yet settled or given back again
  var settled: Set[int]    // reissued moves whose last carrier the signed frontier admitted
  var dropped: Set[int]    // ghost: moves whose entry a write dropped (cleared by a new reissue)
  var newLive: int         // accepted new moves the creator has not admitted yet
  var offered: int         // new moves offered so far
  var refusedFull: bool    // a new move was refused at the backlog bound
  var mode: str

  def backlog: int = given.size() + entries.size() + newLive
  def owedUnits: int = given.size() + owed.size() + newLive

  action initWith(m: str): bool = all {
    given' = MOVES, entries' = Set(), owed' = Set(), settled' = Set(), dropped' = Set(),
    newLive' = 0, offered' = 0, refusedFull' = false, mode' = m,
  }
  action init = initWith("fixed")
  action initKeepOldWhenEmpty = initWith("keepOldWhenEmpty")
  action initDropAll = initWith("dropAll")

  action unchangedNew = all { newLive' = newLive, offered' = offered, refusedFull' = refusedFull }
  action unchangedAll = all {
    given' = given, entries' = entries, owed' = owed, settled' = settled, dropped' = dropped,
    unchangedNew, mode' = mode,
  }

  // The application offers a given-back move again: its row consumes the record and adds the entry.
  action reissue(m: int): bool = all {
    given.contains(m),
    given' = given.exclude(Set(m)), entries' = entries.union(Set(m)), owed' = owed.union(Set(m)),
    dropped' = dropped.exclude(Set(m)), settled' = settled, unchangedNew, mode' = mode,
  }

  // An install's plan merge (writeMergedSettlementPlan), reading the creator's signed frontier then:
  // `admit` are owed moves whose chain's last carrier the frontier admitted (settled;
  // settlementReissueOriginsUnsettled drops their entries), `back` are owed moves the window gives back
  // again (a new record each; settlementWindowHandBacks passes the entry to it).
  action planWrite(admit: Set[int], back: Set[int]): bool = all {
    admit.subseteq(owed), back.subseteq(owed), admit.intersect(back).size() == 0,
    val computed = entries.exclude(back).exclude(admit)
    val written =
      if (mode == "keepOldWhenEmpty") (if (computed.size() == 0) entries else computed)
      else if (mode == "dropAll") Set()
      else computed
    all {
      entries' = written,
      dropped' = dropped.union(entries.exclude(computed)),
      given' = given.union(back), owed' = owed.exclude(back).exclude(admit), settled' = settled.union(admit),
    },
    unchangedNew, mode' = mode,
  }

  // Row 97's refused-replay hand-back: its own write drops the move's entry (every variant).
  action refusedReplayHandBack(m: int): bool = all {
    owed.contains(m),
    entries' = entries.exclude(Set(m)), dropped' = dropped.union(entries.intersect(Set(m))),
    given' = given.union(Set(m)), owed' = owed.exclude(Set(m)), settled' = settled, unchangedNew, mode' = mode,
  }

  // The application declines a given-back move: the record is dropped.
  action decline(m: int): bool = all {
    given.contains(m), given' = given.exclude(Set(m)),
    entries' = entries, owed' = owed, settled' = settled, dropped' = dropped, unchangedNew, mode' = mode,
  }

  // A new move: accepted while the backlog has room, else refused (V3RoomLocalBacklogFull).
  action newMove: bool = all {
    offered < MAX_NEW, offered' = offered + 1,
    newLive' = if (backlog < BOUND) newLive + 1 else newLive,
    refusedFull' = if (refusedFull) true else backlog >= BOUND,
    given' = given, entries' = entries, owed' = owed, settled' = settled, dropped' = dropped, mode' = mode,
  }
  // The creator admits an accepted new move: it leaves the backlog.
  action creatorAdmitsNew: bool = all {
    newLive > 0, newLive' = newLive - 1, offered' = offered, refusedFull' = refusedFull,
    given' = given, entries' = entries, owed' = owed, settled' = settled, dropped' = dropped, mode' = mode,
  }

  action step = any {
    nondet m = MOVES.oneOf()
    any { reissue(m), refusedReplayHandBack(m), decline(m) },
    nondet admit = MOVES.powerset().oneOf()
    nondet back = MOVES.powerset().oneOf()
    planWrite(admit, back),
    newMove, creatorAdmitsNew,
  }

  val droppedStaysDropped = entries.intersect(dropped).size() == 0
  val entriesOwed = entries.subseteq(owed)
  val owedHasEntry = owed.subseteq(entries)
  val backlogOwed = backlog == owedUnits
  val safety = droppedStaysDropped and entriesOwed and owedHasEntry and backlogOwed

  // Witnesses (violated = reachable in the fixed variant).
  val noRefusalAtBound = not(refusedFull)
  val noLastEntryDropped = not(entries.size() == 0 and dropped.size() > 0)

  // The slow-member failure in two moves: both reissued, both admitted by the frontier. A write drops
  // one while the other stays (every variant), then the last one (only the fix writes none).
  run lastEntryDroppedTest = init.then(reissue(1)).then(reissue(2))
    .then(planWrite(Set(1), Set())).then(all { assert(entries == Set(2) and safety), planWrite(Set(2), Set()) })
    .then(all { assert(entries == Set() and safety and backlog == 0), newMove })
    .then(all { assert(newLive == 1 and not(refusedFull)), unchangedAll })
  run keepOldStuckTest = initKeepOldWhenEmpty.then(reissue(1)).then(reissue(2))
    .then(planWrite(Set(1), Set())).then(all { assert(entries == Set(2) and safety), planWrite(Set(2), Set()) })
    .then(all { assert(entries == Set(2) and not(entriesOwed) and not(droppedStaysDropped) and backlog == 1), newMove })
    // One new move is owed, yet the stale entry fills the bound: the next new move is refused.
    .then(all { assert(owedUnits == 1 and newLive == 1 and backlog == BOUND), newMove })
    .then(all { assert(refusedFull and not(backlogOwed)), unchangedAll })
  // The only entry's move given back again by the window: the trap keeps the entry beside its new record.
  run keepOldGivenBackAgainTest = initKeepOldWhenEmpty.then(reissue(1)).then(planWrite(Set(), Set(1)))
    .then(all { assert(entries == Set(1) and given.contains(1) and not(entriesOwed) and backlog == 3), unchangedAll })
  run fixedGivenBackAgainTest = init.then(reissue(1)).then(planWrite(Set(), Set(1)))
    .then(all { assert(entries == Set() and given == MOVES and safety), unchangedAll })
  run dropAllLosesOriginTest = initDropAll.then(reissue(1)).then(planWrite(Set(), Set()))
    .then(all { assert(owed == Set(1) and not(owedHasEntry)), unchangedAll })
}
