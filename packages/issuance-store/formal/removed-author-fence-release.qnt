// Releasing a removed author's retained FENCE row (design candidate A in
// .logs/realtime-resume-2026-10-23/abandonment-crash-edge/FENCE-DESIGN.md), kept in
// sync with the implemented store law (packages/issuance-store/src/retirement.ts,
// retirementFenceIsReleasable / retirementEntryIsRetained).
//
// One author's local issuance: a join (seq 0), a join-time `$drp.author-fence.v1`
// no-op at seq 1, and application sources after it. A fence stops being the plan's
// current fence (`planFence`) at an epoch change (the merge clears it before the
// author's next fence) and for good when the author is removed; it then stays as an
// "expire" plan entry with NO resolution (a retained fence). Before the release rule
// the store never retired a retained fence while the plan had no current fence:
// after an ACL removal the row was a permanent hole.
//
// Implemented rule `releaseFence(f)`:
//   (R1) the plan has no current fence (a removed author issues none);
//   (R2) every plan entry other than retained fences carries an authenticated
//        terminal resolution (nothing left to reissue, rebase or abandon);
//   (R3) the ordinary retirement guards hold (epoch <= epochHead - 2: no rollback or
//        replay scope can still need it);
//   (R4) it never moves the durable lineage (next sequence) - re-admission issues
//        a fresh fence at lineage.next.
// Out of scope: with a current fence the shipped law already lets an older fence
// leave, but only once the creator's signed frontier covers it (terminalThrough or an
// old incarnation). That coverage is not modelled; modelling the release under R3
// alone violates unresolvedBounded (re-admit, release, remove again), so it is not
// the rule under check here.
//
// Properties: no sequence is ever signed twice with different content; the plan's
// current fence is retained; every unresolved source keeps the fence that bounds it;
// a rollback inside the retained window finds every row it needs. Mutants are the
// broken controls, one per rule clause plus a lineage-from-rows implementation that
// infers the next sequence from surviving rows.
module removedAuthorFenceRelease {
  pure val MAX_SEQ = 6
  pure val MAX_EPOCH = 6
  pure val NONE = -1
  type Mutants = { allowCurrentFence: bool, allowUnresolved: bool, ignoreWindow: bool, lineageFromRows: bool }
  pure val SOUND: Mutants = { allowCurrentFence: false, allowUnresolved: false, ignoreWindow: false, lineageFromRows: false }

