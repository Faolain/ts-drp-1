// PROPOSAL MODEL (not implemented): which change removes the carried path of a member move.
//
// A member move is CARRIED when its row reaches the creator after the creator's seal cut of the
// row's anchor epoch: the creator refuses it (ingress admits only the current anchor), the member
// learns at its install of the successor that the row is in no cut (displaced), and settles it by
// a REPLACEMENT row in its new epoch (the carried path: seal -> install -> replacement -> delivery
// -> admission, measured p50 2.9-10 s against 0.05-0.21 s for a live move) or, past the settlement
// window, by EXPIRY (the move is handed back to the application). Both settlements rest on one
// lemma, displacedNeverAdmitted: a row whose anchor epoch closed without it is never admitted.
//
// Variants (rule, fixed at init):
//   SHIPPED  the shipped rules.
//   A1       (a) first half: the creator's seal cut first applies every row it already received
//            for the closing epoch (a scheduling order; no validity rule changes).
//   A2       (a) second half: the creator admits a row anchored to a closed epoch into its current
//            epoch when the row is valid there (a validity rule change).
//   A2GUARD  A2 plus creator-side arbitration: a late row is admitted only if no replacement of
//            it was admitted, and a replacement only if its source was not.
//   HOLD     (b) reframed without a rule change: once the member has seen the creator's seal notice
//            for its epoch it holds new moves (the presentation overlay still shows them at once)
//            and issues them on the successor after its install, the hold the room already applies
//            during an install (adoptionHoldsIssues), started at the notice instead of the install.
//            Rows signed before the notice keep the shipped path.
//
// Properties: exactlyOnce (a move is admitted at most once), noLandAfterGiveBack (a handed-back
// move is never admitted), displacedNeverAdmitted (the settlement lemma). Witnesses (expected to be
// violated, i.e. reachable): carriedWitness (the carried path exists), heldLandsWitness (HOLD: a held
// move is signed on the successor and admitted). A held move can still be carried by a LATER seal
// (one that starts before the member hears of it), like any move; the hold only ensures no move is
// signed against an epoch whose seal the member has already heard of.
module carriedMovePath {
  pure val SHIPPED = 0
  pure val A1 = 1
  pure val A2 = 2
  pure val A2GUARD = 3
  pure val HOLD = 4

  pure val MAX_MOVES = 3
  pure val MAX_EPOCH = 3
  pure val NONE = -1

  // A member row: the application move it carries, its anchor epoch, and its settlement source
  // (NONE for an original row, else the id of the displaced row it replaces).
  type Row = { move: int, anchor: int, source: int }

  var rule: int
  var memberEpoch: int
  var creatorEpoch: int
  var sealing: bool               // the creator took the seal cut of creatorEpoch; successor unpublished
  var noticeSeen: bool            // HOLD: the member saw the seal notice for its epoch
  var rows: int -> Row            // member rows by id (the id is the member's author sequence)
  var nextId: int
  var nextMove: int
  var inflight: Set[int]          // sent, not yet at the creator
  var queued: Set[int]            // received by the creator, not yet applied
  var admitted: Set[int]          // rows the creator admitted
  var admittedInto: int -> int    // admitted row -> the creator epoch it was admitted into
  var cut: int -> Set[int]        // epoch -> rows in its seal cut
  var settled: Set[int]           // rows the member settled as displaced (replaced or expired)
  var givenBack: Set[int]         // moves handed back to the application
  var held: Set[int]              // HOLD: moves waiting for the install
  var heldOrigin: Set[int]        // HOLD: moves that were ever held
  var carried: Set[int]           // moves that took the carried path

  action initWith(v: int): bool = all {
    rule' = v, memberEpoch' = 0, creatorEpoch' = 0, sealing' = false, noticeSeen' = false,
    rows' = Map(), nextId' = 0, nextMove' = 0, inflight' = Set(), queued' = Set(), admitted' = Set(),
    admittedInto' = Map(),
    cut' = Map(), settled' = Set(), givenBack' = Set(), held' = Set(), heldOrigin' = Set(), carried' = Set(),
  }
  action initShipped = initWith(SHIPPED)
  action initA1 = initWith(A1)
  action initA2 = initWith(A2)
  action initA2Guard = initWith(A2GUARD)
  action initHold = initWith(HOLD)

