module creatorAdoptionFenceAdmission {
  // The creator's adoption author fence admission (packages/node/src/creator-close.ts, the
  // issuance maintenance consumer; packages/node/src/v3-live.ts issueAuthorFence).
  //
  // Today every adoption fence takes the cold route: ordinaryDomain requires
  // planEffect === undefined, so a fence runs prepareCreatorIssuanceMaintenanceQuote (a complete
  // authenticated acquisition plus the prospective close forecast). The fence is ALSO always the
  // first admission of its epoch on a fresh close binding (bindCreatorLiveClose is per plane), so
  // no warm ordinary source exists when it is admitted: readiness runs after the drain.
  //
  // This model states the invariant any cheaper fence route must keep: a fence (or any row) is
  // admitted only if the COLD census of the rows visible right now admits it, with the fence's own
  // successor reserve. It models the candidate design "readiness first, then the fence through a
  // retained source": a source captured by readiness may be reused for the fence only when its
  // exact captured rows equal the current rows (verify-once, exact-byte; see
  // packages/storage-node/formal/journal-image-memo.qnt). Received appends (another Writer's rows,
  // admitted by their own cold check) and the creator's own ordinary moves may land between
  // readiness and the fence.
  //
  // Three fence routes observe every fence side by side; the state follows the exact route:
  //  - exact: reuse the source only on an exact row match, else the cold census   -> SOUND
  //  - stale: reuse any source captured this epoch (census state from before a
  //           later write)                                                       -> BROKEN
  //  - skip:  admit the fence unconditionally because the predecessor epoch
  //           reserved one fence (CREATOR_SETTLEMENT_RETAINED_FENCE_RESERVE)       -> BROKEN
  pure val VALUES = Set(1, 2, 3)
  pure val MAX_ROWS = 4
  // Stands for CLOSED_RETIREMENT_BYTES (786,432): the close's bounded union, never raised.
  pure val LIMIT = 7
  // A fence-shaped record's charge (the enforced fence preimage ceiling).
  pure val FENCE = 1
  // A fence keeps only its own single successor reserve (creator-source-custody.ts).
  pure val RESERVE = FENCE

  pure def charge(rows: List[int]): int = rows.foldl(0, (sum, row) => sum + row)
  // THE cold census: the complete close with the candidate and its successor reserve fits.
  pure def coldAdmits(rows: List[int], candidate: int): bool =
    rows.length() < MAX_ROWS and charge(rows) + candidate + RESERVE <= LIMIT

  type Source = { has: bool, rows: List[int] }
  type Fence = { live: bool, before: List[int], cold: bool,
    exactHit: bool, exactAdmit: bool, staleHit: bool, staleAdmit: bool, skipAdmit: bool }
  pure val noSource: Source = { has: false, rows: [] }
  pure val noFence: Fence = { live: false, before: [], cold: false,
    exactHit: false, exactAdmit: false, staleHit: false, staleAdmit: false, skipAdmit: false }

  var epoch: int
  var rows: List[int]
  var fenced: bool
  var source: Source
  var last: Fence

  action init = all {
    epoch' = 1, rows' = [], fenced' = false, source' = noSource, last' = noFence,
  }

  // Adoption: a new plane and a fresh close binding (no source). The retained rows carried into
  // the new epoch's close are any admitted prefix of at most two rows (the retention window).
  action adopt(keep: int): bool = all {
    epoch < 3, keep >= 0, keep <= 2, keep <= rows.length(),
    epoch' = epoch + 1, rows' = rows.slice(rows.length() - keep, rows.length()),
    fenced' = false, source' = noSource, last' = noFence,
  }

  // Readiness: a complete authenticated capture of the rows visible now (verified once).
  action readiness = all {
    source' = { has: true, rows: rows },
    epoch' = epoch, rows' = rows, fenced' = fenced, last' = noFence,
  }

  // Another Writer's received append, admitted by its own cold check. It does not touch the
  // creator's retained source: the source is now stale.
  action receivedAppend(v: int): bool = all {
    coldAdmits(rows, v),
    rows' = rows.append(v),
    epoch' = epoch, fenced' = fenced, source' = source, last' = noFence,
  }