  var writer: bool
  var planFence: int              // the plan's current fence sequence, or NONE
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
    planFence' = 1,
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
    writer' = writer, planFence' = planFence, fences' = fences, lineageNext' = lineageNext,
    signed' = signed, nextContent' = nextContent, rows' = rows, rowEpoch' = rowEpoch,
    unresolved' = unresolved, epochHead' = epochHead, lostRollback' = lostRollback, mutants' = mutants,
  }

  action seal = all {
    epochHead < MAX_EPOCH, epochHead' = epochHead + 1,
    writer' = writer, planFence' = planFence, fences' = fences, lineageNext' = lineageNext,
    signed' = signed, nextContent' = nextContent, rows' = rows, rowEpoch' = rowEpoch,
    unresolved' = unresolved, lostRollback' = lostRollback, mutants' = mutants,
  }
  // ACL removal: the removed author's plan keeps no current fence (it issues none).
  action revoke = all {
    writer, writer' = false, planFence' = NONE,
    fences' = fences, lineageNext' = lineageNext,
    signed' = signed, nextContent' = nextContent, rows' = rows, rowEpoch' = rowEpoch,
    unresolved' = unresolved, epochHead' = epochHead, lostRollback' = lostRollback, mutants' = mutants,
  }
  // A Writer's epoch change: the merge clears the current fence before the next one.
  action clearFence = all {
    writer, planFence != NONE, planFence' = NONE,
    writer' = writer, fences' = fences, lineageNext' = lineageNext,
    signed' = signed, nextContent' = nextContent, rows' = rows, rowEpoch' = rowEpoch,
    unresolved' = unresolved, epochHead' = epochHead, lostRollback' = lostRollback, mutants' = mutants,
  }
  // A fresh fence at the next sequence (never a released row); the caller sets writer'.
  action fence = all {
    planFence == NONE,
    val n = if (mutants.lineageFromRows) maxOr(rows, -1) + 1 else lineageNext
    all {
      n <= MAX_SEQ,
      signed' = signed.union(Set((n, nextContent))), nextContent' = nextContent + 1,
      rows' = rows.union(Set(n)), rowEpoch' = rowEpoch.put(n, epochHead),
      fences' = fences.union(Set(n)), planFence' = n,
      lineageNext' = if (n + 1 > lineageNext) n + 1 else lineageNext,
    },
    unresolved' = unresolved, epochHead' = epochHead, lostRollback' = lostRollback, mutants' = mutants,
  }
  // A Writer signs its next fence after the epoch-change merge.
  action writerFence = all { writer, fence, writer' = writer }
  // Re-admission: a fresh fence at the next sequence.
  action readmit = all { not(writer), fence, writer' = true }
  // A fenced Writer issues an application source (unresolved until settled).
  action issue = all {
    writer, planFence != NONE, lineageNext <= MAX_SEQ,
    signed' = signed.union(Set((lineageNext, nextContent))), nextContent' = nextContent + 1,
    rows' = rows.union(Set(lineageNext)), rowEpoch' = rowEpoch.put(lineageNext, epochHead),
    unresolved' = unresolved.union(Set(lineageNext)), lineageNext' = lineageNext + 1,
    writer' = writer, planFence' = planFence, fences' = fences,
    epochHead' = epochHead, lostRollback' = lostRollback, mutants' = mutants,
  }
  // Commit (Writer) or authenticated abandonment (removed): a terminal resolution.
  action settle(s: int): bool = all {
    unresolved.contains(s),
    unresolved' = unresolved.exclude(Set(s)),
    writer' = writer, planFence' = planFence, fences' = fences, lineageNext' = lineageNext,
    signed' = signed, nextContent' = nextContent, rows' = rows, rowEpoch' = rowEpoch,
    epochHead' = epochHead, lostRollback' = lostRollback, mutants' = mutants,
  }
  // Ordinary retirement (unchanged): settled, non-fence rows outside the window.
  action retire(s: int): bool = all {
    rows.contains(s), not(fences.contains(s)), not(unresolved.contains(s)), rowEpoch.get(s) <= epochHead - 2,
    rows' = rows.exclude(Set(s)),
    writer' = writer, planFence' = planFence, fences' = fences, lineageNext' = lineageNext,
    signed' = signed, nextContent' = nextContent, rowEpoch' = rowEpoch,
    unresolved' = unresolved, epochHead' = epochHead, lostRollback' = lostRollback, mutants' = mutants,
  }
  // Implemented rule.
  action releaseFence(f: int): bool = all {
    rows.contains(f), fences.contains(f),
    mutants.allowCurrentFence or planFence == NONE,                   // R1
    mutants.allowUnresolved or unresolved == Set(),                   // R2
    mutants.ignoreWindow or rowEpoch.get(f) <= epochHead - 2,         // R3
    rows' = rows.exclude(Set(f)),
    writer' = writer, planFence' = planFence, fences' = fences, lineageNext' = lineageNext,
    signed' = signed, nextContent' = nextContent, rowEpoch' = rowEpoch,
    unresolved' = unresolved, epochHead' = epochHead, lostRollback' = lostRollback, mutants' = mutants,
  }
  // A rollback to the previous epoch replays every row signed at or after it.
  action rollback = all {
    epochHead >= 1,
    val needed = rowEpoch.keys().filter(s => rowEpoch.get(s) >= epochHead - 1)
    lostRollback' = if (lostRollback) true else not(needed.subseteq(rows)),
    writer' = writer, planFence' = planFence, fences' = fences, lineageNext' = lineageNext,
    signed' = signed, nextContent' = nextContent, rows' = rows, rowEpoch' = rowEpoch,
    unresolved' = unresolved, epochHead' = epochHead, mutants' = mutants,
  }

  action step = any {
    seal, revoke, clearFence, writerFence, readmit, issue, rollback,
    nondet s = 0.to(MAX_SEQ).oneOf()
    any { settle(s), retire(s), releaseFence(s) },
  }

  val noEquivocation = signed.forall(a => signed.forall(b => a._1 != b._1 or a._2 == b._2))
  val planFenceRetained = planFence == NONE or rows.contains(planFence)
  val unresolvedBounded = unresolved.forall(s => rows.contains(fenceOf(fences, s)))
  val noLostRollback = not(lostRollback)
  val safety = noEquivocation and planFenceRetained and unresolvedBounded and noLostRollback

  // The T9 shape: revoke, abandon the pending source, seal past the window,
  // retire the join and the abandoned row, release the fence, then re-admit.
  run releaseThenReadmitTest = init.then(revoke).then(settle(2)).then(seal).then(seal).then(seal)
    .then(retire(0)).then(retire(2)).then(releaseFence(1))
    .then(all { assert(rows == Set()), assert(safety), readmit })
    .then(all { assert(planFence == 3), assert(rows == Set(3)), assert(lineageNext == 4), assert(safety), unchangedAll })
  // Removal with no pending work (native shape A): the fence alone releases.
  run releaseWithoutWorkTest = init.then(settle(2)).then(revoke).then(seal).then(seal).then(releaseFence(1))
    .then(all { assert(not(rows.contains(1))), assert(lineageNext == 3), assert(safety), unchangedAll })
  // Unresolved work keeps the fence (no release step is enabled).
  run unresolvedKeepsFenceTest = init.then(revoke).then(seal).then(seal).then(seal)
    .then(all { assert(rows.contains(1) and unresolved == Set(2) and planFence == NONE), unchangedAll })
  // Without the release rule nothing else can retire seq 1 of a removed author.
  run fenceIsAHoleWithoutReleaseTest = init.then(revoke).then(settle(2)).then(seal).then(seal).then(seal)
    .then(all { assert(fences.contains(1) and rows.contains(1) and not(writer) and unresolved == Set() and planFence == NONE),
      unchangedAll })
  // Re-admission over unresolved pre-removal work: the old fence stays (no current-fence
  // release here), the fresh fence is current, and the work is bounded.
  run readmitKeepsOldFenceTest = init.then(revoke).then(seal).then(seal).then(readmit)
    .then(all { assert(rows.contains(1)), assert(planFence == 3), assert(safety), unchangedAll })
  // A Writer between its epoch-change merge and its next fence, with nothing unresolved.
  run writerEpochChangeTest = init.then(settle(2)).then(seal).then(seal).then(clearFence).then(releaseFence(1))
    .then(writerFence).then(all { assert(planFence == 3), assert(safety), unchangedAll })

  action initAllowCurrentFence = initWith({ ...SOUND, allowCurrentFence: true })
  action initAllowUnresolved = initWith({ ...SOUND, allowUnresolved: true })
  action initIgnoreWindow = initWith({ ...SOUND, ignoreWindow: true })
  action initLineageFromRows = initWith({ ...SOUND, lineageFromRows: true })

  run allowCurrentFenceBrokenTest = initAllowCurrentFence.then(settle(2)).then(seal).then(seal).then(releaseFence(1))
    .then(all { assert(not(planFenceRetained)), unchangedAll })
  run allowUnresolvedBrokenTest = initAllowUnresolved.then(revoke).then(seal).then(seal).then(releaseFence(1))
    .then(all { assert(not(unresolvedBounded)), unchangedAll })
  run ignoreWindowBrokenTest = initIgnoreWindow.then(revoke).then(settle(2)).then(releaseFence(1)).then(rollback)
    .then(all { assert(lostRollback), unchangedAll })
  run lineageFromRowsBrokenTest = initLineageFromRows.then(revoke).then(settle(2)).then(seal).then(seal).then(seal)
    .then(retire(2)).then(releaseFence(1)).then(readmit)
    .then(all { assert(not(noEquivocation)), unchangedAll })
}
