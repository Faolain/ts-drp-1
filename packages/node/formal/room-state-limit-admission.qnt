// MODEL (rows 96-98; fix/walker-230b-batch-fallback a5238239, merged 4a8e4cf1 into cand/int7-wo): the
// room's application state limit (ROOM_APPLICATION_STATE_BYTES = 32,768 canonical bytes) is enforced
// at admission, so the seal's fold never refuses and no move is lost.
//
// Two modules, one per path:
//
// roomStateLimitAdmission (new moves; v3-live applicationStateAdmits / issueLocal, v3-room issueOwned).
//   The epoch's application state is an integer (abstract bytes, LIMIT). A move changes it by its delta
//   (a removal shrinks it; the state never goes below 0). The Writer's owned requests issued together are
//   one batch (one application vertex). issueOwned judges a segment of the batch as one vertex:
//   - it fits: every move of the segment is admitted;
//   - it does not and has more than one move: the plane probes the longest proper prefix that fits
//     (applicationStateAdmittedPrefix) and answers split-required; issueOwned issues the prefix, then the
//     rest (each judged again on its exact bytes). With no fitting prefix (the first move alone crosses),
//     that move is refused typed (V3RoomStateLimitRefused) and the rest is judged on its own;
//   - a single move that does not fit is refused typed.
//   Another Writer's move reaches the creator's ingress (receive) and is judged by the same check; it can
//   change the state between the probe and the prefix's issue (the probe is advisory).
//   Row 98: after a machine install the bound's seed runs in deferred turns (seedPending); an admission
//   while it is pending is judged by the exact fold, never admitted unchecked.
//   The seal's fold refuses a state past the limit: the room stalls for good (wedged).
//   The application gets every refusal; an untyped one it cannot tell from a failure (the shipped policy
//   and the hot-writer test stop on it: frozen).
//
//   Variants (`mutants`):
//     noCheck     before row 96: the fold machine took the 256 MiB snapshot bound, no state check;
//     wholeBatch  before 8085e0a6: a batch whose later moves cross the limit is refused whole;
//     untyped     before 0597d534: the refusal is a plain TypeError;
//     seedBypass  row 98 without the exact-fold fallback: admitted unchecked while the seed is pending.
//   Invariants: stateWithinLimit, noWedge, writerKeepsPlaying (no untyped refusal), noOverRefusal (a move
//   is refused only when it does not fit on its own at its judgement), prefixCommitted (a batch judged
//   without interference commits exactly its longest fitting prefix, and the move after it is refused),
//   answered (every move before the cursor has an answer). safety = all.
//
// refusedReplayDrainChunk (settlement replays of displaced own rows; v3-room drain + issueSettlement +
//   handBackRefusedReplay, rows 93/96/97, 17d4bbc4).
//   A chunk of K displaced rows is first issued as one batch, judged before signing by one exact refold
//   with the whole chain. A refusal before signing sends the chunk to singles. Each single is judged by
//   the same state check; a transient refusal (input capacity, snapshot readiness, ...) is retried
//   RETRIES times; a lasting refusal (the state limit) or an exhausted transient one hands the move back
//   (expire + hand-back record, one plan write), or, with no free record, leaves it live (deferred to the
//   next install). 17d4bbc4: a chunk's transient refusal counts as its head row's first attempt.
//   Variants: noChunkCheck (the batch admitted without the refold), doubleFirstAttempt (before
//   17d4bbc4: the head's single attempts again after the chunk's transient refusal), dropRefused (a
//   refused replay expired unrecorded), stallOnRefusal (before row 97: the refusal throws out of the
//   install). Invariants: stateWithinLimit, transientAttemptsBounded (at most 1 + RETRIES transient
//   refusals per row), noLostMove, noStall, settled (every row admitted, handed back or deferred once the
//   chunk is done). safety = all.
//
// Commands (packages/node/formal; JAVA_HOME=$(brew --prefix openjdk@17), PATH=$JAVA_HOME/bin:$PATH):
//   quint typecheck room-state-limit-admission.qnt
//   quint test room-state-limit-admission.qnt --main roomStateLimitAdmission --match 'Test$'
//   quint test room-state-limit-admission.qnt --main refusedReplayDrainChunk --match 'Test$'
//   A="quint verify room-state-limit-admission.qnt --main roomStateLimitAdmission --step step \
//      --backend apalache --apalache-version=0.56.1 --max-steps=7 --invariants safety"
//   $A --init init                                   # [ok]
//   $A --init initNoCheck | initWholeBatch | initUntyped | initSeedBypass   # each: violation
//   B="quint verify room-state-limit-admission.qnt --main refusedReplayDrainChunk --step step \
//      --backend apalache --apalache-version=0.56.1 --max-steps=8 --invariants safety"
//   $B --init init                                   # [ok]
//   $B --init initNoChunkCheck | initDoubleFirstAttempt | initDropRefused | initStallOnRefusal  # violation
module roomStateLimitAdmission {
  pure val LIMIT = 3
  pure val N = 3                    // moves per batch, at most
  pure val DELTAS = Set(-1, 0, 1, 2)
  pure val MAX_BATCHES = 2
  pure val MAX_RECEIVED = 2
  pure val IDX = 0.to(N - 1)
  type Mutants = { noCheck: bool, wholeBatch: bool, untyped: bool, seedBypass: bool }
  pure val SOUND: Mutants = { noCheck: false, wholeBatch: false, untyped: false, seedBypass: false }

