// A Writer's own settlement across creator epochs when its rows stop reaching the
// creator: the settlement window (v3-live V3_SETTLEMENT_OWN_WINDOW_EPOCHS), handing
// undelivered moves back to the app, and the read-only state while the creator is
// unreachable. Sibling of member-successor-install.qnt (which models one install's
// steps; here an install is one atomic catch-up to the creator's latest offer).
//
// Facts the model takes from the code:
//   - Ingress admits a row only under the receiver's current anchor
//     (extractAuthorizedV3Vertex expectedAnchor; live routeV3Ingress and retained
//     repair routeV3RetainedIngress both pass enqueueV3Ingress -> authenticateV3Ingress),
//     and an install takes closed-epoch rows only through the signed cut. So a row
//     is admitted only while its epoch is the creator's current epoch.
//   - An install catches up to the creator's latest offer directly (the creator serves
//     only its latest successor; measured: a Writer at 2 installed 6).
//   - At an install the Writer classifies each of its unsettled rows from closed epochs
//     against the creator's cut. FIXED: a row is treated as never admitted only when
//     fence-guarded (settlementOwnRowFenceGuarded), so the classification is the truth.
//   - A displaced move is replaced in the new epoch (plan entry replacementSequence,
//     same logical move, new row) while its origin epoch is inside the window; at the
//     bound its plan entry becomes "expire": no replacement is ever signed for it
//     (the drain's eligible() excludes expire), and its operations go back to the app
//     (V3RoomSettlementStatus.undelivered -> the rollover policy's kept moves).
//   - Protected journal scopes: the epochs from the Writer's oldest unsettled own
//     settlement (its last admitted fence, or an unsettled move's origin) to its
//     current epoch. The journal retirement refuses above LIVE_JOURNAL_RETIREMENT_LIMITS.maxScopes
//     (7): "journal retirement refused: malformed-input", and the session closes.
//     FIXED: an install expires settlement older than the window (signed exclusion),
//     so at most D epochs stay protected.
//   - Read-only: while the creator is unreachable (successor channel without the
//     creator), the policy refuses a new move (V3RoomReadOnly) and the app keeps it.
//
// Connectivity: "up" (offers and rows flow), "silent" (offers flow, the Writer's rows
// never reach the creator: the native silent-Writer case), "down" (the creator is
// unreachable). Any row the Writer ever signed may still be delivered later, in any
// order, while the link is up (a relay copy, a late original).
//
// Variants:
//   fixed      the design;
//   c08        the code at c08d8680: no window (moves re-replaced every install, settlement
//              never expires), no read-only state; the journal refuses at 8 scopes and
//              the session closes;
//   premature  hands a move back while its row may still be admitted (its epoch still
//              open): a reissue races the original;
//   gap        classifies without the fence guard: a committed row above a frontier gap
//              may be read as displaced and expired or replaced;
//   retained   the code at 94d117ca (and c08d8680): an install more than one epoch ahead
//              retains the Writer's current rows as unknown work ("manual-review") that
//              nothing resolves, and the author fence stays withheld.
module settlementWindow {
  pure val D = 4            // V3_SETTLEMENT_OWN_WINDOW_EPOCHS
  pure val MAX_SCOPES = 7   // LIVE_JOURNAL_RETIREMENT_LIMITS.maxScopes
  pure val MAX_EPOCH = 9
  pure val MAX_OUTAGES = 2
  pure val MOVES = Set(0)   // run.sh also checks safety with two moves (MAX_EPOCH 7)
  pure val NONE = -1

  var creatorEpoch: int
  var writerEpoch: int
  var link: str                    // up | silent | down
  var outages: int
  var ownSettled: int              // own settlement complete through this epoch
  var fenceEpoch: int              // the epoch of the Writer's last fence the creator admitted
  var moveState: int -> str        // idle | app (held by the app) | flight (a plan chain) | retained | done
  var activeEpoch: int -> int      // the chain's current row
  var activeGen: int -> int
  var origin: int -> int           // the chain's first row's epoch
  var gen: int -> int
  var published: Set[(int, int, int)]  // signed rows the creator could still admit: (move, epoch, gen)
  var admitted: Set[(int, int, int)]   // rows the creator admitted
  var closed: bool                 // the session closed (journal retirement refused)
  var mode: str

