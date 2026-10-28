// Case 1: a withheld (lost) Writer vertex stalls the creator's own issuance.
//
// One Writer issues a chain w1..wN (wi depends on w(i-1), and on any creator
// local vertex it has already seen). Its copies reach the creator through a
// lossy, reordering transport: each copy in flight is delivered or lost. The
// creator admits a received vertex when every dependency is admitted (then
// drains pending vertices that became admissible), holds it as pending ingress
// otherwise (bounded: MAX_PENDING entries; a full set refuses the copy, which
// the transport then treats as lost), and repairs losses by asking for the
// sender's retained history (Track AA, room-network.ts): a lost copy goes back
// in flight. The creator's own local issue takes its dependencies from the
// admitted index (v3-live: frontier of registration.index) and is journaled at
// admission. The close cuts at the admitted index; pending ingress stays out.
//
// The creator's issue sizes its recovery census (prospectiveCreatorRuntimeCensus
// Overhead and the ordinary/held/readiness census reads): it must cover the
// recovery state at the issue, i.e. admitted rows + pending roots + the new row.
//
// Rule under test (census admission while pending ingress is non-empty):
//   BASE (current code): refuse the creator's issue while pending ingress is
//     non-empty ("prospective runtime census has unresolved ingress or rebase
//     dependencies"); every other creator issuance path has the same gate.
//   SOUND (proposal): admit the issue; carry the pending roots in the census at
//     their retained charge (already bounded by maxPendingEntries/maxPendingBytes)
//     and keep the local dependencies on the admitted index. Pending ingress is
//     always received (foreign) work, so no local issue can depend on it.
//   EVICT (candidate b): BASE plus eviction of a pending entry after a timeout
//     (nondeterministic here): safe, but refuses until the eviction fires and
//     discards honest work that repair would have completed.
// Broken controls: dependsOnPending (local dependencies include pending
// vertices), censusIgnoresPending (the census omits the pending roots),
// unboundedPending (no pending cap), closeIncludesPending (the cut takes pending
// vertices).
//
// Invariant that must not break (journalTopological): every journaled vertex's
// dependencies are journaled strictly earlier. A local issue therefore never
// references, or is ordered before, an unadmitted vertex.
module creatorPendingIngressCensus {
  pure val NW = 4            // Writer chain length
  pure val NC = 3            // creator local issues
  pure val MAX_PENDING = 2   // maxPendingEntries
  pure val MAX_LOSSES = 3    // finitely many losses
  pure val C0 = 100          // creator local vertex j is C0 + j

  // Rule selectors.
  type Mutants = { refuseWhilePending: bool, evict: bool, dependsOnPending: bool, censusIgnoresPending: bool,
                   unboundedPending: bool, closeIncludesPending: bool, noRepair: bool }
  pure val SOUND: Mutants = { refuseWhilePending: false, evict: false, dependsOnPending: false, censusIgnoresPending: false,
                              unboundedPending: false, closeIncludesPending: false, noRepair: false }
  pure val BASE: Mutants = { ...SOUND, refuseWhilePending: true }

  // Transport state per Writer vertex.
  pure val NONE = 0
  pure val FLIGHT = 1
  pure val LOST = 2
  pure val ARRIVED = 3

  pure val WRITERS = 1.to(NW)
  pure val LOCALS = 1.to(NC).map(j => C0 + j)
  pure val KEYS = WRITERS.union(LOCALS)

  var wIssued: int
  var cIssued: int
  var net: int -> int
  var deps: int -> Set[int]
  var admitted: Set[int]
  var pending: Set[int]
  var pos: int -> int          // journal position; 0 = not journaled
  var nextPos: int
  var losses: int
  var refused: int             // creator issues refused because of pending ingress
  var censusShort: bool        // some issue sized its census below its recovery state
  var closed: bool
  var cut: Set[int]
  var mutants: Mutants

  // Admit every pending vertex whose dependencies are admitted, in ascending
  // Writer order (topological: a Writer vertex depends only on lower Writer
  // vertices and on creator locals, which are admitted at issue).
  pure def drainStep(st: { adm: Set[int], pend: Set[int], p: int -> int, n: int }, i: int, d: int -> Set[int]):
      { adm: Set[int], pend: Set[int], p: int -> int, n: int } =
    if (st.pend.contains(i) and d.get(i).subseteq(st.adm))
      { adm: st.adm.union(Set(i)), pend: st.pend.exclude(Set(i)), p: st.p.set(i, st.n), n: st.n + 1 }
    else st
  pure def drain(st: { adm: Set[int], pend: Set[int], p: int -> int, n: int }, d: int -> Set[int]):
      { adm: Set[int], pend: Set[int], p: int -> int, n: int } =
    range(1, NW + 1).foldl(st, (acc, i) => drainStep(acc, i, d))

