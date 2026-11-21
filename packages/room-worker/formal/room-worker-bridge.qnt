// The room worker bridge (@ts-drp/room-worker), the runtime Grid, Canvas and Chat use by default:
// the page posts commands to the worker that hosts the room and renders the room's projection from
// the worker's `latest` stream. src/client.ts is the page side, src/server.ts the worker side.
//
// Modelled:
// - Two FIFO channels (postMessage between a page and its dedicated worker is ordered).
// - The page posts `call`s; the worker runs each as it arrives (commands reach the room in the
//   page's order). The room admits the call's move (durably) or refuses it; an admission emits the
//   projection. The call then completes: the worker flushes every pending stream value, then posts
//   the result (server.ts command(): `flush(); reply(...)`).
// - The projection stream is `latest`: one value in flight under the page's credit; an emit without
//   credit is held (only the newest), sent when the credit returns or by the flush before a result.
// - The page renders each stream value it handles and returns the credit at its next frame.
// - Reopen: the page terminates the worker, drops what it rendered from it, and opens a new one with
//   a new session. Calls in flight reject (crashed, outcome unknown: the README's crash rule resolves
//   them from durable state).
//   Messages the dead worker had already posted may still be queued for the page; the page drops
//   every message of another session (parseWorkerMessage(value, session)).
// - Close: the page posts `close`; the worker closes the room (which may still emit, joining admitted
//   work), then posts `closed`, after which it emits nothing (server.ts emit(): `if (closed) return`).
//
// Properties:
//   noUnadmittedDisplay - the page never renders a move the room has not admitted.
//   readYourWrites      - once a call resolves on the page, the page has rendered its move.
//   displayCurrency     - what the page renders came from its current worker (never a dead one).
//   lifecycleFifo       - the page handles no stream value of a session after that session's `closed`.
//   pageOrder           - the room admits moves in the order the page posted them.
//
// Mutants (broken controls), each violating the property in brackets:
//   replyBeforeFlush  - the result is posted before the pending stream value [readYourWrites].
//   noSessionCheck    - the page handles messages of a dead worker [displayCurrency].
//   optimisticDisplay - the page renders a move when it posts it [noUnadmittedDisplay].
//   emitAfterClosed   - the worker's emit is not gated on `closed` [lifecycleFifo].
//   reorderCommands   - the worker runs any queued command, not the oldest [pageOrder].
//
// Checking (packages/room-worker/formal/README.md has the commands and results).
module roomWorkerBridge {
  pure val CALLS = 3      // call ids 1..CALLS (each carries one move, identified by its call id)
  pure val SESSIONS = 2   // the page reopens at most SESSIONS - 1 times

  type Msg = { k: str, s: int, id: int, v: Set[int] }
  type Mutants = {
    replyBeforeFlush: bool,
    noSessionCheck: bool,
    optimisticDisplay: bool,
    emitAfterClosed: bool,
    reorderCommands: bool,
  }
  pure val SOUND: Mutants = {
    replyBeforeFlush: false,
    noSessionCheck: false,
    optimisticDisplay: false,
    emitAfterClosed: false,
    reorderCommands: false,
  }
  pure def msg(k: str, s: int, id: int, v: Set[int]): Msg = { k: k, s: s, id: id, v: v }

  // Channels.
  var toWorker: List[Msg]   // page -> current worker ("call", "credit", "close")
  var toPage: List[Msg]     // workers -> page ("stream", "result", "closed"); a dead worker's may remain
  // Worker (the current one) and the room's durable state.
  var wSession: int
  var wState: str           // "open" | "closing" | "closed"
  var admitted: Set[int]    // moves the room admitted (durable: they survive a reopen)
  var admitOrder: List[int] // the order the room admitted them in
  var wCredit: bool
  var wPending: bool
  var wValue: Set[int]
  var completing: Set[int]  // calls run by the worker, their results not yet posted
  var okCalls: Set[int]     // of those, the admitted ones
  var emitted: Set[Set[int]] // stream values the current worker emitted
  // Page.
  var pSession: int
  var nextCall: int
  var posted: List[int]     // call ids in the order the page posted them (all sessions)
  var inflight: Set[int]
  var resolved: Set[int]    // calls resolved ok in the current session
  var displayed: Set[int]
  var displayedFrom: int    // the session whose worker sent what is displayed (0: nothing yet)
  var owedCredit: bool
  var closedSeen: Set[int]  // sessions whose `closed` the page handled
  var streamAfterClosed: bool
  var m: Mutants