  pure def max(a: int, b: int): int = if (a > b) a else b
  pure def min(a: int, b: int): int = if (a < b) a else b
  // The oldest epoch whose own settlement is still held (protected), given the chains.
  // Retained work does not hold its journal scope: its source context (trust, ACL,
  // blueprint, parameters) authenticates the row without it.
  pure def oldestHeld(states: int -> str, origins: int -> int, settled: int): int =
    MOVES.filter(m => states.get(m) == "flight").fold(settled + 1, (acc, m) => min(acc, origins.get(m)))
  pure def scopesOf(epoch: int, states: int -> str, origins: int -> int, settled: int): int =
    max(0, epoch - oldestHeld(states, origins, settled) + 1)

  def row(m: int): (int, int, int) = (m, activeEpoch.get(m), activeGen.get(m))
  def displacedAt(m: int, misread: Set[int]): bool =
    moveState.get(m) == "flight" and (not(admitted.contains(row(m))) or (mode == "gap" and misread.contains(m)))
  def expiresAt(m: int, e: int): bool = mode != "c08" and origin.get(m) <= e - D

  action initWith(v: str): bool = all {
    creatorEpoch' = 0, writerEpoch' = 0, link' = "up", outages' = 0, ownSettled' = 0, fenceEpoch' = NONE,
    moveState' = MOVES.mapBy(m => "app"), activeEpoch' = MOVES.mapBy(m => NONE),
    activeGen' = MOVES.mapBy(m => NONE), origin' = MOVES.mapBy(m => NONE), gen' = MOVES.mapBy(m => 0),
    published' = Set(), admitted' = Set(), closed' = false, mode' = v,
  }
  action init = initWith("fixed")
  action initC08 = initWith("c08")
  action initPremature = initWith("premature")
  action initRetained = initWith("retained")
  action initGap = initWith("gap")

  action keepWriter = all {
    writerEpoch' = writerEpoch, ownSettled' = ownSettled, fenceEpoch' = fenceEpoch, moveState' = moveState,
    activeEpoch' = activeEpoch, activeGen' = activeGen, origin' = origin, gen' = gen, published' = published,
    closed' = closed, mode' = mode,
  }

