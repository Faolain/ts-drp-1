// MODEL (rows 96-97, hot-writer loss verify-int7wo2/policy1.log): a move the application was told was
// accepted is in the converged state, or the application was told it did not happen.
//
// The owner rule. The creator is the only admitter of the room's application state limit (row 96): its own
// moves and every received row are judged against its state, so no closed state passes LIMIT. A Writer's
// admission is advisory: it judges a move against its own view (the closed state of the epoch it installed,
// plus its own rows and the creator rows it received), which lacks the creator's concurrent moves. The
// Writer's application is told "accepted" when the Writer admits (issue() resolves).
// A Writer row the creator's cut excludes (it arrived after the seal, or the creator's ingress refused it)
// is displaced: the Writer's next install replays it against the new closed state. A replay the Writer's
// own admission refuses is given back (row 97: a hand-back record, settlementStatus().undelivered); the
// shipped member policy offers it again with its record, and when the Writer's admission refuses it again
// the policy declines it (the record is dropped) and calls hooks.onDeclined(V3RoomMoveDeclined).
// Whether the application learns of the decline is the application's own wiring (`subscribed`).
//
// Moves: Writer moves "w0", "w1"; creator moves "c0", "c1"; each grows the state by 1 (LIMIT 2).
//
// Variants (`mutants`):
//   unsubscribed    the hot-writer harness before this fix: its books (accepted = issue resolved) were fed
//                   only onError, and a decline never reaches onError. Pre-fix behaviour.
//   dropRefused     a refused replay is expired with no hand-back (row 97 without its records);
//   writerTrusted   the creator's ingress trusts the Writer's admission (no check of received rows).
// Invariants:
//   stateWithinLimit  the creator's state (closed + its current epoch) never passes LIMIT;
//   toldOrCarried     the owner rule's promise to the application: a move it was told was accepted is
//                     carried (in the closed state, the creator's or the Writer's current epoch, a live row
//                     of the creator's epoch, or a listed hand-back the application can read), or the
//                     application was told it did not happen. A move in no carrier is gone for good (a
//                     closed epoch never changes and only these carry a move into one).
//   convergedAccounted  once the room is quiet (the Writer installed the creator's epoch, nothing in flight,
//                     no hand-back listed), every move the application holds as accepted (accepted less
//                     the ones it was told were declined) is in the converged state.
//   safety = stateWithinLimit and toldOrCarried and convergedAccounted.
//   noDecline (witness, violated = reachable): the race of the hot-writer run reaches a decline.
//
// Commands (from the repository root, F=$PWD/packages/node/formal/admitted-move-state-limit-race.qnt: npx
// resolves a relative path against the workspace package; export JAVA_HOME=/opt/homebrew/opt/openjdk@17
// PATH=$JAVA_HOME/bin:$PATH). Outcomes 2026-11-20: .logs/realtime-resume-2026-11-10/hot-writer-loss/quint/.
//   npx quint typecheck $F
//   npx quint test $F --main admittedMoveStateLimitRace --match 'Test$'                     # 4 passing
//   npx quint run $F --main admittedMoveStateLimitRace --init init --step step --invariant safety \
//     --max-steps 12 --max-samples 20000                                                   # [ok]
//     (--init initPreFix | initDropRefused | initWriterTrusted: each [violation])
//   V="npx quint verify $F --main admittedMoveStateLimitRace --step step --backend apalache \
//      --apalache-version=0.56.1 --max-steps=7"
//   $V --init init --invariants safety                  # [ok] (131 s)
//   $V --init initPreFix --invariants safety            # [violation]: w0, w1 admitted by the Writer, c0 by
//                                                       #   the creator; the install hands w0 back; declined;
//                                                       #   the books never told (toldOrCarried)
//   $V --init initDropRefused --invariants safety       # [violation] (toldOrCarried)
//   $V --init initWriterTrusted --invariants safety     # [violation] (stateWithinLimit)
//   $V --init init --invariants noDecline               # [violation]: the race is reachable on the fix too
module admittedMoveStateLimitRace {
  pure val LIMIT = 2
  pure val MAX_EPOCH = 3
  pure val WMOVES = Set("w0", "w1")
  pure val CMOVES = Set("c0", "c1")
  pure val EPOCHS = 0.to(MAX_EPOCH)
  type Mutants = { unsubscribed: bool, dropRefused: bool, writerTrusted: bool }
  pure val SOUND: Mutants = { unsubscribed: false, dropRefused: false, writerTrusted: false }

