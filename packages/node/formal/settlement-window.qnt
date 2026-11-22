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
//              nothing resolves, and the author fence stays withheld;
//   volatile   the hand-back at 1803f975: listed from the plan's expired entry while that
//              entry (and its row) is retained, taken by the app into memory, and never
//              consumed by the reissue.
//   strict     the frontier rule at 1803f975..201dc4db: a retained row is proven committed only
//              while no own fence follows it. A row the Writer signed before its epoch's fence
//              (a move issued between an install and that epoch's fence, or the first row before
//              the first fence) that the creator admitted stays manual-review forever, so the
//              author fence stays withheld and nothing later is ever proven (slow Writer test).
//
// Fence closure (fix/silent-writer-catchup): a fence follows every own row signed before it in
// its epoch (a local issue depends on the plane's tips), so its admission admits them; the fence
// is modelled as delivered with its issue (a fence signed but never admitted while an earlier row
// of its epoch was admitted is not modelled, and the code leaves that row manual-review).
//
// Hand-back custody and crashes (fix/silent-writer-catchup, item 2). A move given back
// ("given") is recorded: FIXED in a durable hand-back record in the settlement plan, written
// in the same transaction as the expiry or frontier resolution that gives it back, which
// survives row pruning and is consumed only by the issuance transaction that writes the
// reissued row (the plan effect "hand-back"). VOLATILE derives the listing from the expired
// entry ("derived"): retirement removes it with the row, and a reissue does not consume it.
// The app takes a listed move into memory ("app", owed); a crash drops the app's memory and
// the room lists again whatever its record still holds.
//
// Record bound and backlog (fix/silent-writer-catchup, conservation). The plan holds at most
// SETTLEMENT_HAND_BACK_LIMITS.maxRecords hand-back records (REC_CAP here). An accepted move is
// never expired without a record or a terminal admission (noSilentExpire): FIXED keeps a move
// whose record does not fit live (the merge leaves it rebase, replaced again next install) until
// a record is free; its chain's rows older than the window still retire (the past-window pruner drains
// displaced fence-guarded rows whatever the plan says, and a completed entry leaves with its source),
// so it holds no scope older than the window: modelled as its origin pinned at the window bound
// (measured: of 65 moves accepted in one silent epoch, 64 given back and the 65th kept live six epochs
// past the window with plan 8, outbox 10 and the Writer's held scopes flat at 8). And a new local move is refused at issue time (V3RoomLocalBacklogFull) while
// the Writer's backlog (its live replaced moves, its retained work and its outstanding records)
// has reached BACKLOG = REC_CAP, so live undelivered moves never exceed BACKLOG - 1 plus the most
// new moves accepted within one epoch (backlogBounded): growth is bounded by construction, not
// by how much the user types. A move accepted in the current epoch is not yet undelivered (a
// connected Writer delivers it), so it does not count until an install displaces it.
//   drop     the code before this fix: an expiry past the record bound is written with no record
//            (v3-room writeMergedSettlementPlan "settlementHandBacksWith(...) ?? handBacks"), and
//            no admission bound;
//   nobound  the record rule of the fix without the admission bound.
module settlementWindow {
  const MOVES: Set[int]
  pure val D = 4            // V3_SETTLEMENT_OWN_WINDOW_EPOCHS
  pure val MAX_SCOPES = 7   // LIVE_JOURNAL_RETIREMENT_LIMITS.maxScopes
  pure val MAX_EPOCH = 9
  pure val MAX_OUTAGES = 2
  pure val NONE = -1
  pure val MAX_CRASHES = 1
  pure val REC_CAP = 1      // SETTLEMENT_HAND_BACK_LIMITS.maxRecords (64)
  pure val BACKLOG = REC_CAP

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
  var rec: int -> str              // hand-back record: none | durable (FIXED) | consumed (by its reissue,
                                   // dropped at the next install's plan write) | derived (VOLATILE)
  var owed: int -> bool            // the app holds a given-back move in memory, not yet reissued
  var crashes: int
  var fencedAfter: int -> bool     // the move's current row was followed by its epoch's own fence
  var overflowed: bool             // an install found more expiring moves than free records
  var burst: int                   // new moves accepted in the Writer's current epoch
  var maxBurst: int                // the most new moves accepted within one epoch so far

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
    rec' = MOVES.mapBy(m => "none"), owed' = MOVES.mapBy(m => false), crashes' = 0,
    fencedAfter' = MOVES.mapBy(m => false), overflowed' = false, burst' = 0, maxBurst' = 0,
  }
  action init = initWith("fixed")
  action initC08 = initWith("c08")
  action initPremature = initWith("premature")
  action initRetained = initWith("retained")
  action initGap = initWith("gap")
  action initVolatile = initWith("volatile")
  action initStrict = initWith("strict")
  action initDrop = initWith("drop")
  action initNoBound = initWith("nobound")
  pure def recordCount(r: int -> str): int = MOVES.filter(m => r.get(m) == "durable").size()
  // Records the plan still holds: outstanding ones and ones consumed by a reissue since the last merge.
  pure def heldRecordCount(r: int -> str): int = MOVES.filter(m => r.get(m) == "durable" or r.get(m) == "consumed").size()
  // The backlog the admission bound counts: live replaced moves (displaced at least once), retained
  // work, and the plan's hand-back records. A new move accepted in the current epoch is not counted;
  // a reissued given-back move keeps its slot through its consumed record until the next install.
  val backlog = MOVES.filter(m =>
    (moveState.get(m) == "flight" and origin.get(m) < writerEpoch) or moveState.get(m) == "retained").size() +
    heldRecordCount(rec)
  val admissionBounded = mode != "drop" and mode != "nobound"
  // A reissue of a given-back move consumes its record (backlog unchanged); a new move needs room.
  def canIssue(m: int): bool = not(admissionBounded) or rec.get(m) == "durable" or backlog < BACKLOG
  // The record a give-back writes.
  def givenRecord: str = if (mode == "volatile") "derived" else "durable"
  action keepHand = all {
    rec' = rec, owed' = owed, crashes' = crashes, fencedAfter' = fencedAfter, overflowed' = overflowed,
    burst' = burst, maxBurst' = maxBurst,
  }

  action keepWriter = all {
    writerEpoch' = writerEpoch, ownSettled' = ownSettled, fenceEpoch' = fenceEpoch, moveState' = moveState,
    activeEpoch' = activeEpoch, activeGen' = activeGen, origin' = origin, gen' = gen, published' = published,
    closed' = closed, mode' = mode, keepHand,
  }

  // The creator closes its epoch and adopts the next one (independently of the Writer).
  // Rows of the closed epoch can never be admitted again (deliver admits only under the
  // current epoch); they are dropped from the network state, which removes no behavior
  // and keeps the state space small enough for TLC.
  action creatorAdvance: bool = all {
    creatorEpoch < MAX_EPOCH, creatorEpoch' = creatorEpoch + 1, link' = link, outages' = outages,
    admitted' = admitted, published' = published.filter(r => r._2 > creatorEpoch),
    writerEpoch' = writerEpoch, ownSettled' = ownSettled, fenceEpoch' = fenceEpoch, moveState' = moveState,
    activeEpoch' = activeEpoch, activeGen' = activeGen, origin' = origin, gen' = gen, closed' = closed, mode' = mode, keepHand,
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
      mode' = mode, keepHand,
    }
  }
  // The Writer issues a move the app holds, in its current epoch. FIXED: refused while
  // the creator is unreachable (read-only; the app keeps it).
  action issueMove(m: int): bool = {
    val g = gen.get(m) + 1
    all {
      not(closed), moveState.get(m) == "app", mode == "c08" or link != "down",
      // FIXED: refused up front while the backlog is full (V3RoomLocalBacklogFull); the app keeps it.
      canIssue(m),
      moveState' = moveState.set(m, "flight"), activeEpoch' = activeEpoch.set(m, writerEpoch),
      activeGen' = activeGen.set(m, g), origin' = origin.set(m, writerEpoch), gen' = gen.set(m, g),
      published' = published.union(Set((m, writerEpoch, g))),
      creatorEpoch' = creatorEpoch, link' = link, outages' = outages, admitted' = admitted,
      writerEpoch' = writerEpoch, ownSettled' = ownSettled, fenceEpoch' = fenceEpoch, closed' = closed,
      mode' = mode,
      // FIXED: the reissue's issuance transaction consumes the durable record (plan effect
      // "hand-back"); VOLATILE's derived listing stays while its entry is retained.
      rec' = rec.set(m, if (rec.get(m) == "durable") "consumed" else rec.get(m)), owed' = owed.set(m, false),
      crashes' = crashes, fencedAfter' = fencedAfter.set(m, false), overflowed' = overflowed,
      burst' = if (rec.get(m) == "durable") burst else burst + 1,
      maxBurst' = max(maxBurst, if (rec.get(m) == "durable") burst else burst + 1),
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
  // The fence follows the rows signed before it in its epoch, and its admission admits them.
  action fence: bool = {
    val before = MOVES.filter(m => moveState.get(m) == "flight" and activeEpoch.get(m) == writerEpoch)
    all {
      not(closed), link == "up", writerEpoch == creatorEpoch, fenceEpoch < writerEpoch,
      not(fenceWithheld),
      fenceEpoch' = writerEpoch,
      admitted' = admitted.union(before.map(m => row(m))),
      fencedAfter' = MOVES.mapBy(m => fencedAfter.get(m) or before.contains(m)),
      creatorEpoch' = creatorEpoch, link' = link, outages' = outages,
      writerEpoch' = writerEpoch, ownSettled' = ownSettled, moveState' = moveState, activeEpoch' = activeEpoch,
      activeGen' = activeGen, origin' = origin, gen' = gen, published' = published, closed' = closed,
      mode' = mode, rec' = rec, owed' = owed, crashes' = crashes, overflowed' = overflowed, burst' = burst,
      maxBurst' = maxBurst,
    }
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
    val candidates = MOVES.filter(m => not(skip) and displacedAt(m, misread) and expiresAt(m, e))
    // The plan write records as many expiring moves as there are free records (any of them).
    val free = max(0, REC_CAP - recordCount(rec))
    val expiring = candidates.fold(Set(), (acc, m) => if (acc.size() < free) acc.union(Set(m)) else acc)
    val overflow = candidates.exclude(expiring)
    // DROP: the overflow is expired with no record. Otherwise it stays live and is replaced again.
    val dropping = if (mode == "drop") overflow else Set()
    val rebasing = MOVES.filter(m =>
      not(skip) and displacedAt(m, misread) and (not(expiresAt(m, e)) or overflow.exclude(dropping).contains(m)))
    val states = MOVES.mapBy(m =>
      if (retaining.contains(m)) "retained"
      else if (settledNow.contains(m)) "done" else if (expiring.contains(m)) "given"
      else if (dropping.contains(m)) "dropped" else moveState.get(m))
    val kept = overflow.exclude(dropping)
    val origins = MOVES.mapBy(m =>
      if (settledNow.contains(m) or expiring.contains(m) or dropping.contains(m)) NONE
      else if (kept.contains(m)) max(origin.get(m), e - D) else origin.get(m))
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
      // The expiry and its hand-back record are one plan write.
      // The merge drops consumed records.
      rec' = MOVES.mapBy(m => if (expiring.contains(m)) givenRecord else if (rec.get(m) == "consumed") "none" else rec.get(m)),
      owed' = owed, crashes' = crashes,
      fencedAfter' = MOVES.mapBy(m => if (rebasing.contains(m)) false else fencedAfter.get(m)),
      overflowed' = (overflowed or overflow.size() > 0), burst' = 0, maxBurst' = maxBurst,
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
  // STRICT proves an admitted row committed only while no own fence follows it.
  def canResolve(m: int): bool =
    mode != "retained" and mode != "c08" and not(closed) and moveState.get(m) == "retained" and activeEpoch.get(m) < writerEpoch and
      not(mode == "strict" and admitted.contains(row(m)) and fencedAfter.get(m))
  action resolveMove(m: int): bool = all {
    canResolve(m),
    val committed = admitted.contains(row(m))
    all {
      moveState' = moveState.set(m, if (committed) "done" else "given"),
      activeEpoch' = activeEpoch.set(m, NONE), origin' = origin.set(m, NONE),
      // The frontier resolution and its hand-back record are one plan write.
      rec' = if (committed) rec else rec.set(m, givenRecord),
    },
    creatorEpoch' = creatorEpoch, link' = link, outages' = outages, admitted' = admitted,
    writerEpoch' = writerEpoch, ownSettled' = ownSettled, fenceEpoch' = fenceEpoch, activeGen' = activeGen,
    gen' = gen, published' = published, closed' = closed, mode' = mode, owed' = owed, crashes' = crashes,
    fencedAfter' = fencedAfter, overflowed' = overflowed, burst' = burst, maxBurst' = maxBurst,
  }
  // PREMATURE only: hands a move back at the early signal while its row's epoch may
  // still be open at the creator.
  action prematureHandBackMove(m: int): bool = {
    all {
      mode == "premature", not(closed), moveState.get(m) == "flight", activeEpoch.get(m) == writerEpoch,
      moveState' = moveState.set(m, "given"), activeEpoch' = activeEpoch.set(m, NONE), origin' = origin.set(m, NONE),
      creatorEpoch' = creatorEpoch, link' = link, outages' = outages, admitted' = admitted,
      writerEpoch' = writerEpoch, ownSettled' = ownSettled, fenceEpoch' = fenceEpoch, activeGen' = activeGen,
      gen' = gen, published' = published, closed' = closed, mode' = mode,
      rec' = rec.set(m, givenRecord), owed' = owed, crashes' = crashes, fencedAfter' = fencedAfter,
      overflowed' = overflowed, burst' = burst, maxBurst' = maxBurst,
    }
  }

  // The app takes a listed hand-back into its kept moves (memory).
  action takeMove(m: int): bool = all {
    not(closed), moveState.get(m) == "given", rec.get(m) != "none",
    moveState' = moveState.set(m, "app"), owed' = owed.set(m, true), rec' = rec, crashes' = crashes, fencedAfter' = fencedAfter,
    overflowed' = overflowed, burst' = burst, maxBurst' = maxBurst,
    creatorEpoch' = creatorEpoch, link' = link, outages' = outages, admitted' = admitted,
    writerEpoch' = writerEpoch, ownSettled' = ownSettled, fenceEpoch' = fenceEpoch, activeEpoch' = activeEpoch,
    activeGen' = activeGen, origin' = origin, gen' = gen, published' = published, closed' = closed, mode' = mode,
  }
  // Retirement removes the expired entry and its row (VOLATILE: and the listing derived from
  // it), after the app has taken the move. A durable record is not retirement's to remove.
  action pruneMove(m: int): bool = all {
    rec.get(m) == "derived", moveState.get(m) != "given",
    rec' = rec.set(m, "none"), owed' = owed, crashes' = crashes, fencedAfter' = fencedAfter,
    overflowed' = overflowed, burst' = burst, maxBurst' = maxBurst,
    creatorEpoch' = creatorEpoch, link' = link, outages' = outages, admitted' = admitted,
    writerEpoch' = writerEpoch, ownSettled' = ownSettled, fenceEpoch' = fenceEpoch, moveState' = moveState,
    activeEpoch' = activeEpoch, activeGen' = activeGen, origin' = origin, gen' = gen, published' = published,
    closed' = closed, mode' = mode,
  }
  // The process dies and reopens: the app's memory is gone. Whatever the room's record still
  // holds is listed again (and taken as a new kept move); a given-back move the app held with
  // no record left is lost.
  action crash: bool = all {
    not(closed), crashes < MAX_CRASHES, crashes' = crashes + 1, fencedAfter' = fencedAfter,
    overflowed' = overflowed, burst' = burst, maxBurst' = maxBurst,
    moveState' = MOVES.mapBy(m =>
      if (moveState.get(m) == "app" and owed.get(m)) (if (rec.get(m) != "none") "given" else "lost")
      // VOLATILE: a reissued move's derived listing is still there, and a fresh app takes it again.
      else if (rec.get(m) == "derived" and (moveState.get(m) == "flight" or moveState.get(m) == "done")) "given"
      else moveState.get(m)),
    owed' = MOVES.mapBy(m => false), rec' = rec,
    creatorEpoch' = creatorEpoch, link' = link, outages' = outages, admitted' = admitted,
    writerEpoch' = writerEpoch, ownSettled' = ownSettled, fenceEpoch' = fenceEpoch, activeEpoch' = activeEpoch,
    activeGen' = activeGen, origin' = origin, gen' = gen, published' = published, closed' = closed, mode' = mode,
  }

  action issue: bool = { nondet m = MOVES.oneOf() issueMove(m) }
  action take: bool = { nondet m = MOVES.oneOf() takeMove(m) }
  action prune: bool = { nondet m = MOVES.oneOf() pruneMove(m) }
  action want: bool = { nondet m = MOVES.oneOf() wantMove(m) }
  action prematureHandBack: bool = { nondet m = MOVES.oneOf() prematureHandBackMove(m) }
  action resolve: bool = { nondet m = MOVES.oneOf() resolveMove(m) }

  action step = any {
    creatorAdvance, outage, reconnect, want, issue, deliver, fence, install, prematureHandBack, resolve,
    take, prune, crash,
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
  // The re-replacement is bounded by the window: a chain spans at most D epochs, or D + 1 for a move the
  // record bound keeps live (pinned at the window bound until a record is free).
  val chainBounded = MOVES.forall(m => moveState.get(m) != "flight" or activeEpoch.get(m) - origin.get(m) <= D)
  // No given-back move is ever lost: until reissued it is held by the room's record or the app.
  val noLoss = MOVES.forall(m => moveState.get(m) != "lost")
  // FIXED: the durable record exists exactly while the move is given back and not reissued.
  val recordExact = mode == "volatile" or MOVES.forall(m =>
    (rec.get(m) == "durable") == (moveState.get(m) == "given" or (moveState.get(m) == "app" and owed.get(m))))
  // Conservation: no accepted move is ever expired without a hand-back record (or a terminal admission).
  val noSilentExpire = MOVES.forall(m => moveState.get(m) != "dropped")
  // Live undelivered moves stay within the backlog bound plus one epoch's accepted new moves.
  val backlogBounded = backlog <= BACKLOG - 1 + maxBurst
  // Not an invariant: moves accepted within one epoch are not counted until an install displaces them,
  // so a burst can expire more moves at once than there are free records (TLC finds it); the merge then
  // keeps the overflow live. Checked as a reachability witness.
  val noOverflow = not(overflowed)
  val safety = scopesBounded and atMostOnce and retiredUnadmittable and chainBounded and not(closed) and noLoss and recordExact and
    noSilentExpire and backlogBounded

  // Liveness: under weak fairness of connectivity returning and of the Writer's own
  // steps and deliveries, every move the app wants is eventually applied by the creator
  // (the Writer writes again). The model has no explicit terminal refusal: the session
  // closing (c08) is the defect, not an allowed terminal.
  def wanting(m: int): bool = moveState.get(m) == "app" or moveState.get(m) == "flight" or moveState.get(m) == "retained" or
    moveState.get(m) == "given"
  def applied(m: int): bool = admitted.exists(r => r._1 == m)
  val vars = (creatorEpoch, writerEpoch, link, outages, ownSettled, fenceEpoch, moveState, activeEpoch, activeGen,
    origin, gen, published, admitted, closed, mode, rec, owed, crashes, fencedAfter, overflowed, burst, maxBurst)
  temporal writerWritesAgain =
    (weakFair(reconnect, vars) and weakFair(install, vars) and weakFair(issue, vars) and weakFair(deliver, vars)
      and weakFair(fence, vars) and weakFair(resolve, vars) and weakFair(take, vars))
    implies always(wanting(0) implies eventually(applied(0)))
  // Retained work is eventually resolved (the author fence is not withheld forever).
  temporal retainedResolves =
    (weakFair(reconnect, vars) and weakFair(install, vars) and weakFair(issue, vars) and weakFair(deliver, vars)
      and weakFair(fence, vars) and weakFair(resolve, vars) and weakFair(take, vars))
    implies always(moveState.get(0) == "retained" implies eventually(moveState.get(0) != "retained"))

  // Witnesses.
  action silentFor(n: int): bool = n.reps(_ => creatorAdvance.then(installWith(Set())))
  // A Writer silent for 9 epochs with a move in flight: at most D scopes, the move handed
  // back at the bound, the chain never longer than D, and on reconnect it is applied once.
  run silentWriterTest = init.then(issueMove(0)).then(drop("silent")).then(silentFor(9))
    .then(all { assert(writerEpoch == 9 and safety and scopes <= D and moveState.get(0) == "given" and appliedCount(0) == 0), reconnect })
    .then(takeMove(0)).then(issueMove(0)).then(deliver)
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
    .then(all { assert(moveState.get(0) == "given" and appliedCount(0) == 0), takeMove(0) }).then(issueMove(0)).then(deliver)
    .then(all { assert(appliedCount(0) == 1 and safety), fence })
  // 94d117ca: the retained move is never resolved, so it is never applied and no fence goes out.
  run retainedStuckTest = initRetained.then(creatorAdvance).then(installWith(Set())).then(issueMove(0))
    .then(drop("down")).then(creatorAdvance).then(creatorAdvance).then(creatorAdvance).then(reconnect)
    .then(installWith(Set()))
    .then(all { assert(moveState.get(0) == "retained" and not(canResolve(0)) and fenceWithheld and not(applied(0))), creatorAdvance })
  // A move signed before its epoch's fence, admitted with the fence, then a skip install: FIXED
  // proves it committed by fence closure and the fence resumes; STRICT leaves it retained forever.
  action fencedBeforeSkip(start: bool): bool = start.then(creatorAdvance).then(installWith(Set())).then(issueMove(0)).then(fence)
    .then(drop("down")).then(creatorAdvance).then(creatorAdvance).then(creatorAdvance).then(reconnect).then(installWith(Set()))
  run fencedClosureTest = fencedBeforeSkip(init)
    .then(all { assert(moveState.get(0) == "retained" and applied(0) and fencedAfter.get(0) and canResolve(0)), resolveMove(0) })
    .then(all { assert(moveState.get(0) == "done" and not(fenceWithheld) and appliedCount(0) == 1 and safety), fence })
  run strictStuckTest = fencedBeforeSkip(initStrict)
    .then(all { assert(moveState.get(0) == "retained" and applied(0) and not(canResolve(0)) and fenceWithheld), creatorAdvance })
  // A premature reissue: the original and the reissue are both admitted.
  run prematureDoubleTest = initPremature.then(issueMove(0)).then(prematureHandBackMove(0)).then(takeMove(0)).then(issueMove(0)).then(deliver).then(deliver)
    .then(all { assert(appliedCount(0) == 2 and not(atMostOnce)), creatorAdvance })
  // Hand-back custody across a crash. The move is given back at the window bound (silent).
  action givenBack = init.then(issueMove(0)).then(drop("silent")).then(silentFor(4))
  action givenBackVolatile = initVolatile.then(issueMove(0)).then(drop("silent")).then(silentFor(4))
  // FIXED: taken, crash before the reissue: listed again from the durable record, reissued once.
  run durableCrashBeforeReissueTest = givenBack.then(all { assert(moveState.get(0) == "given" and rec.get(0) == "durable"), takeMove(0) })
    .then(crash).then(all { assert(moveState.get(0) == "given" and noLoss), reconnect }).then(takeMove(0)).then(issueMove(0)).then(deliver)
    .then(all { assert(appliedCount(0) == 1 and rec.get(0) == "consumed" and safety), creatorAdvance })
  // FIXED: reissued, crash after: the record was consumed with the reissue, nothing is listed again.
  run durableCrashAfterReissueTest = givenBack.then(reconnect).then(takeMove(0)).then(issueMove(0)).then(crash)
    .then(all { assert(moveState.get(0) == "flight" and rec.get(0) == "consumed"), deliver })
    .then(all { assert(appliedCount(0) == 1 and safety), creatorAdvance })
  // VOLATILE: taken, the entry retired, then a crash: the move is lost.
  run volatileLossTest = givenBackVolatile.then(takeMove(0)).then(pruneMove(0)).then(crash)
    .then(all { assert(moveState.get(0) == "lost" and not(noLoss)), creatorAdvance })
  // VOLATILE: reissued and admitted, then a crash before retirement: listed again, reissued, applied twice.
  run volatileDoubleTest = givenBackVolatile.then(reconnect).then(takeMove(0)).then(issueMove(0)).then(deliver).then(crash)
    .then(takeMove(0)).then(issueMove(0)).then(deliver)
    .then(all { assert(appliedCount(0) == 2 and not(atMostOnce)), creatorAdvance })
  // Without the fence guard: an admitted row read as displaced is replaced and admitted again.
  run gapDoubleTest = initGap.then(issueMove(0)).then(deliver).then(creatorAdvance)
    .then(installWith(Set(0))).then(deliver)
    .then(all { assert(appliedCount(0) == 2 and not(atMostOnce)), creatorAdvance })
}

// One move: the original witnesses and checks.
module settlementWindowOne {
  import settlementWindow(MOVES = Set(0)).* from "./settlement-window"
}

// Two moves with a one-record bound: conservation past the record bound and admission back-pressure.
module settlementWindowTwo {
  import settlementWindow(MOVES = Set(0, 1)).* from "./settlement-window"
  // Both moves accepted in one epoch (neither counts yet), then the Writer goes silent until the window.
  action twoSilent(start: bool): bool =
    start.then(issueMove(0)).then(issueMove(1)).then(drop("silent")).then(silentFor(4))
  // DROP: one move gets the only record, the other is expired with none: lost.
  run dropLosesMoveTest = twoSilent(initDrop)
    .then(all { assert(recordCount(rec) == 1 and MOVES.exists(m => moveState.get(m) == "dropped") and not(noSilentExpire)), creatorAdvance })
  // FIXED: the other stays live (replaced again) and gets the record once the first is reissued.
  run overflowStaysLiveTest = twoSilent(init)
    .then(all { assert(noSilentExpire), assert(overflowed), assert(recordCount(rec) == 1), assert(backlogBounded),
      assert(MOVES.exists(m => moveState.get(m) == "given")), assert(MOVES.exists(m => moveState.get(m) == "flight")), reconnect })
    .then(takeMove(0)).then(issueMove(0)).then(creatorAdvance).then(installWith(Set()))
    .then(all { assert(noSilentExpire and moveState.get(1) == "given" and rec.get(1) == "durable" and moveState.get(0) == "flight"), creatorAdvance })
  // FIXED: while the app holds the record, the overflow stays live past the window without growing
  // the Writer's protected scopes (the session never closes).
  run overflowLivesPastWindowTest = twoSilent(init).then(silentFor(4))
    .then(all { assert(safety and not(closed) and scopes <= D + 1 and MOVES.exists(m => moveState.get(m) == "flight") and
      recordCount(rec) == 1), creatorAdvance })
  // FIXED: a second move is refused while the first waits displaced; delivery and settlement clear it.
  run backlogRefusesThenClearsTest = init.then(issueMove(0)).then(drop("silent")).then(creatorAdvance).then(installWith(Set()))
    .then(all { assert(backlog == 1 and not(canIssue(1))), silentFor(3) })
    .then(all { assert(moveState.get(0) == "given" and not(canIssue(1)) and noSilentExpire), reconnect })
    .then(takeMove(0)).then(all { assert(canIssue(0) and not(canIssue(1))), issueMove(0) }).then(deliver)
    .then(creatorAdvance).then(installWith(Set()))
    .then(all { assert(moveState.get(0) == "done" and backlog == 0 and canIssue(1)), issueMove(1) })
  // FIXED: a reissued given-back move keeps its slot (its consumed record) until the next install.
  run reissueKeepsSlotTest = init.then(issueMove(0)).then(drop("silent")).then(silentFor(4))
    .then(all { assert(moveState.get(0) == "given" and backlog == 1), takeMove(0) }).then(issueMove(0))
    .then(all { assert(rec.get(0) == "consumed" and backlog == 1 and not(canIssue(1))), creatorAdvance }).then(installWith(Set()))
    .then(all { assert(rec.get(0) == "none" and backlog == 1 and not(canIssue(1)) and safety), creatorAdvance })
  // NOBOUND: without the admission bound a second move joins the displaced one and the backlog exceeds its bound.
  run noBoundExceedsBacklogTest = initNoBound.then(issueMove(0)).then(drop("silent")).then(creatorAdvance).then(installWith(Set()))
    .then(issueMove(1)).then(creatorAdvance).then(installWith(Set()))
    .then(all { assert(backlog == 2 and maxBurst == 1 and not(backlogBounded)), creatorAdvance })
  // A connected Writer delivering every epoch never counts a move: the bound never refuses it.
  run connectedNeverRefusedTest = init.then(issueMove(0)).then(deliver).then(issueMove(1)).then(deliver)
    .then(creatorAdvance).then(installWith(Set()))
    .then(all { assert(backlog == 0 and moveState.get(0) == "done" and moveState.get(1) == "done" and safety), creatorAdvance })
}

// Given-back author order (track 46, reissueOrigins). One author, one displacement identity (every move
// overwrites the same cell, as a Grid block placement), seen after a reload (the policy has no
// in-memory history: only the room's durable listing and its supersededBy).
//
// Facts the model takes from the code:
//   - A move's origin is the author sequence of its first row. A replacement (plan entry
//     replacementSequence) and a reissue keep it; a fresh move (an ask, or the policy's re-offer of
//     the newest move) starts a new one.
//   - Admission is decided by the creator's signed frontier only (terminalThrough). An install admits
//     the undecided own rows up to the frontier (an author's admitted slots are causally closed) and
//     displaces the rest; the frontier can pass rows an earlier install displaced (a later own fence
//     is admitted). The install's drain replaces the displaced moves in sequence order before any new
//     own move, or keeps a row retained (unknown work) for a later frontier resolution.
//   - The window expiry of a displaced row, or the frontier resolution of a retained one, writes a
//     hand-back record with the move's origin, read by walking the plan's replacement links back until
//     a reissueOrigins entry (that write drops the entry) or the move's first row
//     (settlementMoveOrigin). A full record bound defers it (windowDeferredMoves): the move stays live
//     (replaced again) or retained; no entry is dropped.
//   - The reissue consumes the record and adds the row's entry (reissueSequence -> origin) in its own
//     issuance transaction; the plan effect refuses it at the entry bound. Replacement never drops an
//     entry; the window walk stops at an entry.
//   - The room lists the unconsumed records sorted by origin, each with supersededBy: the author's
//     newest issued row of the identity by origin (origins read through the entries and links), when
//     its origin is greater than the record's.
//   - The policy offers the first listed record again with its record; when its supersededBy is a
//     different move, it offers that move again right after (V3RoomKeptMoveSuperseded), so the newer
//     move lands last. The two issues are one step here (the model does not refuse the second).
//
// Variants:
//   fixed         the design: an entry is dropped when the frontier ADMITTED its chain's last carrier
//                 (or when the move expires, in the expiry's write);
//   carrierOrder  before track 46: records ordered by their carrier row, no entries, no supersededBy;
//   terminalDrop  an entry is dropped once its chain's last carrier is at or below the frontier,
//                 admitted or not: a retained carrier the frontier passed loses its origin before its
//                 frontier resolution gives it back.
//
// Invariants: listingInAuthorOrder (every listed record carries its move's true origin, so the
// listing is in author order, and the move its supersededBy names, as the policy reads it, is the
// author's newest move of the identity when that is a different move) and authorOrderPerIdentity
// (once every row is decided and handled and no record is listed, the last admitted row carries the
// newest move among the admitted rows). Witnesses (must be reachable): handedBackTwiceKeepsOrigin,
// reissuedReplacedExpiredKeepsOrigin, quiescentWithReissue, deferredSeen.
module settlementAuthorOrder {
  pure val NM = 2          // fresh moves the author asks for; content k is the author's k-th move
  pure val MAXSEQ = 7      // own rows
  pure val RMAX = 1        // SETTLEMENT_HAND_BACK_LIMITS.maxRecords (64): unconsumed records
  pure val EMAX = 2        // the reissueOrigins entry bound (64)
  pure val NONE = -1

  // kind: "new" (an ask or a re-offer), "replace" (from = the replaced row), "reissue".
  // chain: ghost, the true origin of the move the row carries.
  type Row = { content: int, chain: int, kind: str, from: int }
  type Given = { source: int, origin: int, content: int, chain: int }
  type Ent = { reissue: int, origin: int }

  var rows: int -> Row
  var nextSeq: int
  var asked: int
  var frontier: int            // terminalThrough
  var admitted: Set[int]
  var displaced: Set[int]
  var retained: Set[int]       // displaced rows the drain kept as unknown work
  var handled: Set[int]        // displaced rows replaced or given back
  var records: Set[Given]      // unconsumed hand-back records
  var entries: Set[Ent]        // reissueOrigins
  var mode: str
  var deferred: bool

  def seqs: Set[int] = rows.keys()
  def undecided(s: int): bool = not(admitted.contains(s)) and not(displaced.contains(s))
  // The drain's pending rows: displaced, neither handled nor retained.
  def pending: Set[int] = displaced.filter(s => not(handled.contains(s)) and not(retained.contains(s)))
  def drained: bool = pending.size() == 0
  def firstPending(s: int): bool = pending.contains(s) and pending.forall(t => s <= t)

  // The stored origin of a row (settlementMoveOrigin): links back to an entry or the first row.
  def storedOrigin(s: int): int = {
    val walk = 0.to(MAXSEQ).fold({ cur: s, res: NONE }, (acc, i) =>
      if (acc.res != NONE) acc
      else if (entries.exists(e => e.reissue == acc.cur))
        { cur: acc.cur, res: entries.filter(e => e.reissue == acc.cur).fold(NONE, (x, e) => e.origin) }
      else if (rows.get(acc.cur).kind == "replace") { cur: rows.get(acc.cur).from, res: NONE }
      else { cur: acc.cur, res: acc.cur })
    walk.res
  }
  // The row a walk from `s` stops at (the entry's reissued row, or the move's first row).
  def walkStop(s: int): int = {
    val walk = 0.to(MAXSEQ).fold({ cur: s, done: false }, (acc, i) =>
      if (acc.done) acc
      else if (entries.exists(e => e.reissue == acc.cur)) { cur: acc.cur, done: true }
      else if (rows.get(acc.cur).kind == "replace") { cur: rows.get(acc.cur).from, done: false }
      else { cur: acc.cur, done: true })
    walk.cur
  }
  // A chain's last carrier: replacement links followed forward (settlementReissueLastCarrier).
  def lastCarrier(s: int): int =
    0.to(MAXSEQ).fold(s, (cur, i) => {
      val succ = seqs.filter(t => rows.get(t).kind == "replace" and rows.get(t).from == cur)
      if (succ.size() == 0) cur else succ.fold(cur, (x, t) => t)
    })

  // The room's supersededBy for a record, as the policy reads it: the newest row by stored origin
  // (then sequence), when its origin is greater and it carries a different move; else NONE.
  def storedNewest: int = seqs.filter(s => seqs.forall(t =>
    storedOrigin(t) < storedOrigin(s) or (storedOrigin(t) == storedOrigin(s) and t <= s))).fold(NONE, (x, s) => s)
  def supersedingContent(r: Given): int =
    if (mode == "carrierOrder" or seqs.size() == 0) NONE
    else {
      val n = storedNewest
      if (storedOrigin(n) > r.origin and rows.get(n).content != r.content) rows.get(n).content else NONE
    }
  // The same question over the true origins.
  def trueNewest: int = seqs.filter(s => seqs.forall(t =>
    rows.get(t).chain < rows.get(s).chain or (rows.get(t).chain == rows.get(s).chain and t <= s))).fold(NONE, (x, s) => s)
  def trueSupersedingContent(r: Given): int =
    if (seqs.size() == 0) NONE
    else {
      val n = trueNewest
      if (rows.get(n).chain > r.chain and rows.get(n).content != r.content) rows.get(n).content else NONE
    }
  // The listing's first record (lowest origin, then source).
  def firstListed: Set[Given] = records.filter(r => records.forall(q => r.origin < q.origin or
    (r.origin == q.origin and r.source <= q.source)))

  action initWith(v: str): bool = all {
    rows' = Map(), nextSeq' = 0, asked' = 0, frontier' = NONE, admitted' = Set(), displaced' = Set(),
    retained' = Set(), handled' = Set(), records' = Set(), entries' = Set(), mode' = v, deferred' = false,
  }
  action init = initWith("fixed")
  action initCarrierOrder = initWith("carrierOrder")
  action initTerminalDrop = initWith("terminalDrop")

  action stutter = all {
    rows' = rows, nextSeq' = nextSeq, asked' = asked, frontier' = frontier, admitted' = admitted, displaced' = displaced,
    retained' = retained, handled' = handled, records' = records, entries' = entries, mode' = mode, deferred' = deferred,
  }

  // The author asks for its next move (after the drain).
  action ask = all {
    asked < NM, nextSeq < MAXSEQ, drained,
    rows' = rows.put(nextSeq, { content: asked, chain: nextSeq, kind: "new", from: NONE }),
    nextSeq' = nextSeq + 1, asked' = asked + 1,
    frontier' = frontier, admitted' = admitted, displaced' = displaced, retained' = retained, handled' = handled,
    records' = records, entries' = entries, mode' = mode, deferred' = deferred,
  }

  // An install with the creator's signed frontier k: the undecided rows up to k are admitted, the
  // other undecided rows are displaced.
  action install(k: int): bool = all {
    drained, frontier <= k, k < nextSeq,
    frontier' = k,
    admitted' = admitted.union(seqs.filter(s => undecided(s) and s <= k)),
    displaced' = displaced.union(seqs.filter(s => undecided(s) and s > k)),
    rows' = rows, nextSeq' = nextSeq, asked' = asked, retained' = retained, handled' = handled,
    records' = records, entries' = entries, mode' = mode, deferred' = deferred,
  }

  // A plan write drops the entries whose move settled (v3-room settlementReissueOriginsUnsettled).
  def settled(e: Ent): bool = {
    val last = lastCarrier(e.reissue)
    last <= frontier and (mode == "terminalDrop" or admitted.contains(last))
  }
  action settleEntries = all {
    entries.exists(e => settled(e)),
    entries' = entries.filter(e => not(settled(e))),
    rows' = rows, nextSeq' = nextSeq, asked' = asked, frontier' = frontier, admitted' = admitted,
    displaced' = displaced, retained' = retained, handled' = handled, records' = records, mode' = mode, deferred' = deferred,
  }

  // The drain, in sequence order: replace the first pending row (same move, new row; the entry stays) ...
  action replace(s: int): bool = all {
    firstPending(s), nextSeq < MAXSEQ,
    rows' = rows.put(nextSeq, { content: rows.get(s).content, chain: rows.get(s).chain, kind: "replace", from: s }),
    nextSeq' = nextSeq + 1, handled' = handled.union(Set(s)),
    asked' = asked, frontier' = frontier, admitted' = admitted, displaced' = displaced, retained' = retained,
    records' = records, entries' = entries, mode' = mode, deferred' = deferred,
  }
  // ... or keep it retained (unknown work) ...
  action retain(s: int): bool = all {
    firstPending(s), retained' = retained.union(Set(s)),
    rows' = rows, nextSeq' = nextSeq, asked' = asked, frontier' = frontier, admitted' = admitted,
    displaced' = displaced, handled' = handled, records' = records, entries' = entries, mode' = mode, deferred' = deferred,
  }
  // ... or give it back at the window bound; a retained row is given back by a later frontier
  // resolution. Its record carries the move's origin and the entry the walk stopped at leaves in the
  // same write. With the record bound full nothing is written (deferred: replaced again or kept retained).
  action giveBack(s: int): bool = all {
    firstPending(s) or retained.contains(s),
    if (records.size() < RMAX) {
      val stop = walkStop(s)
      val origin = if (mode == "carrierOrder") s else storedOrigin(s)
      all {
        records' = records.union(Set({ source: s, origin: origin, content: rows.get(s).content, chain: rows.get(s).chain })),
        entries' = entries.filter(e => e.reissue != stop),
        handled' = handled.union(Set(s)), retained' = retained.exclude(Set(s)), deferred' = deferred,
      }
    } else all {
      records' = records, entries' = entries, handled' = handled, retained' = retained, deferred' = true,
    },
    rows' = rows, nextSeq' = nextSeq, asked' = asked, frontier' = frontier, admitted' = admitted,
    displaced' = displaced, mode' = mode,
  }

  // The policy (after a reload) offers the first listed record again, then its supersededBy move.
  action offerKept = all {
    records.size() > 0, nextSeq + 2 <= MAXSEQ, drained,
    mode == "carrierOrder" or entries.size() < EMAX,
    nondet r = firstListed.oneOf()
    val newer = supersedingContent(r)
    all {
      records' = records.exclude(Set(r)),
      entries' = if (mode == "carrierOrder") entries else entries.union(Set({ reissue: nextSeq, origin: r.origin })),
      rows' = if (newer == NONE) rows.put(nextSeq, { content: r.content, chain: r.chain, kind: "reissue", from: NONE })
        else rows.put(nextSeq, { content: r.content, chain: r.chain, kind: "reissue", from: NONE })
          .put(nextSeq + 1, { content: newer, chain: nextSeq + 1, kind: "new", from: NONE }),
      nextSeq' = nextSeq + (if (newer == NONE) 1 else 2),
    },
    asked' = asked, frontier' = frontier, admitted' = admitted, displaced' = displaced, retained' = retained,
    handled' = handled, mode' = mode, deferred' = deferred,
  }

  action step = any {
    ask, settleEntries, offerKept,
    nondet s = NONE.to(MAXSEQ - 1).oneOf()
    any { install(s), replace(s), retain(s), giveBack(s) },
  }

  // ---- Properties. ----
  val listingInAuthorOrder = records.forall(r => r.origin == r.chain and supersedingContent(r) == trueSupersedingContent(r))
  def quiescent: bool = seqs.forall(s => admitted.contains(s) or handled.contains(s)) and records.size() == 0
  def lastAdmitted: int = admitted.fold(NONE, (x, s) => if (s > x) s else x)
  val authorOrderPerIdentity = not(quiescent) or admitted.size() == 0 or
    admitted.forall(s => rows.get(s).content <= rows.get(lastAdmitted).content)
  val safety = listingInAuthorOrder and authorOrderPerIdentity

  // Witnesses: violated means reachable.
  val handedBackTwiceKeepsOrigin = not(records.exists(r => rows.get(r.source).kind == "reissue" and r.origin == r.chain))
  val reissuedReplacedExpiredKeepsOrigin = not(records.exists(r => rows.get(r.source).kind == "replace" and
    rows.get(rows.get(r.source).from).kind == "reissue" and r.origin == r.chain))
  val quiescentWithReissue = not(quiescent and admitted.exists(s => rows.get(s).kind == "reissue"))
  val deferredSeen = not(deferred)

  // ---- Deterministic runs. ----
  // Two moves of one cell, both displaced: the older one (A) is replaced (row 2), the newer one (B)
  // given back and reissued (row 3, its entry). Both displaced again: A is given back from row 2 (by
  // carrier after B's record), B's reissue is replaced (row 4, its origin read through the entry).
  action bothGivenBack(start: bool): bool =
    start.then(ask).then(ask).then(install(NONE)).then(replace(0)).then(giveBack(1)).then(offerKept)
      .then(install(NONE)).then(giveBack(2)).then(replace(3))
  run originOrderTest = bothGivenBack(init)
    .then(all { assert(rows.get(3).content == 1 and records.exists(r => r.origin == 0 and r.source == 2) and safety), offerKept })
    .then(all { assert(rows.get(5).content == 0 and rows.get(6).content == 1 and safety), install(6) })
    .then(all { assert(quiescent and rows.get(lastAdmitted).content == 1 and safety), stutter })
  run carrierOrderBreaksTest = bothGivenBack(initCarrierOrder)
    .then(all { assert(records.exists(r => r.origin == 2 and r.chain == 0) and not(listingInAuthorOrder)), offerKept })
    .then(install(5))
    .then(all { assert(quiescent and rows.get(lastAdmitted).content == 0 and not(authorOrderPerIdentity)), stutter })
  // Reissued, displaced, replaced, then given back: the entry survives the replacement.
  action reissued(start: bool): bool = start.then(ask).then(install(NONE)).then(giveBack(0)).then(offerKept)
  run reissuedReplacedExpiredTest = reissued(init).then(install(NONE)).then(replace(1)).then(install(NONE)).then(giveBack(2))
    .then(all { assert(not(reissuedReplacedExpiredKeepsOrigin) and safety and entries.size() == 0), stutter })
  // The reissued row is retained; the frontier passes it (a later own move admitted). Dropping the
  // entry then (terminalDrop) loses the origin at the frontier resolution that gives it back.
  action retainedPassed(start: bool): bool =
    reissued(start).then(install(NONE)).then(retain(1)).then(ask).then(install(2))
  run terminalDropLosesOriginTest = retainedPassed(initTerminalDrop).then(settleEntries).then(giveBack(1))
    .then(all { assert(records.exists(r => r.origin == 1 and r.chain == 0) and not(listingInAuthorOrder)), stutter })
  run fixedKeepsOriginPastFrontierTest = retainedPassed(init)
    .then(all { assert(entries.size() == 1 and entries.forall(e => not(settled(e)))), giveBack(1) })
    .then(all { assert(listingInAuthorOrder and records.exists(r => r.origin == 0 and r.source == 1)), stutter })
}