  var stateBytes: int
  var batch: int -> int         // the batch's moves (their deltas), indices 0..N-1
  var len: int                  // the batch's length (0 before the first batch)
  var status: int -> str        // "pending" | "admitted" | "refused" (typed) | "untyped"
  var cursor: int               // issueOwned: the next unanswered move
  var cuts: Set[int]            // ends of the segments the split left pending, each in (cursor, len)
  var expected: int             // ghost: the longest prefix that fit when the batch was offered
  var interfered: bool          // ghost: a received move was admitted while the batch was in flight
  var seedPending: bool
  var wedged: bool
  var frozen: bool
  var refusedFitting: bool      // ghost: a move refused although it fit on its own at its judgement
  var batches: int
  var received: int
  var mutants: Mutants

  // The state after applying moves [lo, hi) of b to s, in order (never below 0).
  pure def applied(s: int, b: int -> int, lo: int, hi: int): int =
    range(0, N).foldl(s, (acc, i) => if (i >= lo and i < hi) { val v = acc + b.get(i) if (v < 0) 0 else v } else acc)
  pure def fits(s: int, b: int -> int, lo: int, hi: int): bool = applied(s, b, lo, hi) <= LIMIT
  // The admission check as each variant runs it (the seed's exact-fold fallback is exact).
  def admits(lo: int, hi: int): bool =
    if (mutants.noCheck) true else if (seedPending and mutants.seedBypass) true else fits(stateBytes, batch, lo, hi)
  pure def longestFit(s: int, b: int -> int, k: int): int =
    range(0, N + 1).foldl(0, (best, j) => if (j <= k and fits(s, b, 0, j)) j else best)
  def segEnd: int = cuts.fold(len, (m, c) => if (c < m) c else m)
  def refusal: str = if (mutants.untyped) "untyped" else "refused"

  action initWith(mu: Mutants): bool = all {
    stateBytes' = 0, batch' = IDX.mapBy(i => 0), len' = 0, status' = IDX.mapBy(i => "pending"), cursor' = 0,
    cuts' = Set(), expected' = 0, interfered' = false, seedPending' = false, wedged' = false, frozen' = false,
    refusedFitting' = false, batches' = 0, received' = 0, mutants' = mu,
  }
  action init = initWith(SOUND)
  action initNoCheck = initWith({ ...SOUND, noCheck: true })
  action initWholeBatch = initWith({ ...SOUND, wholeBatch: true })
  action initUntyped = initWith({ ...SOUND, untyped: true })
  action initSeedBypass = initWith({ ...SOUND, seedBypass: true })

  action keepRest = all {
    seedPending' = seedPending, wedged' = wedged, batches' = batches, received' = received, mutants' = mutants,
  }
  action keepBatch = all {
    batch' = batch, len' = len, status' = status, cursor' = cursor, cuts' = cuts, expected' = expected,
    frozen' = frozen, refusedFitting' = refusedFitting,
  }