  var epoch: int                       // the creator's epoch
  var closedAt: int -> Set[str]        // the closed state each epoch starts from (cumulative)
  var creatorGraph: Set[str]           // moves the creator admitted in its epoch
  var writerEpoch: int                 // the epoch the Writer installed
  var writerGraph: Set[str]            // the Writer's view of its epoch: its own rows and received creator rows
  var inflight: Set[(str, int)]        // Writer rows sent to the creator, with the epoch they were signed in
  var handedBack: Set[str]             // listed hand-back records (settlementStatus().undelivered)
  var issued: Set[str]                 // moves offered by their application (once each)
  var accepted: Set[str]               // the application was told "accepted"
  var refused: Set[str]                // the application was told a typed refusal (a new move at the limit)
  var declined: Set[str]               // the policy declined (the record is dropped)
  var toldDeclined: Set[str]           // the application was told of the decline (hooks.onDeclined)
  var mutants: Mutants

  def creatorState: Set[str] = closedAt.get(epoch).union(creatorGraph)
  def writerView: Set[str] = closedAt.get(writerEpoch).union(writerGraph)
  pure def fitsOne(state: Set[str]): bool = state.size() + 1 <= LIMIT

  action initWith(mu: Mutants): bool = all {
    epoch' = 0, closedAt' = EPOCHS.mapBy(e => Set()), creatorGraph' = Set(), writerEpoch' = 0,
    writerGraph' = Set(), inflight' = Set(), handedBack' = Set(), issued' = Set(), accepted' = Set(),
    refused' = Set(), declined' = Set(), toldDeclined' = Set(), mutants' = mu,
  }
  action init = initWith(SOUND)
  action initPreFix = initWith({ ...SOUND, unsubscribed: true })
  action initDropRefused = initWith({ ...SOUND, dropRefused: true })
  action initWriterTrusted = initWith({ ...SOUND, writerTrusted: true })

