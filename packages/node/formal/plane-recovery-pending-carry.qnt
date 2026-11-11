// A receiver's pending ingress across a same-epoch plane recovery.
//
// One author issues a chain w1..wN (wi depends on w(i-1)). Copies reach one receiver (the
// creator, or a member receiving another Writer's moves) over a lossy transport. The receiver
// admits a copy whose parent is admitted (then drains pending rows that became admissible) and
// holds it as pending ingress otherwise (bounded). Its admitted index is durable.
//
// A same-epoch recovery (v3-room recoverSettlementOwner: an ambiguous settlement issue, a
// resumed intent of the current epoch, a creator adoption that finds the room head pending, a
// creator recipient retry) deactivates the live plane and activates a successor of the SAME
// epoch from durable truth. Deactivation clears pending ingress (v3-live deactivateRegistration).
// While no plane is active, an arriving copy has no owner and is lost to the transport.
//
// Rule under test (what the recovery does with the predecessor's pending rows):
//   BASE (current code): they are dropped. The transport considers them delivered, so only a
//     later child naming the row as missing (Track AA "missing" hint) or the creator's periodic
//     repair sweep (one connected peer every 5 s) brings them back; an in-process harness has
//     neither. A row the receiver held is discarded (DROPPED).
//   SOUND (proposal): their exact signed bytes are carried to the successor of the same epoch
//     and re-offered through its ordinary ingress: re-authenticated, deduplicated against the
//     successor's index, admitted when their parent is, held as pending otherwise, refused at
//     the successor's own pending bound (a refused copy is a transport loss, named to repair).
//     Nothing from the predecessor's verdict is trusted. An epoch change carries nothing: rows
//     of a closed epoch outside its cut are the author's settlement work.
//
// In flight: the plane's ingress is a FIFO of asynchronous jobs. A copy the transport handed to
// the predecessor (counted delivered) can still be inside its job when the recovery starts: it
// meets the revoked plane before authentication (v3-live authenticateV3Ingress returns when the
// registration is no longer current), or its verdict lands after deactivation (a received append
// refused because the close actor stopped, "creator issuance maintenance admission was revoked",
// then retained onto the deactivated predecessor). SOUND collects those late rows into the same
// carry (bounded; one refused at the bound is named to repair) and re-offers them to the same-
// epoch successor, also after it is live.
//
// Broken controls:
//   snapshotOnly    - the carry is a snapshot of pending at deactivation; a row in flight is lost;
//   releaseAdmitted - the successor starts without the newest admitted row;
//   trustedCarry    - carried rows enter the successor's index directly, parents unchecked;
//   noDedupe        - a carried row the successor already holds is admitted again;
//   carryAcrossEpoch - an epoch change also carries pending rows into the next epoch.
//
// Properties: exactlyOnce, admittedKept (the admitted index never shrinks), parentsFirst,
// pendingDisjoint, heldNotDropped (a row the receiver held is admitted, pending, carried, or was
// refused at a bound and named to repair - never silently discarded), epochBound, allLand
// (once delivery settles, every issued move is admitted exactly once).
module planeRecoveryPendingCarry {
  pure val NW = 4
  pure val MAX_PENDING = 2
  pure val MAX_LOSSES = 2
  pure val MAX_RECOVERIES = 2

  // Copy states.
  pure val NONE = 0
  pure val FLIGHT = 1
  pure val LOST = 2      // a transport loss, or a copy refused at a bound: repair re-sends it
  pure val ARRIVED = 3   // the receiver holds or held it
  pure val DROPPED = 4   // the receiver held it and discarded it (no repair hint)
  pure val CAPTURED = 5  // inside the receiving plane's ingress FIFO, verdict pending (counted delivered)

  // Receiver phases.
  pure val LIVE = 0
  pure val RECOVERING = 1
  pure val CLOSED = 2

  pure val MOVES = 1.to(NW)

  type Mutants = { dropPending: bool, snapshotOnly: bool, releaseAdmitted: bool, trustedCarry: bool, noDedupe: bool, carryAcrossEpoch: bool }
  pure val SOUND: Mutants = { dropPending: false, snapshotOnly: false, releaseAdmitted: false, trustedCarry: false, noDedupe: false, carryAcrossEpoch: false }
  pure val BASE: Mutants = { ...SOUND, dropPending: true, snapshotOnly: true }