  // The Writer issues k owned requests together (one batch).
  action offerWith(b: int -> int, k: int): bool = all {
    cursor >= len, batches < MAX_BATCHES, k >= 1, k <= N,
    batch' = b, len' = k, status' = IDX.mapBy(i => "pending"), cursor' = 0, cuts' = Set(),
    expected' = longestFit(stateBytes, b, k), interfered' = false, batches' = batches + 1,
    stateBytes' = stateBytes, seedPending' = seedPending, wedged' = wedged, frozen' = frozen,
    refusedFitting' = refusedFitting, received' = received, mutants' = mutants,
  }
  action offer = {
    nondet b = IDX.setOfMaps(DELTAS).oneOf()
    nondet k = 1.to(N).oneOf()
    offerWith(b, k)
  }

  // issueOwned judges the current segment [cursor, segEnd) as one vertex.
  action refuseHead(e: int): bool = all {
    status' = status.set(cursor, refusal), cursor' = cursor + 1, cuts' = cuts.exclude(Set(cursor + 1)),
    frozen' = if (mutants.untyped) true else frozen,
    refusedFitting' = if (refusedFitting) true else fits(stateBytes, batch, cursor, cursor + 1),
    stateBytes' = stateBytes,
  }
  action issue: bool = all {
    cursor < len,
    val e = segEnd
    val p = range(0, N).foldl(0, (best, j) => if (j >= 1 and cursor + j < e and admits(cursor, cursor + j)) j else best)
    if (admits(cursor, e)) all {
      stateBytes' = applied(stateBytes, batch, cursor, e),
      status' = IDX.mapBy(i => if (i >= cursor and i < e) "admitted" else status.get(i)),
      cursor' = e, cuts' = cuts.exclude(Set(e)), frozen' = frozen, refusedFitting' = refusedFitting,
    } else if (e - cursor > 1 and mutants.wholeBatch) all {
      // Refused whole: every move of the segment.
      status' = IDX.mapBy(i => if (i >= cursor and i < e) refusal else status.get(i)),
      cursor' = e, cuts' = cuts.exclude(Set(e)),
      frozen' = if (mutants.untyped) true else frozen,
      refusedFitting' = if (refusedFitting) true else IDX.exists(i => i >= cursor and i < e and fits(stateBytes, batch, i, i + 1)),
      stateBytes' = stateBytes,
    } else if (e - cursor > 1 and p > 0) all {
      // split-required: the prefix, then the rest.
      cuts' = cuts.union(Set(cursor + p)), status' = status, cursor' = cursor, stateBytes' = stateBytes,
      frozen' = frozen, refusedFitting' = refusedFitting,
    } else refuseHead(e),
    batch' = batch, len' = len, expected' = expected, interfered' = interfered, keepRest,
  }

  // Another Writer's move at the creator's ingress, judged by the same check.
  action receiveWith(d: int): bool = all {
    received < MAX_RECEIVED, received' = received + 1,
    val v = if (stateBytes + d < 0) 0 else stateBytes + d
    val ok = if (mutants.noCheck) true else if (seedPending and mutants.seedBypass) true else v <= LIMIT
    all {
      stateBytes' = if (ok) v else stateBytes,
      interfered' = if (interfered) true else (ok and cursor < len),
    },
    keepBatch, seedPending' = seedPending, wedged' = wedged, batches' = batches, mutants' = mutants,
  }
  action receive = { nondet d = DELTAS.oneOf() receiveWith(d) }

  // Row 98: a machine install starts the deferred seed; a deferred turn finishes it.
  action install = all {
    not(seedPending), seedPending' = true,
    stateBytes' = stateBytes, interfered' = interfered, keepBatch, wedged' = wedged, batches' = batches,
    received' = received, mutants' = mutants,
  }
  action seedTurn = all {
    seedPending, seedPending' = false,
    stateBytes' = stateBytes, interfered' = interfered, keepBatch, wedged' = wedged, batches' = batches,
    received' = received, mutants' = mutants,
  }
  // The seal folds the epoch: past the limit it refuses, and the room stalls for good.
  action seal = all {
    wedged' = if (wedged) true else stateBytes > LIMIT,
    stateBytes' = stateBytes, interfered' = interfered, keepBatch, seedPending' = seedPending,
    batches' = batches, received' = received, mutants' = mutants,
  }

  action step = any { offer, issue, receive, install, seedTurn, seal }