  action initWith(mu: Mutants): bool = all {
    toWorker' = List(),
    toPage' = List(),
    wSession' = 1,
    wState' = "open",
    admitted' = Set(),
    admitOrder' = List(),
    wCredit' = true,
    wPending' = false,
    wValue' = Set(),
    completing' = Set(),
    okCalls' = Set(),
    emitted' = Set(),
    pSession' = 1,
    nextCall' = 1,
    posted' = List(),
    inflight' = Set(),
    resolved' = Set(),
    displayed' = Set(),
    displayedFrom' = 0,
    owedCredit' = false,
    closedSeen' = Set(),
    streamAfterClosed' = false,
    m' = mu,
  }
  action init = initWith(SOUND)
  action initReplyBeforeFlush = initWith({ ...SOUND, replyBeforeFlush: true })
  action initNoSessionCheck = initWith({ ...SOUND, noSessionCheck: true })
  action initOptimisticDisplay = initWith({ ...SOUND, optimisticDisplay: true })
  action initEmitAfterClosed = initWith({ ...SOUND, emitAfterClosed: true })
  action initReorderCommands = initWith({ ...SOUND, reorderCommands: true })

  action pageUnchanged = all {
    pSession' = pSession, nextCall' = nextCall, posted' = posted, inflight' = inflight,
    resolved' = resolved, displayed' = displayed, displayedFrom' = displayedFrom,
    owedCredit' = owedCredit, closedSeen' = closedSeen, streamAfterClosed' = streamAfterClosed,
  }
  action workerUnchanged = all {
    wSession' = wSession, wState' = wState, admitted' = admitted, admitOrder' = admitOrder,
    wCredit' = wCredit, wPending' = wPending, wValue' = wValue, completing' = completing,
    okCalls' = okCalls, emitted' = emitted,
  }

  // ---- page ------------------------------------------------------------------------------------

  // A call (placeBlock, paint, send): posted in order. optimisticDisplay renders it at once.
  action pageCall = all {
    nextCall <= CALLS,
    not(pSession.in(closedSeen)),
    toWorker' = toWorker.append(msg("call", pSession, nextCall, Set())),
    nextCall' = nextCall + 1,
    posted' = posted.append(nextCall),
    inflight' = inflight.union(Set(nextCall)),
    displayed' = if (m.optimisticDisplay) displayed.union(Set(nextCall)) else displayed,
    displayedFrom' = displayedFrom,
    pSession' = pSession, resolved' = resolved, owedCredit' = owedCredit,
    closedSeen' = closedSeen, streamAfterClosed' = streamAfterClosed,
    toPage' = toPage, workerUnchanged, m' = m,
  }

  // The page's next frame returns the stream's credit.
  action pageFrame = all {
    owedCredit,
    toWorker' = toWorker.append(msg("credit", pSession, 0, Set())),
    owedCredit' = false,
    pSession' = pSession, nextCall' = nextCall, posted' = posted, inflight' = inflight,
    resolved' = resolved, displayed' = displayed, displayedFrom' = displayedFrom,
    closedSeen' = closedSeen, streamAfterClosed' = streamAfterClosed,
    toPage' = toPage, workerUnchanged, m' = m,
  }

