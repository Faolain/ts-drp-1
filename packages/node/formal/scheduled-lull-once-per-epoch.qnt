module scheduledLullOncePerEpoch {
  // The once-per-epoch rule of the scheduled recovery-pool lull (Track Z, decision rows 54 and 70):
  // internal/recovery-pool-scheduled.ts `run`, called by v3-room.ts maintainRecoveryPool().
  //
  // A creator's `run` executes inside one lifecycle-FIFO transition, so two calls never overlap.
  // Since lull "A" (2ca8eccc, perf/b1-c-idle-a) a recipient's lull runs as bounded steps, each its
  // own admission, and `run` is called AFTER the routing transition, outside the FIFO. So the
  // application's explicit call can enter `run` while the scheduled run of the same epoch is still
  // running. The pre-fix `run` only checked "is this epoch settled?" before starting a lull, so
  // both calls started and both were observed (tests/track-z-room-database-default.test.ts,
  // recipient epoch 5: ["scheduled:maintained", "explicit:maintained"]).
  //
  // The fix: `run` keeps the running lull and its epoch; a call in that epoch joins it (its result,
  // no second lull, no second observation). A call in a later epoch (after an install) runs its own,
  // and the settle is monotone: an earlier epoch's lull that resolves after a later epoch settled
  // does not take that settle back (the join alone fails oneSettling: run A at epoch 1, install,
  // B runs and settles epoch 2, A resolves and settles 1, C at epoch 2 runs a second lull).
  //
  // Each call: enter (reads the epoch; settled -> answered at once; fix: running same epoch ->
  // joined; otherwise its own lull starts), then finish (observed; settles the epoch unless the
  // result is deferred:busy; every call joined to it is answered with its result).
  //
  // Properties:
  //   oneRunning   - no two lulls of the same epoch run at the same time.
  //   oneSettling  - at most one observed lull settles each epoch.
  //   joinSame     - a joined call is answered only by a lull of its own epoch.
  //
  // Configurations (one init each):
  //   init              - recipient (calls overlap) with the fix: all properties hold.
  //   initPreFix        - recipient, pre-fix `run`: violates oneRunning and oneSettling.
  //   initPreFixFifo    - creator (calls serialized by the FIFO), pre-fix `run`: holds, which is
  //                       why the rule held before lull "A" moved the recipient's run out of it.
  //   initJoinOnly      - the join without the monotone settle: violates oneSettling.
  //
  // Checking (2026-11-21, quint 0.32.0, Apalache 0.56.1 on openjdk@17):
  //   quint run    --init <cfg> --step step --invariant safety --max-steps 14 --max-samples 30000 --seed 7
  //   quint verify --init <cfg> --step step --invariant safety --max-steps 8 --backend apalache
  //   init: no violation (both). initPreFixFifo: no violation (both).
  //   initPreFix: counterexample in 2 steps: call 1 enters at epoch 1 and starts its lull; call 2
  //     enters at epoch 1 before it settles and starts a second lull (oneRunning).
  //   initJoinOnly: counterexample in 7 steps: call 1 runs at epoch 1; install; call 0 runs at
  //     epoch 2 and settles it; call 1 resolves and settles epoch 1; call 2 at epoch 2 finds it
  //     unsettled and runs a second settling lull (oneSettling: settles(2) = 2).
  pure val CALLS = Set(0, 1, 2)   // the scheduled request, an explicit call, a deferred-lull retry
  pure val MAX_EPOCH = 3

  var epoch: int
  var phase: int -> str          // "idle" | "running" | "joined" | "answered"
  var callEpoch: int -> int      // the epoch `run` read at entry (0: not entered)
  var joinedTo: int -> int       // the call whose lull a joined call waits on (-1: none)
  var running: int               // the bookkeeping's running lull: its call (-1: none)
  var settled: int               // the settled epoch (0: none)
  var settles: int -> int        // observed lulls that settled each epoch
  var join: bool                 // fix part 1: a call joins its epoch's running lull
  var monotone: bool             // fix part 2: a settle never moves back to an earlier epoch
  var serialized: bool

  action initWith(j: bool, mono: bool, fifo: bool): bool = all {
    epoch' = 1,
    phase' = CALLS.mapBy(_ => "idle"),
    callEpoch' = CALLS.mapBy(_ => 0),
    joinedTo' = CALLS.mapBy(_ => -1),
    running' = -1,
    settled' = 0,
    settles' = 1.to(MAX_EPOCH).mapBy(_ => 0),
    join' = j,
    monotone' = mono,
    serialized' = fifo,
  }
  action init = initWith(true, true, false)
  action initPreFix = initWith(false, false, false)
  action initPreFixFifo = initWith(false, false, true)
  action initJoinOnly = initWith(true, false, false)

  // Some call's own lull is running now.
  def anyRunning: bool = CALLS.exists(c => phase.get(c) == "running")

  // maintainRecoveryPool() reaches `run(scheduled, lull)`.
  action enter(c: int): bool = all {
    phase.get(c) == "idle",
    // The creator's run is inside one FIFO transition: it waits for the one ahead.
    not(serialized and anyRunning),
    callEpoch' = callEpoch.set(c, epoch),
    if (settled == epoch)
      all { phase' = phase.set(c, "answered"), joinedTo' = joinedTo, running' = running }
    else if (join and running >= 0 and callEpoch.get(running) == epoch)
      all { phase' = phase.set(c, "joined"), joinedTo' = joinedTo.set(c, running), running' = running }
    else
      all { phase' = phase.set(c, "running"), joinedTo' = joinedTo, running' = c },
    epoch' = epoch, settled' = settled, settles' = settles, join' = join, monotone' = monotone, serialized' = serialized,
  }

  // The call's lull resolves: observed; it settles its epoch unless busy; joined calls answered.
  action finish(c: int, busy: bool): bool = all {
    phase.get(c) == "running",
    val e = callEpoch.get(c)
    all {
      settles' = if (busy) settles else settles.set(e, settles.get(e) + 1),
      // Fix: an earlier epoch's lull that resolves after a later epoch settled leaves that settle.
      settled' = if (busy) settled else if (monotone and settled > e) settled else e,
    },
    phase' = CALLS.mapBy(d => if (d == c or (phase.get(d) == "joined" and joinedTo.get(d) == c)) "answered" else phase.get(d)),
    running' = if (running == c) -1 else running,
    epoch' = epoch, callEpoch' = callEpoch, joinedTo' = joinedTo, join' = join, monotone' = monotone, serialized' = serialized,
  }

  // An install moves the recipient to the next epoch (a running lull keeps the epoch it read).
  action install: bool = all {
    epoch < MAX_EPOCH,
    epoch' = epoch + 1,
    phase' = phase, callEpoch' = callEpoch, joinedTo' = joinedTo, running' = running, settled' = settled,
    settles' = settles, join' = join, monotone' = monotone, serialized' = serialized,
  }

  action stutter: bool = all {
    epoch' = epoch, phase' = phase, callEpoch' = callEpoch, joinedTo' = joinedTo, running' = running,
    settled' = settled, settles' = settles, join' = join, monotone' = monotone, serialized' = serialized,
  }

  action step = any {
    nondet c = oneOf(CALLS)
    any { enter(c), nondet busy = oneOf(Set(true, false)) finish(c, busy) },
    install,
    stutter,
  }

  val oneRunning = CALLS.forall(a => CALLS.forall(b =>
    (a != b and phase.get(a) == "running" and phase.get(b) == "running") implies callEpoch.get(a) != callEpoch.get(b)))
  val oneSettling = 1.to(MAX_EPOCH).forall(e => settles.get(e) <= 1)
  val joinSame = CALLS.forall(c => phase.get(c) == "joined" implies callEpoch.get(joinedTo.get(c)) == callEpoch.get(c))
  val safety = oneRunning and oneSettling and joinSame
}