  val stateWithinLimit = stateBytes <= LIMIT
  val noWedge = not(wedged)
  val writerKeepsPlaying = not(frozen)
  val noOverRefusal = not(refusedFitting)
  val prefixCommitted =
    if (len == 0 or cursor < len or interfered) true
    else IDX.forall(i => if (i < expected) status.get(i) == "admitted" else if (i == expected and i < len) status.get(i) != "admitted" else true)
  val answered = IDX.forall(i => if (i < cursor) status.get(i) != "pending" else true)
  val safety = stateWithinLimit and noWedge and writerKeepsPlaying and noOverRefusal and prefixCommitted and answered

  // Witnesses (violated = reachable): a batch split (some admitted, some refused), and a refusal then
  // a later admission in the same batch (the writer keeps playing).
  val noSplit = not(IDX.exists(i => status.get(i) == "admitted") and IDX.exists(i => status.get(i) == "refused"))
  val noAdmitAfterRefusal = not(IDX.exists(i => IDX.exists(j => i < j and status.get(i) == "refused" and status.get(j) == "admitted")))

  pure val B_SPLIT = Map(0 -> 1, 1 -> 1, 2 -> 2)    // at state 1: [1, 1] fits (3), the third crosses
  pure val B_CROSS_FIRST = Map(0 -> 2, 1 -> 0, 2 -> 0)   // at state 2: the first move alone crosses
  run prefixSplitTest = init.then(receiveWith(1)).then(offerWith(B_SPLIT, 3))
    .then(all { assert(expected == 2), issue }).then(all { assert(cuts == Set(2)), issue })
    .then(all { assert(stateBytes == 3 and status.get(1) == "admitted"), issue })
    .then(all { assert(status.get(2) == "refused" and cursor == 3 and safety and not(noSplit)), seal })
    .then(all { assert(noWedge), receiveWith(-1) })
  // The first move crosses: refused typed; the rest is judged on its own (a non-growing move is admitted).
  run firstCrossesTest = init.then(receiveWith(2)).then(offerWith(B_CROSS_FIRST, 3))
    .then(all { assert(expected == 0), issue }).then(all { assert(status.get(0) == "refused" and cursor == 1), issue })
    .then(all { assert(status.get(1) == "admitted" and status.get(2) == "admitted" and stateBytes == 2 and safety
      and not(noAdmitAfterRefusal)), seal })
  run wholeBatchRefusedTest = initWholeBatch.then(receiveWith(1)).then(offerWith(B_SPLIT, 3)).then(issue)
    .then(all { assert(cursor == 3 and status.get(0) == "refused" and not(noOverRefusal) and not(prefixCommitted)), seal })
  run noCheckWedgesTest = initNoCheck.then(receiveWith(1)).then(offerWith(B_SPLIT, 3)).then(issue)
    .then(all { assert(stateBytes == 5 and not(stateWithinLimit)), seal }).then(all { assert(wedged), seal })
  run untypedFreezesTest = initUntyped.then(receiveWith(1)).then(offerWith(B_SPLIT, 3)).then(issue).then(issue).then(issue)
    .then(all { assert(status.get(2) == "untyped" and frozen and not(writerKeepsPlaying)), seal })
  run seedBypassTest = initSeedBypass.then(receiveWith(2)).then(install).then(receiveWith(2))
    .then(all { assert(stateBytes == 4 and not(stateWithinLimit)), seal })
  run seedPendingExactTest = init.then(receiveWith(2)).then(install).then(receiveWith(2))
    .then(all { assert(stateBytes == 2 and safety), seedTurn })
  // The probe is advisory: a received move between the probe and the prefix's issue makes the prefix
  // cross; it is split again (or refused), never admitted past the limit.
  run probeRaceTest = init.then(offerWith(B_SPLIT, 3)).then(issue)
    .then(all { assert(cuts == Set(2)), receiveWith(2) }).then(issue)
    .then(all { assert(cuts == Set(1, 2)), issue }).then(issue).then(issue)
    .then(all { assert(status.get(0) == "admitted" and status.get(1) == "refused" and status.get(2) == "refused" and
      stateBytes == 3 and safety), unchangedSkip })
  action unchangedSkip = all { stateBytes' = stateBytes, interfered' = interfered, keepBatch, keepRest }
}

