module hostForegroundPriority {
  // The host-level foreground priority of cooperative-work.ts, over one event
  // loop shared by several rooms. Every action is one host task: one span of a
  // job between two host turns, one idle poll of a deferred turn, a foreground
  // registration, or a stop request. Any enabled task may run next, so every
  // ordering of the host's timer queue is covered.
  //
  // Foreground jobs (an admitted issuance job, readiness, a room's issue drain)
  // register when they start and release when they end. The background walk
  // (pool maintenance) takes a host turn after every span. A background turn
  // that resumes while any foreground is registered defers: it waits for the
  // cohort registered at that moment to release, for IDLE consecutive polls
  // without foreground progress, or for BOUND polls in all. A woken turn runs
  // its span without deferring again. Every span first rechecks stopping.
  //
  // The lane is ambient in the implementation, so a foreground turn may be
  // misclassified as background (a mutant-free nondeterministic choice here,
  // gated by `misclassify`): it then defers like one, behind a cohort that
  // includes itself. Foreground job 2 may also need a resource the background
  // walk holds between its first and last span (a foreground waiting for a
  // background result, which the registration sites avoid but which must not
  // deadlock). Each mutant removes one rule.
  pure val FG = Set(1, 2)
  pure val FG_SPANS = 2
  pure val BG_SPANS = 3
  pure val IDLE = 2
  pure val BOUND = 4
  // Each remaining span outweighs any wait, so every task lowers `rank`.
  pure val W = 2 * (BOUND + 3)

  type Mutants = {
    noDeferral: bool,    // background turns never defer
    unbounded: bool,     // a deferral waits only for its cohort (no idle window, no bound)
    noRecheck: bool,     // a woken background span skips the stopping recheck
    misclassify: bool,   // allow foreground turns to be classified background
  }
  pure val SOUND: Mutants = { noDeferral: false, unbounded: false, noRecheck: false, misclassify: false }

  // idle | ready | deferred | woken | done | aborted (aborted: stopped at a recheck)
  var fgState: int -> str
  var fgLeft: int -> int
  var fgWait: int -> int
  var fgIdle: int -> int
  var fgSeen: int -> int
  var fgCohort: int -> Set[int]
  // queued | deferred | woken | done | aborted
  var bgState: str
  var bgLeft: int
  var bgWait: int
  var bgIdle: int
  var bgSeen: int
  var bgCohort: Set[int]
  var f2NeedsBg: bool
  var progress: int        // foreground spans run (the scheduler counts non-background turns)
  var stopping: bool
  var bgSpansDuringFg: int // background spans run while some foreground was registered
  var bgWakes: int
  var spansAfterStop: int
  var prevRank: int

  def live(s: str): bool = s == "ready" or s == "deferred" or s == "woken"
  def registered: Set[int] = FG.filter(j => live(fgState.get(j)))
  def holdsR: bool = bgLeft < BG_SPANS and bgLeft > 0 and bgState != "aborted"
  def blocked(j: int): bool = j == 2 and f2NeedsBg and holdsR
  def waitPart(s: str, wait: int): int =
    if (s == "idle") BOUND + 3 else if (s == "ready" or s == "queued") BOUND + 2
    else if (s == "deferred") BOUND - wait + 1 else 0
  def fgRank(j: int): int =
    if (fgState.get(j) == "done" or fgState.get(j) == "aborted") 0
    else fgLeft.get(j) * W + waitPart(fgState.get(j), fgWait.get(j))
  def rank: int =
    FG.fold(0, (acc, j) => acc + fgRank(j)) +
    (if (bgState == "done" or bgState == "aborted") 0 else bgLeft * W + waitPart(bgState, bgWait)) +
    (if (stopping) 0 else 1)