  action initWith(mu: Mutants): bool = all {
    wIssued' = 0, cIssued' = 0,
    net' = WRITERS.mapBy(_ => NONE),
    deps' = KEYS.mapBy(_ => Set()),
    admitted' = Set(), pending' = Set(),
    pos' = KEYS.mapBy(_ => 0), nextPos' = 1,
    losses' = 0, refused' = 0, censusShort' = false, closed' = false, cut' = Set(),
    mutants' = mu,
  }
  action init = initWith(SOUND)
  action initBase = initWith(BASE)
  action initBaseNoRepair = initWith({ ...BASE, noRepair: true })
  action initEvict = initWith({ ...BASE, evict: true })
  action initDependsOnPending = initWith({ ...SOUND, dependsOnPending: true })
  action initCensusIgnoresPending = initWith({ ...SOUND, censusIgnoresPending: true })
  action initUnboundedPending = initWith({ ...SOUND, unboundedPending: true })
  action initCloseIncludesPending = initWith({ ...SOUND, closeIncludesPending: true })

  // The Writer issues its next vertex; it may also depend on creator locals it has seen.
  action writerIssue: bool = all {
    not(closed), wIssued < NW,
    val i = wIssued + 1
    val seen = LOCALS.filter(c => pos.get(c) > 0)
    nondet extra = seen.powerset().oneOf()
    all {
      wIssued' = i,
      net' = net.set(i, FLIGHT),
      deps' = deps.set(i, (if (i > 1) Set(i - 1) else Set()).union(extra)),
    },
    cIssued' = cIssued, admitted' = admitted, pending' = pending, pos' = pos, nextPos' = nextPos,
    losses' = losses, refused' = refused, censusShort' = censusShort, closed' = closed, cut' = cut, mutants' = mutants,
  }

  // Non-adversarial loss of one copy in flight (stream reset, queue drop under jank).
  action lose(i: int): bool = all {
    net.get(i) == FLIGHT, losses < MAX_LOSSES,
    net' = net.set(i, LOST), losses' = losses + 1,
    wIssued' = wIssued, cIssued' = cIssued, deps' = deps, admitted' = admitted, pending' = pending, pos' = pos,
    nextPos' = nextPos, refused' = refused, censusShort' = censusShort, closed' = closed, cut' = cut, mutants' = mutants,
  }