  action unchangedCreator = all {
    creatorEpoch' = creatorEpoch, sealing' = sealing, admitted' = admitted, cut' = cut, queued' = queued,
    admittedInto' = admittedInto,
  }

  def admittedMove(m: int): Set[int] = admitted.filter(id => rows.get(id).move == m)
  // The original row of a replacement chain (chains are at most MAX_EPOCH links long).
  def root(id: int): int =
    0.to(MAX_EPOCH).fold(id, (cur, _i) => if (rows.get(cur).source == NONE) cur else rows.get(cur).source)
  // Some row of the same replacement chain was admitted.
  def chainAdmitted(id: int): bool = admitted.exists(a => root(a) == root(id))

  // The member signs a new move against its epoch, or holds it (HOLD, after the notice).
  action issue = all {
    nextMove < MAX_MOVES,
    nextMove' = nextMove + 1,
    if (rule == HOLD and noticeSeen) all {
      held' = held.union(Set(nextMove)), heldOrigin' = heldOrigin.union(Set(nextMove)),
      rows' = rows, nextId' = nextId, inflight' = inflight,
    } else all {
      rows' = rows.put(nextId, { move: nextMove, anchor: memberEpoch, source: NONE }),
      nextId' = nextId + 1, inflight' = inflight.union(Set(nextId)), held' = held, heldOrigin' = heldOrigin,
    },
    unchangedCreator,
    memberEpoch' = memberEpoch, noticeSeen' = noticeSeen, settled' = settled, givenBack' = givenBack,
    carried' = carried, rule' = rule,
  }

  action deliver = all {
    inflight.size() > 0,
    nondet id = inflight.oneOf()
    all {
      inflight' = inflight.exclude(Set(id)), queued' = queued.union(Set(id)),
      creatorEpoch' = creatorEpoch, sealing' = sealing, admitted' = admitted, cut' = cut,
      admittedInto' = admittedInto,
      rows' = rows, nextId' = nextId, nextMove' = nextMove, memberEpoch' = memberEpoch,
      noticeSeen' = noticeSeen, settled' = settled, givenBack' = givenBack, held' = held,
      heldOrigin' = heldOrigin, carried' = carried, rule' = rule,
    }
  }

  // The creator applies one received row: admits or refuses (a refused row is dropped; the member
  // settles it at its install).
  action apply = all {
    queued.size() > 0,
    nondet id = queued.oneOf()
    val r = rows.get(id)
    val current = r.anchor == creatorEpoch and not(sealing)
    val late = r.anchor < creatorEpoch and not(sealing)
    val admitIt =
      if (rule == A2) current or late
      else if (rule == A2GUARD) (current or late) and not(chainAdmitted(id))
      else current
    all {
      queued' = queued.exclude(Set(id)),
      admitted' = if (admitIt) admitted.union(Set(id)) else admitted,
      admittedInto' = if (admitIt) admittedInto.put(id, creatorEpoch) else admittedInto,
      creatorEpoch' = creatorEpoch, sealing' = sealing, cut' = cut,
      rows' = rows, nextId' = nextId, nextMove' = nextMove, inflight' = inflight, memberEpoch' = memberEpoch,
      noticeSeen' = noticeSeen, settled' = settled, givenBack' = givenBack, held' = held,
      heldOrigin' = heldOrigin, carried' = carried, rule' = rule,
    }
  }

  // The creator's seal cut of its epoch. A1: rows already received for the epoch are applied first.
  action sealStart = all {
    not(sealing), creatorEpoch < MAX_EPOCH,
    rule != A1 or queued.forall(id => rows.get(id).anchor != creatorEpoch),
    sealing' = true,
    cut' = cut.put(creatorEpoch, admitted.filter(id => admittedInto.get(id) == creatorEpoch)),
    creatorEpoch' = creatorEpoch, admitted' = admitted, queued' = queued, admittedInto' = admittedInto,
    rows' = rows, nextId' = nextId, nextMove' = nextMove, inflight' = inflight, memberEpoch' = memberEpoch,
    noticeSeen' = noticeSeen, settled' = settled, givenBack' = givenBack, held' = held,
    heldOrigin' = heldOrigin, carried' = carried, rule' = rule,
  }