  // ---- Properties ----
  // Every deferral is bounded, for the background walk and for a misclassified foreground.
  val boundedDeferral = bgWait <= BOUND and FG.forall(j => fgWait.get(j) <= BOUND)
  // Background never runs a span during foreground unless a wake released it.
  val foregroundPriority = bgSpansDuringFg <= bgWakes
  // No span runs after a recheck could have observed the stop.
  val stopRechecked = spansAfterStop == 0
  // Every task strictly lowers a non-negative rank: every run is finite, so the
  // background and every foreground job end (done or stopped) — no starvation.
  val progressRank = rank >= 0 and prevRank > rank
  // Some job task is enabled until every job has ended: no deadlock.
  val noDeadlock = (FG.forall(j => fgState.get(j) == "done" or fgState.get(j) == "aborted") and
      (bgState == "done" or bgState == "aborted")) or
    FG.exists(j => fgState.get(j) == "idle" or
      ((fgState.get(j) == "ready" or fgState.get(j) == "woken") and not(blocked(j))) or fgState.get(j) == "deferred") or
    bgState == "queued" or bgState == "woken" or bgState == "deferred"
  val safety = boundedDeferral and foregroundPriority and stopRechecked and progressRank and noDeadlock

  // Witnesses.
  val reachedCohortWake = bgWakes > 0 and bgState == "done" and registered != Set()
  val reachedBlockedForeground = f2NeedsBg and fgState.get(2) == "ready" and holdsR and bgState == "deferred"
  val reachedAllDone = FG.forall(j => fgState.get(j) == "done") and bgState == "done"
  val reachedMisclassifiedWake = FG.exists(j => fgState.get(j) == "woken")

  action initWith(needs: bool): bool = all {
    fgState' = FG.mapBy(_ => "idle"), fgLeft' = FG.mapBy(_ => FG_SPANS), fgWait' = FG.mapBy(_ => 0),
    fgIdle' = FG.mapBy(_ => 0), fgSeen' = FG.mapBy(_ => 0), fgCohort' = FG.mapBy(_ => Set()),
    bgState' = "queued", bgLeft' = BG_SPANS, bgWait' = 0, bgIdle' = 0, bgSeen' = 0, bgCohort' = Set(),
    f2NeedsBg' = needs,
    progress' = 0, stopping' = false, bgSpansDuringFg' = 0, bgWakes' = 0, spansAfterStop' = 0,
    prevRank' = 2 * W * (BG_SPANS + 2 * FG_SPANS) + 100,
  }
  action init = {
    nondet needs = Set(true, false).oneOf()
    initWith(needs)
  }

  // Releasing foreground j wakes every deferred turn whose cohort it empties.
  def released(j: int, wakes: int): (str, Set[int], int) =
    if (bgState == "deferred" and bgCohort.exclude(Set(j)) == Set()) ("woken", Set(), wakes + 1)
    else (bgState, bgCohort.exclude(Set(j)), wakes)
  def fgCohortsAfter(j: int): int -> Set[int] = FG.mapBy(k => fgCohort.get(k).exclude(Set(j)))
  def fgStatesAfter(j: int, own: str): int -> str = FG.mapBy(k =>
    if (k == j) own
    else if (fgState.get(k) == "deferred" and fgCohort.get(k).exclude(Set(j)) == Set()) "woken"
    else fgState.get(k))