  // The creator's own ordinary move on the incremental route: on an exact source match it is
  // charged against the source and the source advances by exactly this row; otherwise the cold
  // census decides and the source is dropped (the next admission re-primes).
  action ownMove(v: int): bool = all {
    coldAdmits(rows, v),
    rows' = rows.append(v),
    source' = if (source.has and source.rows == rows) { has: true, rows: rows.append(v) } else noSource,
    epoch' = epoch, fenced' = fenced, last' = noFence,
  }

  // The epoch's mandatory author fence.
  action fence = {
    val cold = coldAdmits(rows, FENCE)
    val exactHit = source.has and source.rows == rows
    val exactAdmit = if (exactHit) coldAdmits(source.rows, FENCE) else cold
    val staleHit = source.has
    val staleAdmit = if (staleHit) coldAdmits(source.rows, FENCE) else cold
    all {
      not(fenced),
      last' = { live: true, before: rows, cold: cold, exactHit: exactHit, exactAdmit: exactAdmit,
        staleHit: staleHit, staleAdmit: staleAdmit, skipAdmit: true },
      rows' = if (exactAdmit) rows.append(FENCE) else rows,
      fenced' = exactAdmit,
      source' = if (exactAdmit and exactHit) { has: true, rows: rows.append(FENCE) } else source,
      epoch' = epoch,
    }
  }

  action step = {
    nondet v = VALUES.oneOf()
    nondet keep = 0.to(2).oneOf()
    any { adopt(keep), readiness, receivedAppend(v), ownMove(v), fence }
  }

  // Every row admitted so far fits the close with one successor reserve.
  val rowsFit = charge(rows) + RESERVE <= LIMIT and rows.length() <= MAX_ROWS
  // A retained source never claims rows other than an exact capture of current or earlier rows
  // of this epoch (prefix of the current rows).
  val sourceIsPrefix = source.has implies (source.rows.length() <= rows.length() and
    0.to(MAX_ROWS - 1).forall(i => i >= source.rows.length() or source.rows[i] == rows[i]))
  // THE invariant: the exact route admits a fence iff the cold census of the rows visible at
  // that fence admits it (equal to the cold decision, so it never admits what cold refuses).
  val exactFenceIsCold = last.live implies last.exactAdmit == last.cold
  val safety = rowsFit and sourceIsPrefix and exactFenceIsCold
  // Broken variants: EXPECTED to be violated.
  val staleFenceIsCold = last.live implies (last.staleAdmit implies last.cold)
  val skipFenceIsCold = last.live implies (last.skipAdmit implies last.cold)
  // Reachability witnesses for the sound route.
  val reachedWarmFence = last.live and last.exactHit and last.exactAdmit
  val reachedColdFallbackFence = last.live and not(last.exactHit) and last.exactAdmit
  val reachedRefusedFence = last.live and not(last.exactAdmit)
  val reachedSecondEpochWarmFence = epoch >= 2 and last.live and last.exactHit and last.exactAdmit

  // Readiness first, then the fence: the warm fence equals the cold decision.
  run warmFenceTest = init.then(readiness).then(fence)
    .expect(safety and last.exactHit and last.exactAdmit and fenced)
  // At adoption the binding is fresh: the fence before readiness has no source (cold route).
  run freshBindingFenceTest = init.then(readiness).then(adopt(0)).then(fence)
    .expect(safety and not(last.exactHit) and last.exactAdmit and epoch == 2)
  // Own moves keep the source exact: the fence after them is still a warm hit.
  run ownMovesKeepSourceTest = init.then(readiness).then(ownMove(2)).then(ownMove(1)).then(fence)
    .expect(safety and last.exactHit and last.exactAdmit)
  // A received append after readiness leaves the source stale: the exact route falls back to
  // the cold census (and refuses when the close is full); the stale route reuses the old census
  // and admits a fence the cold census refuses.
  run staleAfterReceivedWitnessTest = init.then(ownMove(3)).then(readiness).then(receivedAppend(3)).then(fence)
    .expect(safety and not(last.exactHit) and not(last.cold) and not(last.exactAdmit)
      and last.staleHit and last.staleAdmit and not(staleFenceIsCold))
  // The predecessor's reserve does not cover a successor whose retained rows and received
  // appends already use the slack: skipping the census admits what cold refuses.
  run skipReserveWitnessTest = init.then(ownMove(3)).then(ownMove(1)).then(adopt(2)).then(receivedAppend(2)).then(fence)
    .expect(safety and not(last.cold) and not(skipFenceIsCold))
}