  // The page handles the oldest message from its workers.
  action pageReceive = all {
    toPage.length() > 0,
    val first = toPage.head()
    val handled = first.s == pSession or m.noSessionCheck
    val stream = handled and first.k == "stream"
    val result = handled and first.k == "result"
    val closed = handled and first.k == "closed"
    all {
      toPage' = toPage.tail(),
      displayed' = if (stream) first.v else displayed,
      displayedFrom' = if (stream) first.s else displayedFrom,
      owedCredit' = if (stream) first.s == pSession else owedCredit,
      streamAfterClosed' = (streamAfterClosed or (stream and first.s.in(closedSeen))),
      // An ok result carries v = {id}; a refusal v = {}.
      resolved' = if (result and first.s == pSession and first.v != Set()) resolved.union(Set(first.id)) else resolved,
      inflight' = if (result) inflight.exclude(Set(first.id)) else inflight,
      closedSeen' = if (closed) closedSeen.union(Set(first.s)) else closedSeen,
      pSession' = pSession, nextCall' = nextCall, posted' = posted,
      toWorker' = toWorker, workerUnchanged, m' = m,
    }
  }

  // The page closes the room (unload).
  action pageClose = all {
    wState == "open",
    not(pSession.in(closedSeen)),
    toWorker' = toWorker.append(msg("close", pSession, 0, Set())),
    toPage' = toPage, pageUnchanged, workerUnchanged, m' = m,
  }

  // Reopen: terminate the worker (in-flight calls reject, its queued input is lost with its port),
  // open a new one. The room's durable state stays; the new worker's room shows it from its first emit.
  action pageReopen = all {
    pSession < SESSIONS,
    toWorker' = List(),
    toPage' = toPage,
    pSession' = pSession + 1,
    wSession' = pSession + 1,
    wState' = "open",
    wCredit' = true,
    wPending' = false,
    wValue' = Set(),
    completing' = Set(),
    okCalls' = Set(),
    emitted' = Set(),
    admitted' = admitted, admitOrder' = admitOrder,
    inflight' = Set(),
    resolved' = Set(),
    nextCall' = nextCall, posted' = posted,
    // The page drops the dead worker's projection (snapshot = undefined) until the new one emits.
    displayed' = Set(), displayedFrom' = 0,
    owedCredit' = false,
    closedSeen' = closedSeen, streamAfterClosed' = streamAfterClosed,
    m' = m,
  }

  // ---- worker ----------------------------------------------------------------------------------

  // The latest-value stream's emit (server.ts emit()).
  pure def emitTo(q: List[Msg], s: int, credit: bool, v: Set[int])
      : { q: List[Msg], credit: bool, pending: bool } =
    if (credit) { q: q.append(msg("stream", s, 0, v)), credit: false, pending: false }
    else { q: q, credit: false, pending: true }

  // A closed worker drops every page message (server.ts onMessage: `closed && k !== "host-result"`).
  action workerDrop = all {
    toWorker.length() > 0,
    wState == "closed",
    toWorker' = toWorker.tail(),
    toPage' = toPage, pageUnchanged, workerUnchanged, m' = m,
  }

  // The worker handles one queued page message: the oldest (reorderCommands: any).
  action workerHandle = all {
    toWorker.length() > 0,
    wState != "closed",
    nondet index = 0.to(if (m.reorderCommands) toWorker.length() - 1 else 0).oneOf()
    val first = toWorker[index]
    val rest = toWorker.slice(0, index).concat(toWorker.slice(index + 1, toWorker.length()))
    nondet admit = Set(true, false).oneOf()
    all {
      toWorker' = rest,
      if (first.k == "call" and wState == "open" and admit) {
        // The room admits the move and emits the projection.
        val grown = admitted.union(Set(first.id))
        val e = emitTo(toPage, wSession, wCredit, grown)
        all {
          admitted' = grown,
          admitOrder' = admitOrder.append(first.id),
          toPage' = e.q, wCredit' = e.credit, wPending' = e.pending, wValue' = grown,
          emitted' = emitted.union(Set(grown)),
          completing' = completing.union(Set(first.id)),
          okCalls' = okCalls.union(Set(first.id)),
          wSession' = wSession, wState' = wState,
        }
      } else if (first.k == "call") all {
        // Refused (by the room, or RoomWorkerClosed while closing): no emit.
        completing' = completing.union(Set(first.id)),
        toPage' = toPage, wSession' = wSession, wState' = wState, admitted' = admitted,
        admitOrder' = admitOrder, wCredit' = wCredit, wPending' = wPending, wValue' = wValue,
        okCalls' = okCalls, emitted' = emitted,
      } else if (first.k == "credit") all {
        toPage' = if (wPending) toPage.append(msg("stream", wSession, 0, wValue)) else toPage,
        wCredit' = not(wPending),
        wPending' = false,
        wSession' = wSession, wState' = wState, admitted' = admitted, admitOrder' = admitOrder,
        wValue' = wValue, completing' = completing, okCalls' = okCalls, emitted' = emitted,
      } else all {
        // "close": the room closes (it may still emit, below), then `closed` is posted.
        wState' = if (wState == "open") "closing" else wState,
        toPage' = toPage, wSession' = wSession, admitted' = admitted, admitOrder' = admitOrder,
        wCredit' = wCredit, wPending' = wPending, wValue' = wValue, completing' = completing,
        okCalls' = okCalls, emitted' = emitted,
      },
      pageUnchanged, m' = m,
    }
  }