  action keepBg = all {
    bgState' = bgState, bgLeft' = bgLeft, bgWait' = bgWait, bgIdle' = bgIdle, bgSeen' = bgSeen,
    bgCohort' = bgCohort, bgWakes' = bgWakes,
  }
  action keepFgWaits = all { fgWait' = fgWait, fgIdle' = fgIdle, fgSeen' = fgSeen }

  action startFg(j: int): bool = all {
    fgState.get(j) == "idle",
    fgState' = fgState.set(j, "ready"),
    fgLeft' = fgLeft, fgCohort' = fgCohort, keepFgWaits, keepBg,
    f2NeedsBg' = f2NeedsBg, progress' = progress, stopping' = stopping,
    bgSpansDuringFg' = bgSpansDuringFg, spansAfterStop' = spansAfterStop, prevRank' = rank,
  }

  // One foreground span after its host turn (or the misclassified deferral of that turn).
  action runFg(m: Mutants, j: int, misclassified: bool): bool = all {
    fgState.get(j) == "ready" or fgState.get(j) == "woken", not(blocked(j)),
    f2NeedsBg' = f2NeedsBg, stopping' = stopping, bgSpansDuringFg' = bgSpansDuringFg,
    spansAfterStop' = spansAfterStop, prevRank' = rank,
    if (stopping) {
      val r = released(j, bgWakes)
      all {
        fgState' = fgStatesAfter(j, "aborted"), fgCohort' = fgCohortsAfter(j), fgLeft' = fgLeft,
        keepFgWaits, progress' = progress,
        bgState' = r._1, bgCohort' = r._2, bgWakes' = r._3,
        bgLeft' = bgLeft, bgWait' = bgWait, bgIdle' = bgIdle, bgSeen' = bgSeen,
      }
    } else if (m.misclassify and misclassified and fgState.get(j) == "ready") all {
      fgState' = fgState.set(j, "deferred"), fgCohort' = fgCohort.set(j, registered),
      fgWait' = fgWait.set(j, 0), fgIdle' = fgIdle.set(j, 0), fgSeen' = fgSeen.set(j, progress),
      fgLeft' = fgLeft, progress' = progress, keepBg,
    } else if (fgLeft.get(j) == 1) {
      val r = released(j, bgWakes)
      all {
        fgState' = fgStatesAfter(j, "done"), fgCohort' = fgCohortsAfter(j), fgLeft' = fgLeft.set(j, 0),
        keepFgWaits, progress' = progress + 1,
        bgState' = r._1, bgCohort' = r._2, bgWakes' = r._3,
        bgLeft' = bgLeft, bgWait' = bgWait, bgIdle' = bgIdle, bgSeen' = bgSeen,
      }
    } else all {
      fgState' = fgState.set(j, "ready"), fgLeft' = fgLeft.set(j, fgLeft.get(j) - 1),
      fgCohort' = fgCohort, keepFgWaits, progress' = progress + 1, keepBg,
    },
  }

  // The background turn resumes: defer behind registered foreground, or run one span.
  action runBg(m: Mutants): bool = all {
    bgState == "queued" or bgState == "woken",
    fgState' = fgState, fgLeft' = fgLeft, fgCohort' = fgCohort, keepFgWaits,
    f2NeedsBg' = f2NeedsBg, progress' = progress, stopping' = stopping, prevRank' = rank,
    bgWakes' = bgWakes,
    if (bgState == "queued" and not(m.noDeferral) and registered != Set()) all {
      bgState' = "deferred", bgCohort' = registered, bgWait' = 0, bgIdle' = 0, bgSeen' = progress,
      bgLeft' = bgLeft, bgSpansDuringFg' = bgSpansDuringFg, spansAfterStop' = spansAfterStop,
    } else if (stopping and not(m.noRecheck and bgState == "woken")) all {
      bgState' = "aborted", bgLeft' = bgLeft, bgCohort' = Set(), bgWait' = 0, bgIdle' = 0, bgSeen' = bgSeen,
      bgSpansDuringFg' = bgSpansDuringFg, spansAfterStop' = spansAfterStop,
    } else all {
      bgState' = if (bgLeft == 1) "done" else "queued", bgLeft' = bgLeft - 1,
      bgCohort' = Set(), bgWait' = 0, bgIdle' = 0, bgSeen' = bgSeen,
      bgSpansDuringFg' = if (registered != Set()) bgSpansDuringFg + 1 else bgSpansDuringFg,
      spansAfterStop' = if (stopping) spansAfterStop + 1 else spansAfterStop,
    },
  }

  // One idle poll of the deferred background turn.
  action pollBg(m: Mutants): bool = all {
    bgState == "deferred", m.unbounded implies bgWait <= BOUND,
    val idle = if (progress == bgSeen) bgIdle + 1 else 0
    val wake = not(m.unbounded) and (idle >= IDLE or bgWait + 1 >= BOUND)
    all {
      bgState' = if (wake) "woken" else "deferred", bgWakes' = if (wake) bgWakes + 1 else bgWakes,
      bgWait' = bgWait + 1, bgIdle' = idle, bgSeen' = progress,
      bgLeft' = bgLeft, bgCohort' = bgCohort,
    },
    fgState' = fgState, fgLeft' = fgLeft, fgCohort' = fgCohort, keepFgWaits,
    f2NeedsBg' = f2NeedsBg, progress' = progress, stopping' = stopping,
    bgSpansDuringFg' = bgSpansDuringFg, spansAfterStop' = spansAfterStop, prevRank' = rank,
  }

  // One idle poll of a misclassified, deferred foreground turn.
  action pollFg(m: Mutants, j: int): bool = all {
    fgState.get(j) == "deferred", m.unbounded implies fgWait.get(j) <= BOUND,
    val idle = if (progress == fgSeen.get(j)) fgIdle.get(j) + 1 else 0
    val wake = not(m.unbounded) and (idle >= IDLE or fgWait.get(j) + 1 >= BOUND)
    all {
      fgState' = fgState.set(j, if (wake) "woken" else "deferred"),
      fgWait' = fgWait.set(j, fgWait.get(j) + 1), fgIdle' = fgIdle.set(j, idle),
      fgSeen' = fgSeen.set(j, progress),
    },
    fgLeft' = fgLeft, fgCohort' = fgCohort, keepBg,
    f2NeedsBg' = f2NeedsBg, progress' = progress, stopping' = stopping,
    bgSpansDuringFg' = bgSpansDuringFg, spansAfterStop' = spansAfterStop, prevRank' = rank,
  }

  action stop = all {
    not(stopping), stopping' = true,
    fgState' = fgState, fgLeft' = fgLeft, fgCohort' = fgCohort, keepFgWaits, keepBg,
    f2NeedsBg' = f2NeedsBg, progress' = progress,
    bgSpansDuringFg' = bgSpansDuringFg, spansAfterStop' = spansAfterStop, prevRank' = rank,
  }

  action stepWith(m: Mutants): bool = any {
    nondet j = FG.oneOf()
    nondet misclassified = Set(true, false).oneOf()
    any { startFg(j), runFg(m, j, misclassified), pollFg(m, j) },
    runBg(m),
    pollBg(m),
    stop,
  }

  // ---- Scenarios ----
  // A foreground job keeps progressing: the background walk defers at its
  // first turn and runs only after that job's cohort releases.
  run testDefersBehindCohort =
    initWith(false).then(startFg(1)).then(runBg(SOUND)).then(runFg(SOUND, 1, false))
      .then(pollBg(SOUND)).then(runFg(SOUND, 1, false))
      .expect(bgState == "woken" and bgSpansDuringFg == 0 and bgLeft == BG_SPANS and safety)
  // A foreground job waiting for the background's resource makes no progress;
  // the idle window releases the background walk, which then frees the job.
  run testBlockedForegroundReleasedByIdle =
    initWith(true).then(runBg(SOUND)).then(startFg(2)).then(runBg(SOUND))
      .then(pollBg(SOUND)).then(pollBg(SOUND)).then(runBg(SOUND))
      .then(runBg(SOUND)).then(pollBg(SOUND)).then(pollBg(SOUND)).then(runBg(SOUND))
      .then(runFg(SOUND, 2, false)).then(runFg(SOUND, 2, false))
      .expect(bgState == "done" and fgState.get(2) == "done" and bgSpansDuringFg == 2 and safety)
  // Waiting only for the cohort, the same schedule cannot release the walk.
  run testUnboundedDeadlocks =
    initWith(true).then(runBg(SOUND)).then(startFg(2)).then(runBg(SOUND))
      .then(pollBg(SOUND.with("unbounded", true))).then(pollBg(SOUND.with("unbounded", true)))
      .expect(bgState == "deferred" and blocked(2))
  // A misclassified foreground waits behind a cohort holding itself; the idle
  // window releases it while nothing else progresses.
  run testMisclassifiedForegroundEnds =
    initWith(false).then(startFg(1)).then(runFg(SOUND.with("misclassify", true), 1, true))
      .then(pollFg(SOUND, 1)).then(pollFg(SOUND, 1)).then(runFg(SOUND, 1, false)).then(runFg(SOUND, 1, false))
      .expect(fgState.get(1) == "done" and safety)

  action step = stepWith(SOUND)
  // The ambient lane may misclassify a foreground turn: it still ends.
  action stepMisclassify = stepWith(SOUND.with("misclassify", true))
  action brokenNoDeferral = stepWith(SOUND.with("noDeferral", true))
  // Waiting only for the cohort deadlocks a foreground that waits on the background.
  action brokenUnbounded = stepWith(SOUND.with("unbounded", true))
  action brokenUnboundedMisclassify = stepWith(SOUND.with("unbounded", true).with("misclassify", true))
  action brokenNoRecheck = stepWith(SOUND.with("noRecheck", true))
}