module refusedReplayDrainChunk {
  pure val LIMIT = 3
  pure val K = 2                     // rows in the chunk
  pure val RETRIES = 2               // SETTLEMENT_TRANSIENT_RETRIES (7)
  pure val RECORDS = 1               // free hand-back records
  pure val ROWS = 0.to(K - 1)
  type Mutants = { noChunkCheck: bool, doubleFirstAttempt: bool, dropRefused: bool, stallOnRefusal: bool }
  pure val SOUND: Mutants = { noChunkCheck: false, doubleFirstAttempt: false, dropRefused: false, stallOnRefusal: false }

  var stateBytes: int
  var delta: int -> int              // each row's replay growth
  var phase: str                     // "batch" | "singles" | "done"
  var row: int                       // the singles cursor
  var tries: int                     // attempts of the current single (the chunk's credit included)
  var credit: bool                   // the chunk's transient refusal, pending as the head's first attempt
  var transients: int -> int         // transient refusals per row
  var outcome: int -> str            // "pending" | "admitted" | "handedBack" | "deferred" | "dropped"
  var records: int                   // free hand-back records left
  var stalled: bool
  var mutants: Mutants

  pure def chainFits(s: int, d: int -> int): bool = s + ROWS.fold(0, (a, i) => a + d.get(i)) <= LIMIT

  action initWith(mu: Mutants): bool = {
    nondet s = 0.to(LIMIT).oneOf()
    nondet d = ROWS.setOfMaps(0.to(2)).oneOf()
    all {
      stateBytes' = s, delta' = d, phase' = "batch", row' = 0, tries' = 0, credit' = false,
      transients' = ROWS.mapBy(i => 0), outcome' = ROWS.mapBy(i => "pending"), records' = RECORDS,
      stalled' = false, mutants' = mu,
    }
  }
  action init = initWith(SOUND)
  action initNoChunkCheck = initWith({ ...SOUND, noChunkCheck: true })
  action initDoubleFirstAttempt = initWith({ ...SOUND, doubleFirstAttempt: true })
  action initDropRefused = initWith({ ...SOUND, dropRefused: true })
  action initStallOnRefusal = initWith({ ...SOUND, stallOnRefusal: true })

  action keepAll = all {
    stateBytes' = stateBytes, delta' = delta, phase' = phase, row' = row, tries' = tries, credit' = credit,
    transients' = transients, outcome' = outcome, records' = records, stalled' = stalled, mutants' = mutants,
  }

  // The chunk as one batch: refused transiently (the plane's refusal), admitted whole when the chain's
  // refold fits, else (the state limit) refused before signing: every row goes to singles.
  action batchWith(transient: bool): bool = all {
    phase == "batch", not(stalled),
    if (transient) all {
      phase' = "singles", credit' = true, transients' = transients.set(0, transients.get(0) + 1),
      stateBytes' = stateBytes, outcome' = outcome,
    } else if (mutants.noChunkCheck or chainFits(stateBytes, delta)) all {
      phase' = "done", credit' = false, transients' = transients,
      stateBytes' = stateBytes + ROWS.fold(0, (a, i) => a + delta.get(i)), outcome' = ROWS.mapBy(i => "admitted"),
    } else all {
      phase' = "singles", credit' = false, transients' = transients, stateBytes' = stateBytes, outcome' = outcome,
    },
    delta' = delta, row' = row, tries' = tries, records' = records, stalled' = stalled, mutants' = mutants,
  }

