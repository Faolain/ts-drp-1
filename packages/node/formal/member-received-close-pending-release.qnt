// A member's received close while it still holds pending ingress, and an admissible
// row retained after a transient maintenance refusal.
//
// One Writer issues a chain w1..wN (wi depends on w(i-1)). Copies reach the creator
// and a member over a lossy transport. The member admits a copy when its parents are
// admitted (then drains pending rows that became admissible), holds it as pending
// ingress otherwise (bounded), and a transient maintenance refusal (stale settlement
// preview, revoked admission) may also retain an admissible copy. The creator closes
// the epoch at its admitted index (the cut). The member then begins its received close
// (creator-adoption beginReceived) and installs the successor, whose snapshot carries
// the cut. Moves outside the cut are re-offered by their author in the successor epoch
// (settlement hand-back) and admitted there; lost copies are fetched again by repair.
//
// The received close's recovery dependency hold requires an empty pending ingress
// (v3-live captureCreatorRecoveryRuntime: non-active observation). That rule stays.
//
// Rule under test (what beginReceived does with pending ingress):
//   BASE (current code): keep the pending rows. The hold is then unavailable, the
//     install fails and the member must recover by a fresh install (stranded).
//   SOUND (proposal): release every pending row at beginReceived, the same clear the
//     hot handoff already applies at the successor (v3-live hot handoff), only earlier.
//     A released copy counts as lost for the closing plane; the successor snapshot or
//     the author's re-offer delivers the move.
// Retained-admissible rows (the issuance census refusal, v3-live census): SOUND lets
//   the row stay a pending root until a drain admits it (resume after every maintenance
//   job, and the census carries it); BASE refuses the creator's next issue.
// Broken controls: releaseAdmitted (the release also drops an admitted row),
//   noDedupe (a re-offer of a move the successor already holds is admitted again),
//   noReoffer (the author never re-offers a move outside the cut).
//
// Properties: exactlyOnce (no move is admitted twice in the successor), releaseKeeps
// Admitted (the release never removes an admitted row of the closing plane), noStrand
// (the install never fails on pending ingress), allLand (once the successor settles,
// every issued move is in it exactly once), pendingDisjoint, noAdmissibleRefusal.
module memberReceivedClosePendingRelease {
  pure val NW = 4
  pure val MAX_PENDING = 2
  pure val MAX_LOSSES = 3

  pure val NONE = 0
  pure val FLIGHT = 1
  pure val LOST = 2
  pure val ARRIVED = 3

  // Member phases.
  pure val LIVE = 0
  pure val CLOSING = 1
  pure val INSTALLED = 2
  pure val FAILED = 3

  pure val WRITERS = 1.to(NW)

  type Mutants = { keepPending: bool, releaseAdmitted: bool, noDedupe: bool, noReoffer: bool, refuseAdmissible: bool }
  pure val SOUND: Mutants = { keepPending: false, releaseAdmitted: false, noDedupe: false, noReoffer: false, refuseAdmissible: false }
  pure val BASE: Mutants = { ...SOUND, keepPending: true, refuseAdmissible: true }

  var wIssued: int
  var cAdm: Set[int]           // creator's admitted index (closing epoch)
  var closed: bool
  var cut: Set[int]
  var net: int -> int          // member copy state (closing epoch)
  var mAdm: Set[int]           // member's admitted index (closing epoch)
  var mPend: Set[int]          // member's pending ingress
  var mAdmAtBegin: Set[int]
  var phase: int
  var losses: int
  var refusedIssue: int        // creator issues refused because of an admissible retained row
  var succ: Set[int]           // member's successor index (snapshot + admitted re-offers)
  var succCount: int -> int    // successor admissions per move
  var reoffer: int -> int      // re-offer copy state in the successor
  var settled: bool
  var mutants: Mutants

  pure def ready(i: int, adm: Set[int]): bool = i == 1 or adm.contains(i - 1)

  pure def drainStep(st: { adm: Set[int], pend: Set[int] }, i: int): { adm: Set[int], pend: Set[int] } =
    if (st.pend.contains(i) and ready(i, st.adm)) { adm: st.adm.union(Set(i)), pend: st.pend.exclude(Set(i)) } else st
  pure def drain(st: { adm: Set[int], pend: Set[int] }): { adm: Set[int], pend: Set[int] } =
    range(1, NW + 1).foldl(st, (acc, i) => drainStep(acc, i))

