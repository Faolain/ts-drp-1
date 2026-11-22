module creatorPromotionRetainedSourceJournal {
  // Issuance / live-journal / signing-evidence ordering around a creator forward
  // promotion. Per epoch x the creator holds (all three exist once x is closed):
  //   issued(x)    native issued+outbox rows of x (author sequence ascending)
  //   journal(x)   the local journal prefix of scope x (accepted entries)
  //   evidence(x)  the seal's signing evidence/summary rows of epoch x
  // A journal prefix is classified collectible either by its own issued rows
  // (covered-historical) or by a closed-membership authority from a recovery-role
  // certificate. Every epoch except a promotion's classified retained source r is
  // some certificate's current/previous/operational role; r never is.
  // A prefix's signing evidence retires in the same pass as the prefix.
  // Issuance is pruned at adoption into n+1 (closed epoch n) for x <= n-2 as an
  // author-sequence PREFIX: the first row it may not prune stops it. Before the
  // closed-retirement coordinator has completed a decision the legacy pruner runs;
  // afterwards the coordinator's holes (rows with a physical journal consumer)
  // stop it. The seal signs epoch m with the trust window {0} U [m-5, m]; any
  // signing row outside it is UNCLASSIFIED_SIGNING_DEPENDENCY.
  //
  // Measured shape (explore/gate censuses): a promotion's close F and the promoted
  // close E complete no full classification; E+1 is incomplete (the operational
  // source is a protected role outside the replay cuts); the coordinator completes
  // its first decision at the first close n >= 3 that is not E.
  pure val WINDOW = 5
  pure val HORIZON = 7 // epochs played after the promoted epoch

  var floorF: int
  var source: int
  var epoch: int        // the live epoch
  var phase: str        // "close" | "adopt"
  var issued: Set[int]
  var journal: Set[int]
  var evidence: Set[int]
  var coordinated: bool
  var unclassifiedSigning: bool

  def promoted: int = floorF + 1
  def retainedSource: int = if (source == floorF - 1) floorF - 2 else floorF - 1
  def membership(x: int): bool = x != retainedSource
  def coordinatorCompletes(n: int): bool = n >= 3 and n != promoted
  def classificationComplete(n: int): bool = n != promoted and n != promoted + 1
  def inWindow(m: int, x: int): bool = x == 0 or (x >= m - WINDOW and x <= m)

  // ---- Properties ----
  val signingSafe = not(unclassifiedSigning)
  val evidenceBounded = evidence.forall(x => x == 0 or x >= epoch - WINDOW)
  // After the horizon every pre-promotion non-genesis journal prefix has left.
  val prePromotionJournalRetired = epoch >= promoted + HORIZON implies
    journal.filter(x => x >= 1 and x <= floorF) == Set()
  val inv = signingSafe and evidenceBounded and prePromotionJournalRetired

  // Each epoch issues (every gate epoch issues), so a closed x has all three rows.
  action initWith(f: int, s: int): bool = all {
    floorF' = f, source' = s, epoch' = 0, phase' = "close",
    issued' = Set(0), journal' = Set(0), evidence' = Set(0), coordinated' = false, unclassifiedSigning' = false,
  }
  action init = {
    nondet f = 2.to(4).oneOf()
    nondet s = Set(f - 1, f - 2).oneOf()
    initWith(f, s)
  }

  // The close of `epoch`: coordinator decision and, when complete, collection of
  // every unprotected (x <= n-3) prefix it can classify, with its evidence.
  action close: bool = all {
    phase == "close", epoch < promoted + HORIZON,
    val n = epoch
    val collect = if (coordinatorCompletes(n) and classificationComplete(n))
      journal.filter(x => x <= n - 3 and (issued.contains(x) or membership(x))) else Set()
    all {
      journal' = journal.exclude(collect), evidence' = evidence.exclude(collect),
      coordinated' = (coordinated or coordinatorCompletes(n)),
    },
    phase' = "adopt",
    floorF' = floorF, source' = source, epoch' = epoch, issued' = issued, unclassifiedSigning' = unclassifiedSigning,
  }

  // Adoption into n+1: issuance prefix pruning, then the new epoch signs/issues.
  // A promotion adopts F+1 directly from the close of F (same pruning).
  action adoptWith(guarded: bool): bool = all {
    phase == "adopt",
    val n = epoch
    val due = issued.filter(x => x <= n - 2)
    val blocked = due.filter(x => if (coordinated) journal.contains(x)
      else guarded and x > 0 and journal.contains(x))
    val stop = if (blocked == Set()) n else blocked.fold(n, (a, x) => if (x < a) x else a)
    val pruned = if (n >= 2) due.filter(x => x < stop) else Set()
    val m = n + 1
    all {
      issued' = issued.exclude(pruned).union(Set(m)),
      journal' = journal.union(Set(m)),
      evidence' = evidence.union(Set(m)),
      unclassifiedSigning' = (unclassifiedSigning or not(evidence.forall(x => inWindow(m, x)))),
      epoch' = m,
    },
    phase' = "close",
    floorF' = floorF, source' = source, coordinated' = coordinated,
  }
  action adopt = adoptWith(true)
  action done = all {
    epoch >= promoted + HORIZON, phase == "close",
    floorF' = floorF, source' = source, epoch' = epoch, phase' = phase, issued' = issued, journal' = journal,
    evidence' = evidence, coordinated' = coordinated, unclassifiedSigning' = unclassifiedSigning,
  }
  action step = any { close, adopt, done }
  // Broken control: the legacy pruner ignores the journal consumer (the shipped
  // pre-coordinator rule).
  action brokenUnguardedPrune = any { close, adoptWith(false), done }

  // ---- Deterministic scenarios ----
  run testFloor2Slot0GuardedSafe =
    initWith(2, 0).then(16.reps(_ => any { close, adopt })).expect(inv and epoch == 8 and journal.filter(x => x >= 1 and x <= 2) == Set())
  run testFloor2Slot0UnguardedStrands =
    initWith(2, 0).then(14.reps(_ => any { close, adoptWith(false) }))
      .expect(unclassifiedSigning and journal.contains(1) and evidence.contains(1) and not(issued.contains(1)))
  run testFloor3Slot1UnguardedAlreadyCoordinated =
    initWith(3, 1).then(18.reps(_ => any { close, adoptWith(false) })).expect(inv)
  run testFloor2Slot1GenesisResidueTrusted =
    initWith(2, 1).then(16.reps(_ => any { close, adopt })).expect(inv)
}
