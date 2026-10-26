// Releasing a removed author's retained FENCE row (design candidate A in
// .logs/realtime-resume-2026-10-23/abandonment-crash-edge/FENCE-DESIGN.md).
//
// One author's local issuance: a join (seq 0), a join-time `$drp.author-fence.v1`
// no-op at seq 1 whose plan entry is "expire" with NO resolution (retained fence),
// and application sources after it. Today the store never retires a fence row
// (retirementEntryIsRetained / settlementPlanPermitsAuthenticatedPruning and the
// census "author-fence" kinds): after an ACL removal the row is a permanent hole.
//
// Candidate rule `releaseFence(f)`: a fence row may be retired when
//   (R1) the author is no longer a Writer, or f is not its current fence;
//   (R2) every plan entry other than retained fences carries an authenticated
//        terminal resolution (nothing left to reissue, rebase or abandon);
//   (R3) the ordinary retirement guards hold (epoch <= epochHead - 2: no rollback or
//        replay scope can still need it);
// and it never moves the durable lineage (next sequence) - re-admission issues
// a fresh fence at lineage.next.
//
// Properties: no sequence is ever signed twice with different content; the
// current fence of a Writer is retained; every unresolved source keeps the fence
// that bounds it; a rollback inside the retained window finds every row it needs.
// Mutants are the broken controls, one per rule clause plus a lineage-from-rows
// implementation that infers the next sequence from surviving rows.
module removedAuthorFenceRelease {
  pure val MAX_SEQ = 6
  pure val MAX_EPOCH = 6
  type Mutants = { allowWriter: bool, allowUnresolved: bool, ignoreWindow: bool, lineageFromRows: bool }
  pure val SOUND: Mutants = { allowWriter: false, allowUnresolved: false, ignoreWindow: false, lineageFromRows: false }

  var writer: bool
  var currentFence: int           // the author's latest fence sequence
  var fences: Set[int]            // every sequence that is a fence no-op
  var lineageNext: int            // durable next author sequence
  var signed: Set[(int, int)]     // (sequence, content) ever signed
  var nextContent: int
  var rows: Set[int]              // retained local issuance rows
  var rowEpoch: int -> int        // epoch each signed sequence belongs to
  var unresolved: Set[int]        // plan entries without an authenticated terminal resolution
  var epochHead: int
  var lostRollback: bool
  var mutants: Mutants

  pure def maxOr(s: Set[int], d: int): int = s.fold(d, (a, b) => if (b > a) b else a)
  // The fence that bounds a source: the latest fence below it.
  pure def fenceOf(fs: Set[int], s: int): int = maxOr(fs.filter(f => f < s), -1)

  action initWith(m: Mutants): bool = all {
    writer' = true,
    currentFence' = 1,
    fences' = Set(1),
    lineageNext' = 3,
    signed' = Set((0, 0), (1, 1), (2, 2)),
    nextContent' = 3,
    rows' = Set(0, 1, 2),
    rowEpoch' = Map(0 -> 0, 1 -> 0, 2 -> 1),
    unresolved' = Set(2),
    epochHead' = 1,
    lostRollback' = false,
    mutants' = m,
  }
  action init = initWith(SOUND)

  action unchangedAll = all {
    writer' = writer, currentFence' = currentFence, fences' = fences, lineageNext' = lineageNext,
    signed' = signed, nextContent' = nextContent, rows' = rows, rowEpoch' = rowEpoch,
    unresolved' = unresolved, epochHead' = epochHead, lostRollback' = lostRollback, mutants' = mutants,
  }