  action initWith(mu: Mutants): bool = all {
    wIssued' = 0, cAdm' = Set(), closed' = false, cut' = Set(),
    net' = WRITERS.mapBy(_ => NONE), mAdm' = Set(), mPend' = Set(), mAdmAtBegin' = Set(), phase' = LIVE,
    losses' = 0, refusedIssue' = 0, succ' = Set(), succCount' = WRITERS.mapBy(_ => 0),
    reoffer' = WRITERS.mapBy(_ => NONE), settled' = false, mutants' = mu,
  }
  action init = initWith(SOUND)
  action initBase = initWith(BASE)
  action initReleaseAdmitted = initWith({ ...SOUND, releaseAdmitted: true })
  action initNoDedupe = initWith({ ...SOUND, noDedupe: true })
  action initNoReoffer = initWith({ ...SOUND, noReoffer: true })

  action unchangedSucc: bool = all { succ' = succ, succCount' = succCount, reoffer' = reoffer, settled' = settled }

  action writerIssue: bool = all {
    not(closed), wIssued < NW,
    wIssued' = wIssued + 1, net' = net.set(wIssued + 1, FLIGHT),
    cAdm' = cAdm, closed' = closed, cut' = cut, mAdm' = mAdm, mPend' = mPend, mAdmAtBegin' = mAdmAtBegin, phase' = phase,
    losses' = losses, refusedIssue' = refusedIssue, mutants' = mutants, unchangedSucc,
  }

  // The creator admits the Writer's next move (its own transport is not modelled).
  action creatorAdmit(i: int): bool = all {
    not(closed), i <= wIssued, not(cAdm.contains(i)), ready(i, cAdm),
    cAdm' = cAdm.union(Set(i)),
    wIssued' = wIssued, closed' = closed, cut' = cut, net' = net, mAdm' = mAdm, mPend' = mPend, mAdmAtBegin' = mAdmAtBegin,
    phase' = phase, losses' = losses, refusedIssue' = refusedIssue, mutants' = mutants, unchangedSucc,
  }

  action lose(i: int): bool = all {
    phase == LIVE, net.get(i) == FLIGHT, losses < MAX_LOSSES,
    net' = net.set(i, LOST), losses' = losses + 1,
    wIssued' = wIssued, cAdm' = cAdm, closed' = closed, cut' = cut, mAdm' = mAdm, mPend' = mPend, mAdmAtBegin' = mAdmAtBegin,
    phase' = phase, refusedIssue' = refusedIssue, mutants' = mutants, unchangedSucc,
  }

  action repair(i: int): bool = all {
    phase == LIVE, net.get(i) == LOST, not(mAdm.contains(i)), not(mPend.contains(i)),
    net' = net.set(i, FLIGHT),
    wIssued' = wIssued, cAdm' = cAdm, closed' = closed, cut' = cut, mAdm' = mAdm, mPend' = mPend, mAdmAtBegin' = mAdmAtBegin,
    phase' = phase, losses' = losses, refusedIssue' = refusedIssue, mutants' = mutants, unchangedSucc,
  }