  // The current single's refusal is final (lasting, or transient after its retries): hand it back.
  action handBack: bool = all {
    if (mutants.stallOnRefusal) all { stalled' = true, outcome' = outcome, records' = records, row' = row, phase' = phase }
    else all {
      outcome' = outcome.set(row,
        if (mutants.dropRefused) "dropped" else if (records > 0) "handedBack" else "deferred"),
      records' = if (not(mutants.dropRefused) and records > 0) records - 1 else records,
      row' = row + 1, phase' = if (row + 1 >= K) "done" else phase, stalled' = false,
    },
    tries' = 0, credit' = false,
  }
  action singleWith(transient: bool): bool = all {
    phase == "singles", row < K, not(stalled),
    // The chunk's transient refusal is the head's first attempt (17d4bbc4).
    val credited = credit and row == 0 and tries == 0 and not(mutants.doubleFirstAttempt)
    val isTransient = if (credited) true else transient
    val count = if (credited) 0 else if (isTransient) 1 else 0
    if (not(isTransient) and stateBytes + delta.get(row) <= LIMIT) all {
      stateBytes' = stateBytes + delta.get(row), outcome' = outcome.set(row, "admitted"),
      row' = row + 1, phase' = if (row + 1 >= K) "done" else phase, tries' = 0, credit' = false,
      transients' = transients, records' = records, stalled' = stalled,
    } else if (not(isTransient)) all { handBack, transients' = transients, stateBytes' = stateBytes }
    else if (tries + 1 >= 1 + RETRIES) all {
      // Still transient after the attempt and its retries: handed back as transient-exhausted.
      handBack, transients' = transients.set(row, transients.get(row) + count), stateBytes' = stateBytes,
    } else all {
      tries' = tries + 1, credit' = false, transients' = transients.set(row, transients.get(row) + count),
      stateBytes' = stateBytes, outcome' = outcome, row' = row, phase' = phase, records' = records, stalled' = stalled,
    },
    delta' = delta, mutants' = mutants,
  }
  // The install goes on once the chunk is settled (or the install failed): stutter, so a finished chunk
  // is not a deadlock.
  action finished = all { if (phase == "done") true else stalled, keepAll }
  action step = any {
    nondet t = Set(true, false).oneOf()
    any { batchWith(t), singleWith(t) },
    finished,
  }

  val stateWithinLimit = stateBytes <= LIMIT
  val transientAttemptsBounded = ROWS.forall(i => transients.get(i) <= 1 + RETRIES)
  val noLostMove = ROWS.forall(i => outcome.get(i) != "dropped")
  val noStall = not(stalled)
  val settled = if (phase != "done") true else ROWS.forall(i => outcome.get(i) != "pending")
  val safety = stateWithinLimit and transientAttemptsBounded and noLostMove and noStall and settled

  // Witnesses (violated = reachable).
  val noHandBack = ROWS.forall(i => outcome.get(i) != "handedBack")
  val noTransientExhausted = ROWS.forall(i => transients.get(i) < 1 + RETRIES)

  action start(s: int, d: int -> int, mu: Mutants): bool = all {
    stateBytes' = s, delta' = d, phase' = "batch", row' = 0, tries' = 0, credit' = false,
    transients' = ROWS.mapBy(i => 0), outcome' = ROWS.mapBy(i => "pending"), records' = RECORDS,
    stalled' = false, mutants' = mu,
  }
  // The chunk crosses: singles admit the head and hand the crossing row back.
  run crossingChunkTest = start(1, Map(0 -> 1, 1 -> 2), SOUND).then(batchWith(false))
    .then(all { assert(phase == "singles"), singleWith(false) }).then(singleWith(false))
    .then(all { assert(outcome.get(0) == "admitted" and outcome.get(1) == "handedBack" and stateBytes == 2 and safety), keepAll })
  // The chunk's transient refusal is the head's first attempt: 1 + RETRIES transient refusals in all.
  run creditTest = start(0, Map(0 -> 1, 1 -> 1), SOUND).then(batchWith(true)).then(singleWith(true))
    .then(singleWith(true)).then(singleWith(true)).then(all { assert(transients.get(0) == 3 and outcome.get(0) == "handedBack" and safety), keepAll })
  run doubleFirstAttemptTest = start(0, Map(0 -> 1, 1 -> 1), { ...SOUND, doubleFirstAttempt: true })
    .then(batchWith(true)).then(singleWith(true)).then(singleWith(true)).then(singleWith(true))
    .then(all { assert(transients.get(0) == 4 and not(transientAttemptsBounded)), keepAll })
  run noChunkCheckTest = start(2, Map(0 -> 1, 1 -> 1), { ...SOUND, noChunkCheck: true }).then(batchWith(false))
    .then(all { assert(stateBytes == 4 and not(stateWithinLimit)), keepAll })
  run dropRefusedTest = start(3, Map(0 -> 1, 1 -> 0), { ...SOUND, dropRefused: true }).then(batchWith(false)).then(singleWith(false))
    .then(all { assert(outcome.get(0) == "dropped" and not(noLostMove)), keepAll })
  run recordsFullDefersTest = start(3, Map(0 -> 1, 1 -> 1), SOUND).then(batchWith(false)).then(singleWith(false))
    .then(singleWith(false)).then(all { assert(outcome.get(0) == "handedBack" and outcome.get(1) == "deferred" and safety), keepAll })
}