  action seal = all {
    epochHead < MAX_EPOCH, epochHead' = epochHead + 1,
    writer' = writer, currentFence' = currentFence, fences' = fences, lineageNext' = lineageNext,
    signed' = signed, nextContent' = nextContent, rows' = rows, rowEpoch' = rowEpoch,
    unresolved' = unresolved, lostRollback' = lostRollback, mutants' = mutants,
  }
  action revoke = all {
    writer, writer' = false,
    currentFence' = currentFence, fences' = fences, lineageNext' = lineageNext,
    signed' = signed, nextContent' = nextContent, rows' = rows, rowEpoch' = rowEpoch,
    unresolved' = unresolved, epochHead' = epochHead, lostRollback' = lostRollback, mutants' = mutants,
  }
  // A Writer issues an application source (unresolved until settled).
  action issue = all {
    writer, lineageNext <= MAX_SEQ,
    signed' = signed.union(Set((lineageNext, nextContent))), nextContent' = nextContent + 1,
    rows' = rows.union(Set(lineageNext)), rowEpoch' = rowEpoch.put(lineageNext, epochHead),
    unresolved' = unresolved.union(Set(lineageNext)), lineageNext' = lineageNext + 1,
    writer' = writer, currentFence' = currentFence, fences' = fences,
    epochHead' = epochHead, lostRollback' = lostRollback, mutants' = mutants,
  }
  // Commit (Writer) or authenticated abandonment (removed): a terminal resolution.
  action settle(s: int): bool = all {
    unresolved.contains(s),
    unresolved' = unresolved.exclude(Set(s)),
    writer' = writer, currentFence' = currentFence, fences' = fences, lineageNext' = lineageNext,
    signed' = signed, nextContent' = nextContent, rows' = rows, rowEpoch' = rowEpoch,
    epochHead' = epochHead, lostRollback' = lostRollback, mutants' = mutants,
  }
  // Re-admission: a fresh fence at the next sequence (never the released row).
  action readmit = all {
    not(writer),
    val n = if (mutants.lineageFromRows) maxOr(rows, -1) + 1 else lineageNext
    all {
      n <= MAX_SEQ,
      signed' = signed.union(Set((n, nextContent))), nextContent' = nextContent + 1,
      rows' = rows.union(Set(n)), rowEpoch' = rowEpoch.put(n, epochHead),
      fences' = fences.union(Set(n)), currentFence' = n,
      lineageNext' = if (n + 1 > lineageNext) n + 1 else lineageNext,
    },
    writer' = true, unresolved' = unresolved, epochHead' = epochHead, lostRollback' = lostRollback, mutants' = mutants,
  }
  // Ordinary retirement (unchanged): settled, non-fence rows outside the window.
  action retire(s: int): bool = all {
    rows.contains(s), not(fences.contains(s)), not(unresolved.contains(s)), rowEpoch.get(s) <= epochHead - 2,
    rows' = rows.exclude(Set(s)),
    writer' = writer, currentFence' = currentFence, fences' = fences, lineageNext' = lineageNext,
    signed' = signed, nextContent' = nextContent, rowEpoch' = rowEpoch,
    unresolved' = unresolved, epochHead' = epochHead, lostRollback' = lostRollback, mutants' = mutants,
  }
  // Candidate rule.
  action releaseFence(f: int): bool = all {
    rows.contains(f), fences.contains(f),
    mutants.allowWriter or not(writer) or f != currentFence,          // R1
    mutants.allowUnresolved or unresolved == Set(),                   // R2
    mutants.ignoreWindow or rowEpoch.get(f) <= epochHead - 2,              // R3
    rows' = rows.exclude(Set(f)),
    writer' = writer, currentFence' = currentFence, fences' = fences, lineageNext' = lineageNext,
    signed' = signed, nextContent' = nextContent, rowEpoch' = rowEpoch,
    unresolved' = unresolved, epochHead' = epochHead, lostRollback' = lostRollback, mutants' = mutants,
  }
  // A rollback to the previous epoch replays every row signed at or after it.
  action rollback = all {
    epochHead >= 1,
    val needed = rowEpoch.keys().filter(s => rowEpoch.get(s) >= epochHead - 1)
    lostRollback' = if (lostRollback) true else not(needed.subseteq(rows)),
    writer' = writer, currentFence' = currentFence, fences' = fences, lineageNext' = lineageNext,
    signed' = signed, nextContent' = nextContent, rows' = rows, rowEpoch' = rowEpoch,
    unresolved' = unresolved, epochHead' = epochHead, mutants' = mutants,
  }

  action step = any {
    seal, revoke, issue, readmit, rollback,
    nondet s = 0.to(MAX_SEQ).oneOf()
    any { settle(s), retire(s), releaseFence(s) },
  }

  val noEquivocation = signed.forall(a => signed.forall(b => a._1 != b._1 or a._2 == b._2))
  val writerFenceRetained = not(writer) or rows.contains(currentFence)
  val unresolvedBounded = unresolved.forall(s => rows.contains(fenceOf(fences, s)))
  val noLostRollback = not(lostRollback)
  val safety = noEquivocation and writerFenceRetained and unresolvedBounded and noLostRollback

  // The T9 shape: revoke, abandon the pending source, seal past the window,
  // retire the join and the abandoned row, release the fence, then re-admit.
  run releaseThenReadmitTest = init.then(revoke).then(settle(2)).then(seal).then(seal).then(seal)
    .then(retire(0)).then(retire(2)).then(releaseFence(1))
    .then(all { assert(rows == Set()), assert(safety), readmit })
    .then(all { assert(currentFence == 3), assert(rows == Set(3)), assert(safety), unchangedAll })
  // Today's rule (no release) is the hole: nothing else can retire seq 1.
  run fenceIsAHoleWithoutReleaseTest = init.then(revoke).then(settle(2)).then(seal).then(seal).then(seal)
    .then(all { assert(fences.contains(1) and rows.contains(1) and not(writer) and unresolved == Set()), unchangedAll })

  action initAllowWriter = initWith({ ...SOUND, allowWriter: true })
  action initAllowUnresolved = initWith({ ...SOUND, allowUnresolved: true })
  action initIgnoreWindow = initWith({ ...SOUND, ignoreWindow: true })
  action initLineageFromRows = initWith({ ...SOUND, lineageFromRows: true })

  run allowWriterBrokenTest = initAllowWriter.then(settle(2)).then(seal).then(seal).then(releaseFence(1))
    .then(all { assert(not(writerFenceRetained)), unchangedAll })
  run allowUnresolvedBrokenTest = initAllowUnresolved.then(revoke).then(seal).then(seal).then(releaseFence(1))
    .then(all { assert(not(unresolvedBounded)), unchangedAll })
  run ignoreWindowBrokenTest = initIgnoreWindow.then(revoke).then(settle(2)).then(releaseFence(1)).then(rollback)
    .then(all { assert(lostRollback), unchangedAll })
  run lineageFromRowsBrokenTest = initLineageFromRows.then(revoke).then(settle(2)).then(seal).then(seal).then(seal)
    .then(retire(2)).then(releaseFence(1)).then(readmit)
    .then(all { assert(not(noEquivocation)), unchangedAll })
}