  // A copy reaches the member's live plane. `transient`: the maintenance capture is
  // refused (stale preview / revoked admission) and the admissible copy is retained.
  action deliver(i: int, transient: bool): bool = all {
    phase == LIVE, net.get(i) == FLIGHT,
    val known = mAdm.contains(i) or mPend.contains(i)
    val room = mPend.size() < MAX_PENDING
    if (known) all { net' = net.set(i, ARRIVED), mAdm' = mAdm, mPend' = mPend }
    else if (ready(i, mAdm) and not(transient)) {
      val st = drain({ adm: mAdm.union(Set(i)), pend: mPend })
      all { net' = net.set(i, ARRIVED), mAdm' = st.adm, mPend' = st.pend }
    } else if (room) all { net' = net.set(i, ARRIVED), mAdm' = mAdm, mPend' = mPend.union(Set(i)) }
    else all { net' = net.set(i, LOST), mAdm' = mAdm, mPend' = mPend },
    wIssued' = wIssued, cAdm' = cAdm, closed' = closed, cut' = cut, mAdmAtBegin' = mAdmAtBegin, phase' = phase,
    losses' = losses, refusedIssue' = refusedIssue, mutants' = mutants, unchangedSucc,
  }

  // A maintenance job ends (or a local issue starts): pending ingress is drained.
  action resume: bool = all {
    phase == LIVE, not(mutants.refuseAdmissible),
    val st = drain({ adm: mAdm, pend: mPend })
    all { mAdm' = st.adm, mPend' = st.pend },
    wIssued' = wIssued, cAdm' = cAdm, closed' = closed, cut' = cut, net' = net, mAdmAtBegin' = mAdmAtBegin, phase' = phase,
    losses' = losses, refusedIssue' = refusedIssue, mutants' = mutants, unchangedSucc,
  }

  // The plane's own issue: its census must not refuse an admissible retained row.
  action ownIssue: bool = all {
    phase == LIVE,
    val admissible = mPend.exists(i => ready(i, mAdm))
    all {
      refusedIssue' = if (admissible and mutants.refuseAdmissible) refusedIssue + 1 else refusedIssue,
      val st = if (mutants.refuseAdmissible) { adm: mAdm, pend: mPend } else drain({ adm: mAdm, pend: mPend })
      all { mAdm' = st.adm, mPend' = st.pend },
    },
    wIssued' = wIssued, cAdm' = cAdm, closed' = closed, cut' = cut, net' = net, mAdmAtBegin' = mAdmAtBegin, phase' = phase,
    losses' = losses, mutants' = mutants, unchangedSucc,
  }

  action creatorClose: bool = all {
    not(closed),
    closed' = true, cut' = cAdm,
    wIssued' = wIssued, cAdm' = cAdm, net' = net, mAdm' = mAdm, mPend' = mPend, mAdmAtBegin' = mAdmAtBegin, phase' = phase,
    losses' = losses, refusedIssue' = refusedIssue, mutants' = mutants, unchangedSucc,
  }

  // beginReceived: SOUND releases every pending row (copies count as lost).
  action beginReceived: bool = all {
    closed, phase == LIVE,
    phase' = CLOSING, mAdmAtBegin' = mAdm,
    mPend' = if (mutants.keepPending) mPend else Set(),
    // Broken control: the release also drops the newest admitted row.
    mAdm' = if (mutants.releaseAdmitted and mAdm.size() > 0) mAdm.exclude(Set(WRITERS.filter(i => mAdm.contains(i)).fold(0, (a, b) => if (b > a) b else a))) else mAdm,
    net' = WRITERS.mapBy(i => if (not(mutants.keepPending) and mPend.contains(i)) LOST else net.get(i)),
    wIssued' = wIssued, cAdm' = cAdm, closed' = closed, cut' = cut, losses' = losses, refusedIssue' = refusedIssue,
    mutants' = mutants, unchangedSucc,
  }

  // The received recovery hold requires an empty pending ingress; otherwise the install fails.
  action install: bool = all {
    phase == CLOSING,
    if (mPend.size() > 0) all { phase' = FAILED, succ' = succ, succCount' = succCount, reoffer' = reoffer }
    else all {
      phase' = INSTALLED, succ' = cut, succCount' = WRITERS.mapBy(i => if (cut.contains(i)) 1 else 0),
      // The author re-offers every move outside the cut (hand-back); broken control: none.
      reoffer' = WRITERS.mapBy(i => if (i <= wIssued and not(cut.contains(i)) and not(mutants.noReoffer)) FLIGHT else NONE),
    },
    settled' = settled,
    wIssued' = wIssued, cAdm' = cAdm, closed' = closed, cut' = cut, net' = net, mAdm' = mAdm, mPend' = mPend,
    mAdmAtBegin' = mAdmAtBegin, losses' = losses, refusedIssue' = refusedIssue, mutants' = mutants,
  }

  // A duplicate copy of a move the successor already holds arrives (the cut's own
  // copies stay in authors' outboxes and repair streams).
  action duplicate(i: int): bool = all {
    phase == INSTALLED, succ.contains(i), reoffer.get(i) != FLIGHT,
    reoffer' = reoffer.set(i, FLIGHT),
    succ' = succ, succCount' = succCount, settled' = settled,
    wIssued' = wIssued, cAdm' = cAdm, closed' = closed, cut' = cut, net' = net, mAdm' = mAdm, mPend' = mPend,
    mAdmAtBegin' = mAdmAtBegin, phase' = phase, losses' = losses, refusedIssue' = refusedIssue, mutants' = mutants,
  }

  // A re-offered copy is admitted in the successor once its parent is there.
  action succAdmit(i: int): bool = all {
    phase == INSTALLED, reoffer.get(i) == FLIGHT, ready(i, succ),
    val present = succ.contains(i)
    all {
      succ' = succ.union(Set(i)),
      succCount' = if (present and not(mutants.noDedupe)) succCount else succCount.set(i, succCount.get(i) + 1),
    },
    reoffer' = reoffer.set(i, ARRIVED), settled' = settled,
    wIssued' = wIssued, cAdm' = cAdm, closed' = closed, cut' = cut, net' = net, mAdm' = mAdm, mPend' = mPend,
    mAdmAtBegin' = mAdmAtBegin, phase' = phase, losses' = losses, refusedIssue' = refusedIssue, mutants' = mutants,
  }

  // Fairness: repair and re-offer eventually deliver every outstanding copy in order.
  action settle: bool = all {
    phase == INSTALLED, not(settled),
    val outstanding = WRITERS.filter(i => reoffer.get(i) == FLIGHT and not(succ.contains(i)))
    all {
      succ' = succ.union(outstanding),
      succCount' = WRITERS.mapBy(i => if (outstanding.contains(i)) succCount.get(i) + 1 else succCount.get(i)),
      reoffer' = WRITERS.mapBy(i => if (outstanding.contains(i)) ARRIVED else reoffer.get(i)),
    },
    settled' = true,
    wIssued' = wIssued, cAdm' = cAdm, closed' = closed, cut' = cut, net' = net, mAdm' = mAdm, mPend' = mPend,
    mAdmAtBegin' = mAdmAtBegin, phase' = phase, losses' = losses, refusedIssue' = refusedIssue, mutants' = mutants,
  }

  action stutter: bool = all {
    phase == FAILED or settled,
    wIssued' = wIssued, cAdm' = cAdm, closed' = closed, cut' = cut, net' = net, mAdm' = mAdm, mPend' = mPend,
    mAdmAtBegin' = mAdmAtBegin, phase' = phase, losses' = losses, refusedIssue' = refusedIssue, mutants' = mutants,
    unchangedSucc,
  }

  action step = any {
    writerIssue,
    nondet i = WRITERS.oneOf()
    nondet transient = Set(true, false).oneOf()
    any { creatorAdmit(i), lose(i), repair(i), deliver(i, transient), duplicate(i), succAdmit(i) },
    resume,
    ownIssue,
    creatorClose,
    beginReceived,
    install,
    settle,
    stutter,
  }

  // ---- Invariants ----
  val exactlyOnce: bool = WRITERS.forall(i => succCount.get(i) <= 1)
  val releaseKeepsAdmitted: bool = (phase == CLOSING or phase == INSTALLED) implies mAdmAtBegin.subseteq(mAdm)
  val noStrand: bool = phase != FAILED
  val allLand: bool = settled implies WRITERS.forall(i => i <= wIssued implies (succ.contains(i) and succCount.get(i) == 1))
  val pendingDisjoint: bool = mAdm.intersect(mPend) == Set()
  val noAdmissibleRefusal: bool = refusedIssue == 0
  val safety: bool = exactlyOnce and releaseKeepsAdmitted and pendingDisjoint
  val all_: bool = safety and noStrand and allLand and noAdmissibleRefusal

  // ---- Witness tests ----
  // w1 admitted, w2 lost, w3 pending; the creator closed at {1, 2}. SOUND releases w3:
  // it lands once through the author's re-offer, w2 through the snapshot.
  run releaseLandsOnceTest = init
    .then(writerIssue).then(creatorAdmit(1)).then(deliver(1, false))
    .then(writerIssue).then(creatorAdmit(2)).then(lose(2))
    .then(writerIssue).then(deliver(3, false))
    .then(all { assert(mPend == Set(3) and mAdm == Set(1)), creatorClose })
    .then(beginReceived)
    .then(all { assert(mPend == Set() and mAdm == Set(1)), install })
    .then(all { assert(phase == INSTALLED and succ == Set(1, 2) and reoffer.get(3) == FLIGHT), succAdmit(3) })
    .then(all { assert(succ == Set(1, 2, 3) and exactlyOnce), settle })
    .then(all { assert(all_), stutter })
  run baseStrandsTest = initBase
    .then(writerIssue).then(creatorAdmit(1)).then(deliver(1, false))
    .then(writerIssue).then(lose(2))
    .then(writerIssue).then(deliver(3, false))
    .then(creatorClose).then(beginReceived).then(install)
    .then(all { assert(not(noStrand)), stutter })
  // A transient refusal retains an admissible w1. BASE refuses the next own issue; SOUND drains it.
  run baseRefusesAdmissibleTest = initBase
    .then(writerIssue).then(deliver(1, true))
    .then(all { assert(mPend == Set(1)), ownIssue })
    .then(all { assert(not(noAdmissibleRefusal)), creatorClose })
  run soundDrainsAdmissibleTest = init
    .then(writerIssue).then(deliver(1, true))
    .then(all { assert(mPend == Set(1)), ownIssue })
    .then(all { assert(mAdm == Set(1) and mPend == Set() and noAdmissibleRefusal), creatorClose })
  run releaseAdmittedTest = initReleaseAdmitted
    .then(writerIssue).then(creatorAdmit(1)).then(deliver(1, false))
    .then(creatorClose).then(beginReceived)
    .then(all { assert(not(releaseKeepsAdmitted)), install })
  run noDedupeTest = initNoDedupe
    .then(writerIssue).then(creatorAdmit(1)).then(deliver(1, false))
    .then(creatorClose).then(beginReceived).then(install).then(duplicate(1)).then(succAdmit(1))
    .then(all { assert(not(exactlyOnce)), settle })
  run noReofferTest = initNoReoffer
    .then(writerIssue).then(creatorAdmit(1)).then(deliver(1, false))
    .then(writerIssue).then(deliver(2, false))
    .then(creatorClose).then(beginReceived).then(install).then(settle)
    .then(all { assert(not(allLand)), stutter })
}