  // The creator closes its epoch and adopts the next one (independently of the Writer).
  // Rows of the closed epoch can never be admitted again (deliver admits only under the
  // current epoch); they are dropped from the network state, which removes no behavior
  // and keeps the state space small enough for TLC.
  action creatorAdvance: bool = all {
    creatorEpoch < MAX_EPOCH, creatorEpoch' = creatorEpoch + 1, link' = link, outages' = outages,
    admitted' = admitted, published' = published.filter(r => r._2 > creatorEpoch),
    writerEpoch' = writerEpoch, ownSettled' = ownSettled, fenceEpoch' = fenceEpoch, moveState' = moveState,
    activeEpoch' = activeEpoch, activeGen' = activeGen, origin' = origin, gen' = gen, closed' = closed, mode' = mode,
  }
  // Connectivity drops (bounded) and returns.
  action drop(target: str): bool = all {
    link == "up", outages < MAX_OUTAGES, link' = target, outages' = outages + 1, creatorEpoch' = creatorEpoch,
    admitted' = admitted, keepWriter,
  }
  action outage: bool = any { drop("silent"), drop("down") }
  action reconnect: bool = all {
    link != "up", link' = "up", outages' = outages, creatorEpoch' = creatorEpoch, admitted' = admitted, keepWriter,
  }
  // The app wants another move.
  action wantMove(m: int): bool = {
    all {
      moveState.get(m) == "idle", moveState' = moveState.set(m, "app"),
      creatorEpoch' = creatorEpoch, link' = link, outages' = outages, admitted' = admitted,
      writerEpoch' = writerEpoch, ownSettled' = ownSettled, fenceEpoch' = fenceEpoch, activeEpoch' = activeEpoch,
      activeGen' = activeGen, origin' = origin, gen' = gen, published' = published, closed' = closed,
      mode' = mode,
    }
  }
  // The Writer issues a move the app holds, in its current epoch. FIXED: refused while
  // the creator is unreachable (read-only; the app keeps it).
  action issueMove(m: int): bool = {
    val g = gen.get(m) + 1
    all {
      not(closed), moveState.get(m) == "app", mode == "c08" or link != "down",
      moveState' = moveState.set(m, "flight"), activeEpoch' = activeEpoch.set(m, writerEpoch),
      activeGen' = activeGen.set(m, g), origin' = origin.set(m, writerEpoch), gen' = gen.set(m, g),
      published' = published.union(Set((m, writerEpoch, g))),
      creatorEpoch' = creatorEpoch, link' = link, outages' = outages, admitted' = admitted,
      writerEpoch' = writerEpoch, ownSettled' = ownSettled, fenceEpoch' = fenceEpoch, closed' = closed,
      mode' = mode,
    }
  }
  // A signed row reaches the creator's ingress: admitted only under the current anchor.
  action deliver: bool = {
    val deliverable = published.filter(r => r._2 == creatorEpoch and not(admitted.contains(r)))
    nondet r = deliverable.oneOf()
    all {
      link == "up", deliverable.contains(r), admitted' = admitted.union(Set(r)),
      creatorEpoch' = creatorEpoch, link' = link, outages' = outages, keepWriter,
    }
  }
  // The Writer's settlement fence for its current epoch reaches the creator.
  val fenceWithheld = MOVES.exists(m => moveState.get(m) == "retained")
  // Withheld while unknown retained work remains (v3-room: "unknown retained work still
  // withholds the author fence").
  action fence: bool = all {
    not(closed), link == "up", writerEpoch == creatorEpoch, fenceEpoch < writerEpoch,
    not(fenceWithheld),
    fenceEpoch' = writerEpoch,
    creatorEpoch' = creatorEpoch, link' = link, outages' = outages, admitted' = admitted,
    writerEpoch' = writerEpoch, ownSettled' = ownSettled, moveState' = moveState, activeEpoch' = activeEpoch,
    activeGen' = activeGen, origin' = origin, gen' = gen, published' = published, closed' = closed,
    mode' = mode,
  }
  // The Writer installs the creator's latest offer (checkpoint catch-up) and settles its
  // own rows from the closed epochs against the creator's cut. An install more than one
  // epoch ahead (a skip: the Writer missed offers, e.g. while the creator was unreachable)
  // has no received close for its own epoch: its current rows are retained as unknown
  // accepted work (retainCreatorAcceptedSourceCustody, "manual-review" with a source
  // context), neither replaced nor expired by the window.
  action installWith(misread: Set[int]): bool = {
    val e = creatorEpoch
    val skip = e > writerEpoch + 1
    val retaining = if (skip) MOVES.filter(m => moveState.get(m) == "flight") else Set()
    val settledNow = MOVES.filter(m => moveState.get(m) == "flight" and not(skip) and not(displacedAt(m, misread)))
    val expiring = MOVES.filter(m => not(skip) and displacedAt(m, misread) and expiresAt(m, e))
    val rebasing = MOVES.filter(m => not(skip) and displacedAt(m, misread) and not(expiresAt(m, e)))
    val states = MOVES.mapBy(m =>
      if (retaining.contains(m)) "retained"
      else if (settledNow.contains(m)) "done" else if (expiring.contains(m)) "app" else moveState.get(m))
    val origins = MOVES.mapBy(m => if (settledNow.contains(m) or expiring.contains(m)) NONE else origin.get(m))
    val settled = max(max(ownSettled, fenceEpoch), if (mode == "c08") ownSettled else e - D)
    all {
      not(closed), link != "down", writerEpoch < creatorEpoch, mode == "gap" or misread == Set(),
      writerEpoch' = e, ownSettled' = settled, moveState' = states, origin' = origins,
      activeEpoch' = MOVES.mapBy(m =>
        if (rebasing.contains(m)) e
        else if (states.get(m) != "flight" and states.get(m) != "retained") NONE else activeEpoch.get(m)),
      activeGen' = MOVES.mapBy(m => if (rebasing.contains(m)) gen.get(m) + 1 else activeGen.get(m)),
      gen' = MOVES.mapBy(m => if (rebasing.contains(m)) gen.get(m) + 1 else gen.get(m)),
      published' = published.union(rebasing.map(m => (m, e, gen.get(m) + 1))),
      // The journal retirement preparation holds every protected scope; above the
      // limit it refuses and the session closes.
      closed' = scopesOf(e, states, origins, settled) > MAX_SCOPES,
      creatorEpoch' = creatorEpoch, link' = link, outages' = outages, fenceEpoch' = fenceEpoch,
      admitted' = admitted, mode' = mode,
    }
  }
  action install: bool = {
    nondet misread = MOVES.powerset().oneOf()
    installWith(misread)
  }
  // FIXED (and premature, gap): retained work is resolved from the creator's signed frontier
  // in the installed checkpoint. Its epoch is closed; the frontier settled the row (it was
  // committed: done) or proves it was never admitted (fence-guarded displaced: the move goes
  // back to the app). RETAINED (the broken control) and c08 leave it manual-review.
  def canResolve(m: int): bool =
    mode != "retained" and mode != "c08" and not(closed) and moveState.get(m) == "retained" and activeEpoch.get(m) < writerEpoch
  action resolveMove(m: int): bool = all {
    canResolve(m),
    val committed = admitted.contains(row(m))
    all {
      moveState' = moveState.set(m, if (committed) "done" else "app"),
      activeEpoch' = activeEpoch.set(m, NONE), origin' = origin.set(m, NONE),
    },
    creatorEpoch' = creatorEpoch, link' = link, outages' = outages, admitted' = admitted,
    writerEpoch' = writerEpoch, ownSettled' = ownSettled, fenceEpoch' = fenceEpoch, activeGen' = activeGen,
    gen' = gen, published' = published, closed' = closed, mode' = mode,
  }
  // PREMATURE only: hands a move back at the early signal while its row's epoch may
  // still be open at the creator.
  action prematureHandBackMove(m: int): bool = {
    all {
      mode == "premature", not(closed), moveState.get(m) == "flight", activeEpoch.get(m) == writerEpoch,
      moveState' = moveState.set(m, "app"), activeEpoch' = activeEpoch.set(m, NONE), origin' = origin.set(m, NONE),
      creatorEpoch' = creatorEpoch, link' = link, outages' = outages, admitted' = admitted,
      writerEpoch' = writerEpoch, ownSettled' = ownSettled, fenceEpoch' = fenceEpoch, activeGen' = activeGen,
      gen' = gen, published' = published, closed' = closed, mode' = mode,
    }
  }

  action issue: bool = { nondet m = MOVES.oneOf() issueMove(m) }
  action want: bool = { nondet m = MOVES.oneOf() wantMove(m) }
  action prematureHandBack: bool = { nondet m = MOVES.oneOf() prematureHandBackMove(m) }
  action resolve: bool = { nondet m = MOVES.oneOf() resolveMove(m) }

  action step = any {
    creatorAdvance, outage, reconnect, want, issue, deliver, fence, install, prematureHandBack, resolve,
  }

  // Safety.
  val scopes = scopesOf(writerEpoch, moveState, origin, ownSettled)
  val scopesBounded = scopes <= MAX_SCOPES
  def appliedCount(m: int): int = admitted.filter(r => r._1 == m).size()
  // Each logical move is applied at most once across its original, its replacements and
  // its reissues, whatever order the rows arrive in.
  val atMostOnce = MOVES.forall(m => appliedCount(m) <= 1)
  def isActive(r: (int, int, int)): bool =
    (moveState.get(r._1) == "flight" or moveState.get(r._1) == "retained") and activeEpoch.get(r._1) == r._2 and
      activeGen.get(r._1) == r._3
  // A row the Writer retired (replaced, expired or handed back) and the creator did not
  // admit lies in a closed epoch: no ingress path can admit it later.
  val retiredUnadmittable = published.forall(r => isActive(r) or admitted.contains(r) or r._2 < creatorEpoch)
  // The re-replacement is bounded by the window: a chain spans at most D epochs.
  val chainBounded = MOVES.forall(m => moveState.get(m) != "flight" or activeEpoch.get(m) - origin.get(m) <= D - 1)
  val safety = scopesBounded and atMostOnce and retiredUnadmittable and chainBounded and not(closed)

  // Liveness: under weak fairness of connectivity returning and of the Writer's own
  // steps and deliveries, every move the app wants is eventually applied by the creator
  // (the Writer writes again). The model has no explicit terminal refusal: the session
  // closing (c08) is the defect, not an allowed terminal.
  def wanting(m: int): bool = moveState.get(m) == "app" or moveState.get(m) == "flight" or moveState.get(m) == "retained"
  def applied(m: int): bool = admitted.exists(r => r._1 == m)
  val vars = (creatorEpoch, writerEpoch, link, outages, ownSettled, fenceEpoch, moveState, activeEpoch, activeGen,
    origin, gen, published, admitted, closed, mode)
  temporal writerWritesAgain =
    (weakFair(reconnect, vars) and weakFair(install, vars) and weakFair(issue, vars) and weakFair(deliver, vars)
      and weakFair(fence, vars) and weakFair(resolve, vars))
    implies always(wanting(0) implies eventually(applied(0)))

  // Witnesses.
  action silentFor(n: int): bool = n.reps(_ => creatorAdvance.then(installWith(Set())))
  // A Writer silent for 9 epochs with a move in flight: at most D scopes, the move handed
  // back at the bound, the chain never longer than D, and on reconnect it is applied once.
  run silentWriterTest = init.then(issueMove(0)).then(drop("silent")).then(silentFor(9))
    .then(all { assert(writerEpoch == 9 and safety and scopes <= D and moveState.get(0) == "app" and appliedCount(0) == 0), reconnect })
    .then(issueMove(0)).then(deliver)
    .then(all { assert(appliedCount(0) == 1 and safety), fence })
  // c08d8680: the eighth epoch without the Writer's settlement closes the session.
  // (A move unsettled since epoch 0 holds epoch 0 too: the seventh silent install closes it.)
  run c08DiesTest = initC08.then(issueMove(0)).then(drop("silent"))
    .then(silentFor(6)).then(all { assert(scopes == 7 and not(closed)), creatorAdvance }).then(installWith(Set()))
    .then(all { assert(closed and scopes == 8 and not(scopesBounded)), reconnect })
  // A move in flight while the creator is unreachable, then a skip install: the move is
  // retained, resolved from the frontier (never admitted: given back) and applied once.
  run inFlightSkipTest = init.then(creatorAdvance).then(installWith(Set())).then(issueMove(0)).then(drop("down"))
    .then(creatorAdvance).then(creatorAdvance).then(creatorAdvance)
    .then(reconnect).then(installWith(Set()))
    .then(all { assert(writerEpoch == 4 and moveState.get(0) == "retained" and fenceWithheld), resolveMove(0) })
    .then(all { assert(moveState.get(0) == "app" and appliedCount(0) == 0), issueMove(0) }).then(deliver)
    .then(all { assert(appliedCount(0) == 1 and safety), fence })
  // 94d117ca: the retained move is never resolved, so it is never applied and no fence goes out.
  run retainedStuckTest = initRetained.then(creatorAdvance).then(installWith(Set())).then(issueMove(0))
    .then(drop("down")).then(creatorAdvance).then(creatorAdvance).then(creatorAdvance).then(reconnect)
    .then(installWith(Set()))
    .then(all { assert(moveState.get(0) == "retained" and not(canResolve(0)) and fenceWithheld and not(applied(0))), creatorAdvance })
  // A premature reissue: the original and the reissue are both admitted.
  run prematureDoubleTest = initPremature.then(issueMove(0)).then(prematureHandBackMove(0)).then(issueMove(0)).then(deliver).then(deliver)
    .then(all { assert(appliedCount(0) == 2 and not(atMostOnce)), creatorAdvance })
  // Without the fence guard: an admitted row read as displaced is replaced and admitted again.
  run gapDoubleTest = initGap.then(issueMove(0)).then(deliver).then(creatorAdvance)
    .then(installWith(Set(0))).then(deliver)
    .then(all { assert(appliedCount(0) == 2 and not(atMostOnce)), creatorAdvance })
}