  action keepBooks = all { issued' = issued, accepted' = accepted, refused' = refused, declined' = declined,
    toldDeclined' = toldDeclined }

  // The Writer's application issues a new move; the Writer's own (advisory) check judges it.
  action writerIssue(m: str): bool = all {
    WMOVES.contains(m), not(issued.contains(m)), issued' = issued.union(Set(m)),
    if (fitsOne(writerView)) all {
      writerGraph' = writerGraph.union(Set(m)), inflight' = inflight.union(Set((m, writerEpoch))),
      accepted' = accepted.union(Set(m)), refused' = refused,
    } else all {
      writerGraph' = writerGraph, inflight' = inflight, accepted' = accepted, refused' = refused.union(Set(m)),
    },
    epoch' = epoch, closedAt' = closedAt, creatorGraph' = creatorGraph, writerEpoch' = writerEpoch,
    handedBack' = handedBack, declined' = declined, toldDeclined' = toldDeclined, mutants' = mutants,
  }

  // The creator's application issues a new move; the creator's check is authoritative.
  action creatorIssue(m: str): bool = all {
    CMOVES.contains(m), not(issued.contains(m)), issued' = issued.union(Set(m)),
    if (fitsOne(creatorState)) all {
      creatorGraph' = creatorGraph.union(Set(m)), accepted' = accepted.union(Set(m)), refused' = refused,
    } else all { creatorGraph' = creatorGraph, accepted' = accepted, refused' = refused.union(Set(m)) },
    epoch' = epoch, closedAt' = closedAt, writerEpoch' = writerEpoch, writerGraph' = writerGraph,
    inflight' = inflight, handedBack' = handedBack, declined' = declined, toldDeclined' = toldDeclined,
    mutants' = mutants,
  }

  // A Writer row reaches the creator's ingress: admitted only in the creator's epoch and within the limit.
  // A refused or stale row is dropped from the wire (the Writer still holds it in its own epoch).
  action deliverWriterRow(m: str, e: int): bool = all {
    inflight.contains((m, e)), inflight' = inflight.exclude(Set((m, e))),
    creatorGraph' =
      if (e == epoch and not(creatorState.contains(m)) and (mutants.writerTrusted or fitsOne(creatorState)))
        creatorGraph.union(Set(m))
      else creatorGraph,
    epoch' = epoch, closedAt' = closedAt, writerEpoch' = writerEpoch, writerGraph' = writerGraph,
    handedBack' = handedBack, keepBooks, mutants' = mutants,
  }

  // A creator row of the Writer's epoch reaches the Writer's ingress (its own check; a refusal drops it).
  action deliverCreatorRow(m: str): bool = all {
    writerEpoch == epoch, creatorGraph.contains(m), not(writerGraph.contains(m)),
    writerGraph' = if (fitsOne(writerView)) writerGraph.union(Set(m)) else writerGraph,
    epoch' = epoch, closedAt' = closedAt, creatorGraph' = creatorGraph, writerEpoch' = writerEpoch,
    inflight' = inflight, handedBack' = handedBack, keepBooks, mutants' = mutants,
  }

  // The creator closes its epoch: the cut is exactly what it admitted.
  action seal: bool = all {
    epoch < MAX_EPOCH, epoch' = epoch + 1,
    closedAt' = closedAt.set(epoch + 1, creatorState), creatorGraph' = Set(),
    writerEpoch' = writerEpoch, writerGraph' = writerGraph, inflight' = inflight, handedBack' = handedBack,
    keepBooks, mutants' = mutants,
  }

  // The Writer installs its next epoch. Its own rows the cut excludes are displaced and replayed against
  // the new closed state (one at a time, in a fixed order); a replay its admission refuses is handed back.
  action install: bool = all {
    writerEpoch < epoch,
    val target = writerEpoch + 1
    val cut = closedAt.get(target)
    val displaced = writerGraph.intersect(WMOVES).exclude(cut)
    val replayed = displaced.fold(Set(), (kept, m) => if (cut.union(kept).size() + 1 <= LIMIT) kept.union(Set(m)) else kept)
    val refusedReplays = displaced.exclude(replayed)
    all {
      writerEpoch' = target, writerGraph' = replayed,
      inflight' = inflight.union(replayed.map(m => (m, target))),
      handedBack' = if (mutants.dropRefused) handedBack else handedBack.union(refusedReplays),
    },
    epoch' = epoch, closedAt' = closedAt, creatorGraph' = creatorGraph, keepBooks, mutants' = mutants,
  }

  // The member policy offers a given-back move again with its record: admitted (the record is consumed), or
  // refused for good and declined (the record is dropped; onDeclined tells a subscribed application).
  action answerGivenBack(m: str): bool = all {
    handedBack.contains(m), handedBack' = handedBack.exclude(Set(m)),
    if (fitsOne(writerView)) all {
      writerGraph' = writerGraph.union(Set(m)), inflight' = inflight.union(Set((m, writerEpoch))),
      declined' = declined, toldDeclined' = toldDeclined,
    } else all {
      writerGraph' = writerGraph, inflight' = inflight, declined' = declined.union(Set(m)),
      toldDeclined' = if (mutants.unsubscribed) toldDeclined else toldDeclined.union(Set(m)),
    },
    epoch' = epoch, closedAt' = closedAt, creatorGraph' = creatorGraph, writerEpoch' = writerEpoch,
    issued' = issued, accepted' = accepted, refused' = refused, mutants' = mutants,
  }

  action stutter: bool = all {
    epoch' = epoch, closedAt' = closedAt, creatorGraph' = creatorGraph, writerEpoch' = writerEpoch,
    writerGraph' = writerGraph, inflight' = inflight, handedBack' = handedBack, keepBooks, mutants' = mutants,
  }

  action step = any {
    nondet m = WMOVES.oneOf()
    writerIssue(m),
    nondet c = CMOVES.oneOf()
    creatorIssue(c),
    nondet r = WMOVES.oneOf()
    nondet e = EPOCHS.oneOf()
    deliverWriterRow(r, e),
    nondet d = CMOVES.oneOf()
    deliverCreatorRow(d),
    seal,
    install,
    nondet g = WMOVES.oneOf()
    answerGivenBack(g),
    stutter,
  }

  def carried(m: str): bool =
    creatorState.contains(m) or writerGraph.contains(m) or handedBack.contains(m)
      or inflight.contains((m, epoch))
  val stateWithinLimit = creatorState.size() <= LIMIT
  val toldOrCarried = accepted.forall(m => carried(m) or toldDeclined.contains(m))
  def quiet: bool = writerEpoch == epoch and handedBack == Set() and inflight.filter(p => p._2 == epoch) == Set()
    and writerGraph.intersect(WMOVES).subseteq(creatorGraph) and creatorGraph == Set()
  val convergedAccounted = if (not(quiet)) true else accepted.exclude(toldDeclined).subseteq(closedAt.get(epoch))
  val safety = stateWithinLimit and toldOrCarried and convergedAccounted
  val noDecline = declined == Set()

  // The hot-writer run (policy1.log), step by step: W admitted in epoch 0, its row late; the creator's C
  // takes the last byte in epoch 1; the Writer's replay is admitted locally and refused at the creator's
  // ingress; the creator closes epoch 1 with C; the replay is refused at the Writer's install of epoch 2 and
  // handed back; the policy declines it.
  run hotWriterRaceTest = init
    .then(creatorIssue("c0"))                   // fill: the state is 1 of 2
    .then(seal).then(install)                   // both at epoch 1
    .then(writerIssue("w0"))                    // W: the Writer admits it (its view: 1 + 1 <= 2)
    .then(seal)                                 // W's row arrives too late: the cut excludes it
    .then(creatorIssue("c1"))                   // C takes the last byte in epoch 2
    .then(all { assert(accepted == Set("c0", "w0", "c1") and creatorState.size() == 2), install })
    .then(all { assert(writerGraph == Set("w0")), deliverWriterRow("w0", 2) })   // replay admitted locally
    .then(all { assert(not(creatorState.contains("w0"))), seal })               // refused at the creator
    .then(install)
    .then(all { assert(handedBack == Set("w0") and safety), answerGivenBack("w0") })
    .then(all { assert(declined == Set("w0") and toldDeclined == Set("w0") and safety and not(noDecline)), stutter })
  // The same run with the pre-fix books: the decline never reaches them.
  run hotWriterRacePreFixTest = initPreFix
    .then(creatorIssue("c0")).then(seal).then(install).then(writerIssue("w0")).then(seal)
    .then(creatorIssue("c1")).then(install).then(deliverWriterRow("w0", 2)).then(seal).then(install)
    .then(answerGivenBack("w0"))
    .then(all { assert(not(toldOrCarried) and declined == Set("w0") and toldDeclined == Set()), stutter })
  // Row 97 without its records: the refused replay vanishes with nothing to tell.
  run dropRefusedTest = initDropRefused
    .then(creatorIssue("c0")).then(seal).then(install).then(writerIssue("w0")).then(seal)
    .then(creatorIssue("c1")).then(install).then(deliverWriterRow("w0", 2)).then(seal).then(install)
    .then(all { assert(handedBack == Set() and not(toldOrCarried)), stutter })
  // Without the creator's check of received rows, the Writer's advisory admission passes the limit.
  run writerTrustedTest = initWriterTrusted
    .then(creatorIssue("c0")).then(seal).then(install).then(writerIssue("w0")).then(creatorIssue("c1"))
    .then(deliverWriterRow("w0", 1))
    .then(all { assert(not(stateWithinLimit)), stutter })
}