  var issued: int
  var net: int -> int
  var adm: Set[int]
  var admEver: Set[int]
  var admCount: int -> int
  var pend: Set[int]
  var carried: Set[int]
  var fifo: Set[int]     // copies inside the live plane's ingress jobs
  var stale: Set[int]    // copies inside a deactivated predecessor's ingress jobs
  var phase: int
  var losses: int
  var recoveries: int
  var crossEpoch: bool
  var settled: bool
  var mutants: Mutants

  pure def ready(i: int, a: Set[int]): bool = i == 1 or a.contains(i - 1)
  pure def maxOf(s: Set[int]): int = s.fold(0, (m, x) => if (x > m) x else m)

  // Admit i, then drain pending rows that became admissible (in chain order).
  pure def admitDrain(a: Set[int], p: Set[int], c: int -> int, i: int): { a: Set[int], p: Set[int], c: int -> int } =
    range(1, NW + 1).foldl({ a: a.union(Set(i)), p: p.exclude(Set(i)), c: c.set(i, c.get(i) + 1) }, (st, j) =>
      if (st.p.contains(j) and ready(j, st.a)) { a: st.a.union(Set(j)), p: st.p.exclude(Set(j)), c: st.c.set(j, st.c.get(j) + 1) } else st)

  action initWith(mu: Mutants): bool = all {
    issued' = 0, net' = MOVES.mapBy(_ => NONE), adm' = Set(), admEver' = Set(), admCount' = MOVES.mapBy(_ => 0),
    pend' = Set(), carried' = Set(), fifo' = Set(), stale' = Set(), phase' = LIVE, losses' = 0, recoveries' = 0, crossEpoch' = false,
    settled' = false, mutants' = mu,
  }
  action init = initWith(SOUND)
  action initBase = initWith(BASE)
  action initSnapshotOnly = initWith({ ...SOUND, snapshotOnly: true })
  action initReleaseAdmitted = initWith({ ...SOUND, releaseAdmitted: true })
  action initTrustedCarry = initWith({ ...SOUND, trustedCarry: true })
  action initNoDedupe = initWith({ ...SOUND, noDedupe: true })
  action initCarryAcrossEpoch = initWith({ ...SOUND, carryAcrossEpoch: true })