  // A copy reaches the creator's live plane.
  action deliver(i: int): bool = all {
    not(closed), net.get(i) == FLIGHT,
    val known = admitted.contains(i) or pending.contains(i)
    val ready = deps.get(i).subseteq(admitted)
    val room = mutants.unboundedPending or pending.size() < MAX_PENDING
    if (known) all {
      net' = net.set(i, ARRIVED), admitted' = admitted, pending' = pending, pos' = pos, nextPos' = nextPos,
    } else if (ready) {
      val st = drain({ adm: admitted.union(Set(i)), pend: pending, p: pos.set(i, nextPos), n: nextPos + 1 }, deps)
      all { net' = net.set(i, ARRIVED), admitted' = st.adm, pending' = st.pend, pos' = st.p, nextPos' = st.n }
    } else if (room) all {
      net' = net.set(i, ARRIVED), admitted' = admitted, pending' = pending.union(Set(i)), pos' = pos, nextPos' = nextPos,
    } else all {
      // A full pending set refuses the copy (graph-rejected); repair may resend it.
      net' = net.set(i, LOST), admitted' = admitted, pending' = pending, pos' = pos, nextPos' = nextPos,
    },
    wIssued' = wIssued, cIssued' = cIssued, deps' = deps, losses' = losses, refused' = refused,
    censusShort' = censusShort, closed' = closed, cut' = cut, mutants' = mutants,
  }

  // Track AA: the creator asks the sender for its retained history; a lost copy is resent.
  action repair(i: int): bool = all {
    not(closed), not(mutants.noRepair), net.get(i) == LOST, not(admitted.contains(i)), not(pending.contains(i)),
    net' = net.set(i, FLIGHT),
    wIssued' = wIssued, cIssued' = cIssued, deps' = deps, admitted' = admitted, pending' = pending, pos' = pos,
    nextPos' = nextPos, losses' = losses, refused' = refused, censusShort' = censusShort, closed' = closed, cut' = cut,
    mutants' = mutants,
  }

  // Candidate (b): a pending entry times out and is discarded.
  action evict(i: int): bool = all {
    not(closed), mutants.evict, pending.contains(i),
    pending' = pending.exclude(Set(i)), net' = net.set(i, LOST),
    wIssued' = wIssued, cIssued' = cIssued, deps' = deps, admitted' = admitted, pos' = pos, nextPos' = nextPos,
    losses' = losses, refused' = refused, censusShort' = censusShort, closed' = closed, cut' = cut, mutants' = mutants,
  }

  // The creator's own local issue.
  action creatorIssue: bool = all {
    not(closed), cIssued < NC,
    val refuse = mutants.refuseWhilePending and pending.size() > 0
    val c = C0 + cIssued + 1
    val localDeps = if (mutants.dependsOnPending) admitted.union(pending) else admitted
    val sized = admitted.size() + (if (mutants.censusIgnoresPending) 0 else pending.size()) + 1
    val actual = admitted.size() + pending.size() + 1
    if (refuse) all {
      refused' = refused + 1, cIssued' = cIssued, deps' = deps, admitted' = admitted, pos' = pos, nextPos' = nextPos,
      censusShort' = censusShort,
    } else all {
      refused' = refused, cIssued' = cIssued + 1, deps' = deps.set(c, localDeps), admitted' = admitted.union(Set(c)),
      pos' = pos.set(c, nextPos), nextPos' = nextPos + 1, censusShort' = (censusShort or sized < actual),
    },
    wIssued' = wIssued, net' = net, pending' = pending, losses' = losses, closed' = closed, cut' = cut, mutants' = mutants,
  }

  // The creator closes the epoch at its admitted index.
  action close: bool = all {
    not(closed),
    closed' = true, cut' = if (mutants.closeIncludesPending) admitted.union(pending) else admitted,
    wIssued' = wIssued, cIssued' = cIssued, net' = net, deps' = deps, admitted' = admitted, pending' = pending,
    pos' = pos, nextPos' = nextPos, losses' = losses, refused' = refused, censusShort' = censusShort, mutants' = mutants,
  }

  action stutter: bool = all {
    closed,
    wIssued' = wIssued, cIssued' = cIssued, net' = net, deps' = deps, admitted' = admitted, pending' = pending,
    pos' = pos, nextPos' = nextPos, losses' = losses, refused' = refused, censusShort' = censusShort, closed' = closed,
    cut' = cut, mutants' = mutants,
  }

  action step = any {
    writerIssue,
    nondet i = WRITERS.oneOf()
    any { lose(i), deliver(i), repair(i), evict(i) },
    creatorIssue,
    close,
    stutter,
  }

  // ---- Invariants ----
  // The invariant that must not break: dependencies are journaled strictly earlier.
  val journalTopological: bool =
    KEYS.forall(v => pos.get(v) > 0 implies deps.get(v).forall(d => pos.get(d) > 0 and pos.get(d) < pos.get(v)))
  // The close cut is causally closed and holds only admitted vertices.
  val cutSound: bool =
    closed implies (cut.forall(v => admitted.contains(v)) and cut.forall(v => deps.get(v).subseteq(cut)))
  val pendingDisjoint: bool = admitted.intersect(pending) == Set()
  val pendingBounded: bool = pending.size() <= MAX_PENDING
  val censusCovers: bool = not(censusShort)
  val safety: bool = journalTopological and cutSound and pendingDisjoint and pendingBounded and censusCovers
  // Liveness proxy: a creator issue is never refused because of foreign pending ingress.
  val noPendingRefusal: bool = refused == 0
  val all_: bool = safety and noPendingRefusal

  // ---- Witness tests ----
  // Case 1: w1 admitted, w2 lost, w3 delivered -> pending; the creator issues.
  run case1Test = initWith(BASE)
    .then(writerIssue).then(deliver(1)).then(writerIssue).then(lose(2)).then(writerIssue).then(deliver(3))
    .then(all { assert(pending == Set(3)), creatorIssue })
    .then(all { assert(refused == 1 and cIssued == 0), repair(2) })
    .then(deliver(2))
    .then(all { assert(pending == Set() and admitted == Set(1, 2, 3)), creatorIssue })
    .then(all { assert(cIssued == 1 and refused == 1), close })
    .then(all { assert(safety and cut == Set(1, 2, 3, 101)), stutter })
  run case1SoundTest = init
    .then(writerIssue).then(deliver(1)).then(writerIssue).then(lose(2)).then(writerIssue).then(deliver(3))
    .then(creatorIssue)
    .then(all { assert(refused == 0 and cIssued == 1 and deps.get(101) == Set(1) and pending == Set(3)), close })
    .then(all { assert(safety and cut == Set(1, 101)), stutter })
  run dependsOnPendingTest = initDependsOnPending
    .then(writerIssue).then(deliver(1)).then(writerIssue).then(lose(2)).then(writerIssue).then(deliver(3))
    .then(creatorIssue)
    .then(all { assert(not(journalTopological)), close })
  run censusIgnoresPendingTest = initCensusIgnoresPending
    .then(writerIssue).then(deliver(1)).then(writerIssue).then(lose(2)).then(writerIssue).then(deliver(3))
    .then(creatorIssue)
    .then(all { assert(not(censusCovers)), close })
  run closeIncludesPendingTest = initCloseIncludesPending
    .then(writerIssue).then(deliver(1)).then(writerIssue).then(lose(2)).then(writerIssue).then(deliver(3))
    .then(close)
    .then(all { assert(not(cutSound)), stutter })
}