  // HOLD: the member sees the creator's seal notice for its own epoch.
  action seeNotice = all {
    rule == HOLD, sealing, memberEpoch == creatorEpoch, not(noticeSeen),
    noticeSeen' = true,
    unchangedCreator,
    rows' = rows, nextId' = nextId, nextMove' = nextMove, inflight' = inflight, memberEpoch' = memberEpoch,
    settled' = settled, givenBack' = givenBack, held' = held, heldOrigin' = heldOrigin, carried' = carried,
    rule' = rule,
  }

  action publish = all {
    sealing,
    sealing' = false, creatorEpoch' = creatorEpoch + 1,
    admitted' = admitted, cut' = cut, queued' = queued, admittedInto' = admittedInto,
    rows' = rows, nextId' = nextId, nextMove' = nextMove, inflight' = inflight, memberEpoch' = memberEpoch,
    noticeSeen' = noticeSeen, settled' = settled, givenBack' = givenBack, held' = held,
    heldOrigin' = heldOrigin, carried' = carried, rule' = rule,
  }

  // The member installs the next published epoch.
  action install = all {
    memberEpoch < creatorEpoch,
    memberEpoch' = memberEpoch + 1, noticeSeen' = false,
    unchangedCreator,
    rows' = rows, nextId' = nextId, nextMove' = nextMove, inflight' = inflight,
    settled' = settled, givenBack' = givenBack, held' = held, heldOrigin' = heldOrigin, carried' = carried,
    rule' = rule,
  }

  // Settlement of one own row whose anchor epoch the member saw closed without it (displaced):
  // replaced in the member's epoch (carried) or expired (handed back). The member decides from the
  // cut alone: it cannot observe a later creator admission.
  def displacedRows: Set[int] = rows.keys().filter(id =>
    rows.get(id).anchor < memberEpoch and not(settled.contains(id)) and
    not(cut.get(rows.get(id).anchor).contains(id)))
  action settle = all {
    displacedRows.size() > 0,
    nondet id = displacedRows.oneOf()
    nondet expire = Set(true, false).oneOf()
    val m = rows.get(id).move
    all {
      settled' = settled.union(Set(id)),
      if (expire) all {
        givenBack' = givenBack.union(Set(m)), rows' = rows, nextId' = nextId, inflight' = inflight,
        carried' = carried,
      } else all {
        rows' = rows.put(nextId, { move: m, anchor: memberEpoch, source: id }), nextId' = nextId + 1,
        inflight' = inflight.union(Set(nextId)), carried' = carried.union(Set(m)), givenBack' = givenBack,
      },
      unchangedCreator,
      nextMove' = nextMove, memberEpoch' = memberEpoch, noticeSeen' = noticeSeen, held' = held,
      heldOrigin' = heldOrigin, rule' = rule,
    }
  }

  // HOLD: after the install, a held move is signed on the member's new epoch.
  action releaseHeld = all {
    held.size() > 0, not(noticeSeen),
    nondet m = held.oneOf()
    all {
      held' = held.exclude(Set(m)),
      rows' = rows.put(nextId, { move: m, anchor: memberEpoch, source: NONE }), nextId' = nextId + 1,
      inflight' = inflight.union(Set(nextId)),
      unchangedCreator,
      nextMove' = nextMove, memberEpoch' = memberEpoch, noticeSeen' = noticeSeen, settled' = settled,
      givenBack' = givenBack, heldOrigin' = heldOrigin, carried' = carried, rule' = rule,
    }
  }

  action step = any { issue, deliver, apply, sealStart, seeNotice, publish, install, settle, releaseHeld }

  val exactlyOnce = 0.to(MAX_MOVES - 1).forall(m => admittedMove(m).size() <= 1)
  val noLandAfterGiveBack = givenBack.forall(m => admittedMove(m).size() == 0)
  val displacedNeverAdmitted = settled.forall(id => not(admitted.contains(id)))
  val safe = exactlyOnce and noLandAfterGiveBack and displacedNeverAdmitted
  // Witness (expected to be violated): the carried path is reachable.
  val carriedWitness = carried.size() == 0
  // Witness (expected to be violated under HOLD): a move is held and later admitted live.
  val heldLandsWitness = not(heldOrigin.exists(m => admittedMove(m).size() > 0))
}