  action keepRest: bool = all { fifo' = fifo, stale' = stale, losses' = losses, recoveries' = recoveries, crossEpoch' = crossEpoch, settled' = settled, mutants' = mutants }

  action issue: bool = all {
    phase != CLOSED, not(settled), issued < NW,
    issued' = issued + 1, net' = net.set(issued + 1, FLIGHT),
    adm' = adm, admEver' = admEver, admCount' = admCount, pend' = pend, carried' = carried, phase' = phase, keepRest,
  }

  action lose(i: int): bool = all {
    phase != CLOSED, not(settled), net.get(i) == FLIGHT, losses < MAX_LOSSES,
    net' = net.set(i, LOST), losses' = losses + 1,
    issued' = issued, adm' = adm, admEver' = admEver, admCount' = admCount, pend' = pend, carried' = carried, phase' = phase,
    fifo' = fifo, stale' = stale, recoveries' = recoveries, crossEpoch' = crossEpoch, settled' = settled, mutants' = mutants,
  }

  // Repair (a missing hint, a refusal hint, or the sweep) re-sends a lost copy. A DROPPED copy
  // has no hint: only the periodic sweep would ask, and an in-process harness has none.
  action repair(i: int): bool = all {
    phase != CLOSED, not(settled), net.get(i) == LOST,
    net' = net.set(i, FLIGHT),
    issued' = issued, adm' = adm, admEver' = admEver, admCount' = admCount, pend' = pend, carried' = carried, phase' = phase, keepRest,
  }

  // Ordinary ingress of one copy of i on the live plane: duplicate, admit (and drain), hold, or
  // refuse at the pending bound (a refused copy is named to repair: LOST).
  pure def offer(a: Set[int], p: Set[int], c: int -> int, n: int -> int, i: int, dedupe: bool):
      { a: Set[int], p: Set[int], c: int -> int, n: int -> int } =
    if (a.contains(i) or p.contains(i))
      { a: a, p: p, c: if (a.contains(i) and not(dedupe)) c.set(i, c.get(i) + 1) else c, n: n }
    else if (ready(i, a)) { val d = admitDrain(a, p, c, i) { a: d.a, p: d.p, c: d.c, n: n } }
    else if (p.size() < MAX_PENDING) { a: a, p: p.union(Set(i)), c: c, n: n }
    else { a: a, p: p, c: c, n: n.set(i, LOST) }

  // A copy arrives. With no active plane (recovering) it has no owner and is lost.
  action deliver(i: int): bool = all {
    phase != CLOSED, not(settled), net.get(i) == FLIGHT,
    if (phase == RECOVERING) all { net' = net.set(i, LOST), adm' = adm, admEver' = admEver, admCount' = admCount, pend' = pend }
    else {
      val r = offer(adm, pend, admCount, net.set(i, ARRIVED), i, true)
      all { net' = r.n, adm' = r.a, admEver' = admEver.union(r.a), admCount' = r.c, pend' = r.p }
    },
    issued' = issued, carried' = carried, phase' = phase, keepRest,
  }

  // A copy enters the live plane's ingress FIFO (the transport counts it delivered).
  action capture(i: int): bool = all {
    phase == LIVE, not(settled), net.get(i) == FLIGHT,
    net' = net.set(i, CAPTURED), fifo' = fifo.union(Set(i)),
    issued' = issued, adm' = adm, admEver' = admEver, admCount' = admCount, pend' = pend, carried' = carried, phase' = phase,
    stale' = stale, losses' = losses, recoveries' = recoveries, crossEpoch' = crossEpoch, settled' = settled, mutants' = mutants,
  }

  // Its job gives the verdict on the plane that captured it, still live.
  action judge(i: int): bool = all {
    phase == LIVE, not(settled), fifo.contains(i),
    fifo' = fifo.exclude(Set(i)),
    val r = offer(adm, pend, admCount, net.set(i, ARRIVED), i, true)
    all { net' = r.n, adm' = r.a, admEver' = admEver.union(r.a), admCount' = r.c, pend' = r.p },
    issued' = issued, carried' = carried, phase' = phase,
    stale' = stale, losses' = losses, recoveries' = recoveries, crossEpoch' = crossEpoch, settled' = settled, mutants' = mutants,
  }

  // A job captured by a deactivated predecessor ends (dropped before authentication, or retained
  // onto the revoked plane). SOUND collects it into the carry (refused at the bound and named to
  // repair: LOST); snapshotOnly loses it with no hint.
  action lateVerdict(i: int): bool = all {
    phase != CLOSED, not(settled), stale.contains(i),
    stale' = stale.exclude(Set(i)),
    if (mutants.snapshotOnly) all { net' = net.set(i, DROPPED), carried' = carried }
    else if (carried.size() < MAX_PENDING) all { net' = net.set(i, ARRIVED), carried' = carried.union(Set(i)) }
    else all { net' = net.set(i, LOST), carried' = carried },
    issued' = issued, adm' = adm, admEver' = admEver, admCount' = admCount, pend' = pend, phase' = phase,
    fifo' = fifo, losses' = losses, recoveries' = recoveries, crossEpoch' = crossEpoch, settled' = settled, mutants' = mutants,
  }

  // A copy the receiver already holds is sent again (a republication, the sweep).
  action duplicate(i: int): bool = all {
    phase != CLOSED, not(settled), net.get(i) == ARRIVED,
    net' = net.set(i, FLIGHT),
    issued' = issued, adm' = adm, admEver' = admEver, admCount' = admCount, pend' = pend, carried' = carried, phase' = phase, keepRest,
  }

  // Same-epoch recovery, part 1: the predecessor is deactivated. SOUND carries its pending rows'
  // exact bytes; BASE drops them.
  action beginRecover: bool = all {
    phase == LIVE, not(settled), recoveries < MAX_RECOVERIES,
    phase' = RECOVERING, recoveries' = recoveries + 1,
    pend' = Set(),
    carried' = if (mutants.dropPending) carried else carried.union(pend),
    net' = MOVES.mapBy(i => if (mutants.dropPending and pend.contains(i)) DROPPED else net.get(i)),
    fifo' = Set(), stale' = stale.union(fifo),
    issued' = issued, adm' = adm, admEver' = admEver, admCount' = admCount,
    losses' = losses, crossEpoch' = crossEpoch, settled' = settled, mutants' = mutants,
  }

  // Part 2: the successor of the same epoch activates from durable truth (the admitted index).
  action endRecover: bool = all {
    phase == RECOVERING,
    phase' = LIVE,
    val durable = if (mutants.releaseAdmitted and adm.size() > 0) adm.exclude(Set(maxOf(adm))) else adm
    if (mutants.trustedCarry) all {
      adm' = durable.union(carried), carried' = Set(), admEver' = admEver.union(durable.union(carried)),
      admCount' = MOVES.mapBy(i => if (carried.contains(i)) admCount.get(i) + 1 else admCount.get(i)),
    } else all { adm' = durable, carried' = carried, admCount' = admCount, admEver' = admEver },
    issued' = issued, net' = net, pend' = pend, keepRest,
  }

  // A carried row re-enters the successor's ordinary ingress (re-authenticated).
  action reoffer(i: int): bool = all {
    phase == LIVE, not(settled), carried.contains(i),
    carried' = carried.exclude(Set(i)),
    val r = offer(adm, pend, admCount, net, i, not(mutants.noDedupe))
    all { net' = r.n, adm' = r.a, admEver' = admEver.union(r.a), admCount' = r.c, pend' = r.p },
    issued' = issued, phase' = phase, keepRest,
  }

  // The epoch closes. Pending rows outside the cut are the author's settlement work in the next
  // epoch (not modelled here); carrying them across would admit a closed epoch's row.
  action epochClose: bool = all {
    phase == LIVE, not(settled),
    phase' = CLOSED,
    crossEpoch' = mutants.carryAcrossEpoch and (pend.union(carried)).size() > 0,
    issued' = issued, net' = net, adm' = adm, admEver' = admEver, admCount' = admCount, pend' = pend, carried' = carried,
    fifo' = fifo, stale' = stale, losses' = losses, recoveries' = recoveries, settled' = settled, mutants' = mutants,
  }

  // Fairness: once recoveries are over and every ingress job has ended, repair and re-offer
  // deliver every outstanding copy in order (a DROPPED copy has no repair hint and stays out).
  action settle: bool = all {
    phase == LIVE, not(settled), fifo == Set(), stale == Set(),
    val reach = MOVES.filter(i => i <= issued and net.get(i) != DROPPED and (net.get(i) != ARRIVED or pend.contains(i) or carried.contains(i)))
    val st = range(1, NW + 1).foldl({ a: adm, c: admCount, stop: false }, (s, i) =>
      if (s.stop or s.a.contains(i)) s
      else if (reach.contains(i)) { a: s.a.union(Set(i)), c: s.c.set(i, s.c.get(i) + 1), stop: false }
      else { ...s, stop: true })
    all {
      adm' = st.a, admCount' = st.c, pend' = pend.exclude(st.a), carried' = carried.exclude(st.a),
      net' = MOVES.mapBy(i => if (st.a.contains(i) and net.get(i) != DROPPED) ARRIVED else net.get(i)),
      settled' = true,
      admEver' = admEver.union(st.a),
    },
    issued' = issued, phase' = phase,
    fifo' = fifo, stale' = stale, losses' = losses, recoveries' = recoveries, crossEpoch' = crossEpoch, mutants' = mutants,
  }

  action stutter: bool = all {
    phase == CLOSED or settled,
    issued' = issued, net' = net, adm' = adm, admEver' = admEver, admCount' = admCount, pend' = pend, carried' = carried,
    phase' = phase, keepRest,
  }

  action step = any {
    issue,
    nondet i = MOVES.oneOf()
    any { lose(i), repair(i), deliver(i), capture(i), judge(i), lateVerdict(i), duplicate(i), reoffer(i) },
    beginRecover,
    endRecover,
    epochClose,
    settle,
    stutter,
  }

  // ---- Invariants ----
  val exactlyOnce: bool = MOVES.forall(i => admCount.get(i) <= 1)
  val admittedKept: bool = admEver.subseteq(adm)
  val parentsFirst: bool = adm.forall(i => ready(i, adm))
  val pendingDisjoint: bool = adm.intersect(pend) == Set()
  val heldNotDropped: bool = MOVES.forall(i => net.get(i) != DROPPED)
  val epochBound: bool = not(crossEpoch)
  val allLand: bool = settled implies MOVES.forall(i => i <= issued implies (adm.contains(i) and admCount.get(i) == 1))
  val safety: bool = exactlyOnce and admittedKept and parentsFirst and pendingDisjoint and epochBound
  val all_: bool = safety and heldNotDropped and allLand

  // ---- Witness tests ----
  // w1 admitted, w2 lost, w3 pending; a same-epoch recovery. SOUND carries w3; after repair
  // re-sends w2, the re-offered w3 lands, each once.
  run carryLandsOnceTest = init
    .then(issue).then(deliver(1))
    .then(issue).then(lose(2))
    .then(issue).then(deliver(3))
    .then(all { assert(pend == Set(3) and adm == Set(1)), beginRecover })
    .then(all { assert(carried == Set(3) and pend == Set()), endRecover })
    .then(reoffer(3))
    .then(all { assert(pend == Set(3)), repair(2) })
    .then(deliver(2))
    .then(all { assert(adm == Set(1, 2, 3) and exactlyOnce and pend == Set()), settle })
    .then(all { assert(all_), stutter })
  // BASE: the recovery drops w3; repair brings w2 back, but nothing names w3 again.
  run baseDropsHeldTest = initBase
    .then(issue).then(deliver(1))
    .then(issue).then(lose(2))
    .then(issue).then(deliver(3))
    .then(beginRecover)
    .then(all { assert(not(heldNotDropped)), endRecover })
    .then(repair(2)).then(deliver(2)).then(settle)
    .then(all { assert(adm == Set(1, 2) and not(allLand)), stutter })
  // A carried row the successor already admitted (another copy arrived) is deduplicated.
  run carriedDuplicateTest = init
    .then(issue).then(lose(1))
    .then(issue).then(deliver(2))
    .then(beginRecover).then(endRecover)
    .then(repair(1)).then(deliver(1))
    .then(duplicate(2)).then(deliver(2))
    .then(all { assert(adm == Set(1, 2) and carried == Set(2)), reoffer(2) })
    .then(all { assert(carried == Set() and exactlyOnce), settle })
  run noDedupeTest = initNoDedupe
    .then(issue).then(lose(1))
    .then(issue).then(deliver(2))
    .then(beginRecover).then(endRecover)
    .then(repair(1)).then(deliver(1))
    .then(duplicate(2)).then(deliver(2))
    .then(reoffer(2))
    .then(all { assert(not(exactlyOnce)), settle })
  run trustedCarryTest = initTrustedCarry
    .then(issue).then(lose(1))
    .then(issue).then(deliver(2))
    .then(beginRecover).then(endRecover)
    .then(all { assert(not(parentsFirst)), repair(1) })
  run releaseAdmittedTest = initReleaseAdmitted
    .then(issue).then(deliver(1))
    .then(beginRecover).then(endRecover)
    .then(all { assert(not(admittedKept)), issue })
  // w1 admitted; w2 captured into the predecessor's FIFO when the recovery starts. Its job ends
  // on the revoked plane after the snapshot; SOUND collects it and the successor admits it.
  run inflightCarriedTest = init
    .then(issue).then(deliver(1))
    .then(issue).then(capture(2))
    .then(all { assert(fifo == Set(2) and pend == Set()), beginRecover })
    .then(all { assert(stale == Set(2) and carried == Set()), endRecover })
    .then(lateVerdict(2))
    .then(all { assert(carried == Set(2)), reoffer(2) })
    .then(all { assert(adm == Set(1, 2) and exactlyOnce), settle })
    .then(all { assert(all_), stutter })
  // snapshotOnly (the first carry): the in-flight w2 is lost with no repair hint.
  run snapshotOnlyDropsInflightTest = initSnapshotOnly
    .then(issue).then(deliver(1))
    .then(issue).then(capture(2))
    .then(beginRecover).then(endRecover)
    .then(lateVerdict(2))
    .then(all { assert(not(heldNotDropped)), settle })
    .then(all { assert(not(allLand)), stutter })
  run carryAcrossEpochTest = initCarryAcrossEpoch
    .then(issue).then(lose(1))
    .then(issue).then(deliver(2))
    .then(epochClose)
    .then(all { assert(not(epochBound)), stutter })
}