  // A run call's promise settles: flush, then the result (replyBeforeFlush: the reverse).
  action workerComplete = all {
    completing != Set(),
    nondet id = completing.oneOf()
    val result = msg("result", wSession, id, if (id.in(okCalls)) Set(id) else Set())
    val flushed = if (wPending) toPage.append(msg("stream", wSession, 0, wValue)) else toPage
    val replied = if (m.replyBeforeFlush) {
        val resultFirst = toPage.append(result)
        if (wPending) resultFirst.append(msg("stream", wSession, 0, wValue)) else resultFirst
      } else flushed.append(result)
    all {
      toPage' = replied,
      wPending' = false,
      completing' = completing.exclude(Set(id)),
      wSession' = wSession, wState' = wState, admitted' = admitted, admitOrder' = admitOrder,
      wCredit' = wCredit, wValue' = wValue, okCalls' = okCalls, emitted' = emitted,
      toWorker' = toWorker, pageUnchanged, m' = m,
    }
  }

  // The room emits again while closing (its close joins admitted work), or, emitAfterClosed, after.
  action workerEmit = all {
    wState == "closing" or (wState == "closed" and m.emitAfterClosed),
    val e = emitTo(toPage, wSession, wCredit, admitted)
    all {
      toPage' = e.q, wCredit' = e.credit, wPending' = e.pending, wValue' = admitted,
      emitted' = emitted.union(Set(admitted)),
      wSession' = wSession, wState' = wState, admitted' = admitted, admitOrder' = admitOrder,
      completing' = completing, okCalls' = okCalls,
      toWorker' = toWorker, pageUnchanged, m' = m,
    }
  }

  // The room closed: `closed` is posted. Calls still completing settle first (their results were
  // posted, or they reject with RoomWorkerClosed: modelled as completing before close).
  action workerClosed = all {
    wState == "closing",
    completing == Set(),
    wState' = "closed",
    toPage' = toPage.append(msg("closed", wSession, 0, Set())),
    wSession' = wSession, admitted' = admitted, admitOrder' = admitOrder, wCredit' = wCredit,
    wPending' = wPending, wValue' = wValue, completing' = completing, okCalls' = okCalls,
    emitted' = emitted, toWorker' = toWorker, pageUnchanged, m' = m,
  }

  action step = any {
    pageCall, pageFrame, pageReceive, pageClose, pageReopen,
    workerDrop, workerHandle, workerComplete, workerEmit, workerClosed,
  }

  // ---- properties ------------------------------------------------------------------------------

  val noUnadmittedDisplay = displayed.subseteq(admitted)
  val readYourWrites = resolved.subseteq(displayed)
  val displayCurrency = displayedFrom == 0 or displayedFrom == pSession
  val lifecycleFifo = not(streamAfterClosed)
  // The page posts calls in id order (nextCall counts up), so the room admitting them in the page's
  // order is: admitted ids strictly increase.
  val pageOrder = admitOrder.indices().forall(i => i == 0 or admitOrder[i - 1] < admitOrder[i])
  val safety = noUnadmittedDisplay and readYourWrites and displayCurrency and lifecycleFifo and pageOrder
}
