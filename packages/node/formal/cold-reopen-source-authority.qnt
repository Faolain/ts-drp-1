// A member's settlement of its displaced own rows across epoch installs, and a cold reopen.
//
// A member at plane epoch P follows the creator with installs P -> P+1. At each install the plan merge
// may add "owed" rows of epoch P: own rows the creator's epoch P closed without, each needing a
// replacement row signed later. After the install the drain runs: rule R may defer (sign nothing this
// install), or the drain replaces owed rows (all of them, or a prefix oldest-first, deferring the rest).
//
// Replacing an owed row of epoch e needs source authority for e (that epoch's ACL). The drain resolves
// authority for every owed row before signing; a row without it makes the drain throw, the install
// fails, the session closes, and the member never advances again (STUCK). At plane P:
//   - epoch P-1 is always available: the plane's displaced source, rebuilt even by a cold reopen;
//   - kept: an in-memory copy the successor takes from its live predecessor at a live install,
//     kept' = ({P-1} + kept) restricted to the window. A cold reopen (crash, restart) clears it;
//   - records (FIX only): durable epochs. A record for e is written in the same atomic step that adds
//     owed rows of e to the plan (the merge at the install to e+1), and removed in the same step that
//     resolves the last owed row of e (replaced, or given back). Records survive a cold reopen.
// Settlement window W = 4: at the install to plane P, owed rows of epochs <= P-4 are given back (expired,
// handed back to the app), which needs no authority.
// Refused replay (int7 decision row 97): the drain's replay of an owed row may be refused by the Writer's
// own admission (the room's application state limit, the policy, a persisting transient refusal). The row
// is handed back in ONE plan write (`expire` + `handedBack`): it is no longer owed. The store accepts a
// plan only when every record names owed rows alone (copySettlementSourceAuthorities), so that write must
// narrow the record (normalizeSettlementSourceAuthorities) exactly like a replacement does.
//
// The defect (PRE-FIX): a deferral at plane P+1 leaves epoch-P rows owed at plane P+2, where only kept
// covers epoch P; a cold reopen clears kept, and the reopen's drain throws.
// The merge defect (MERGE, cand/int7-c3 before its fix): the records of FIX, but the refused-replay
// hand-back writes the prior plan's records unchanged; when the handed-back row's epoch is recorded the
// record names a row no longer owed, the store refuses the write, the install fails (STUCK).
//
// Invariants:
//   neverStuck               - the drain never throws;
//   coldReopenKeepsAuthority - every owed epoch e has authority: e == P-1, or e in kept, or e in records;
//   noReclaimWhileOwed (FIX) - every owed epoch below P-1 is recorded, and every record still has owed rows;
//   recordsBounded           - at most W - 1 = 3 records (the store's maxRecords).
// PRE-FIX must violate neverStuck (and coldReopenKeepsAuthority); MERGE must violate neverStuck; FIX must
// satisfy all of them.
module coldReopenSourceAuthority {
  pure val W = 4
  pure val MAX_P = 8
  pure val MAX_ROWS = 2
  pure val EPOCHS = 2.to(MAX_P)

  var mode: str                 // "fix" | "prefix" | "merge", fixed at init
  var plane: int                // P
  var owed: int -> int          // epoch -> owed rows of that epoch still in the plan (durable)
  var kept: Set[int]            // in-memory predecessor authority (cleared by a cold reopen)
  var records: Set[int]         // durable authority records (FIX only)
  var drainDue: bool            // an install or a reopen happened and its drain has not run yet
  var stuck: bool               // the drain threw; the member never advances again

  action initWith(m: str): bool = all {
    mode' = m, plane' = 2, owed' = EPOCHS.mapBy(_ => 0), kept' = Set(), records' = Set(),
    drainDue' = false, stuck' = false,
  }
  action init = initWith("fix")
  action initPreFix = initWith("prefix")
  action initMerge = initWith("merge")
  // Records are kept by FIX and by MERGE (MERGE differs only in the refused-replay hand-back write).
  val recordsKept = mode != "prefix"

  def owedOf(o: int -> int): Set[int] = EPOCHS.filter(e => o.get(e) > 0)
  val owedEpochs = owedOf(owed)
  def hasAuthority(e: int): bool = e == plane - 1 or kept.contains(e) or records.contains(e)
  val allCovered = owedEpochs.forall(e => hasAuthority(e))

  // Install P -> P+1 with n new owed rows of epoch P; rows of epochs <= P+1-W are given back.
  action installWith(n: int): bool = all {
    not(stuck), not(drainDue), plane < MAX_P,
    val p2 = plane + 1
    val kept2 = kept.union(Set(plane - 1)).filter(e => e > p2 - W)
    val owed2 = EPOCHS.mapBy(e => if (e == plane) n else if (e <= p2 - W) 0 else owed.get(e))
    all {
      plane' = p2, kept' = kept2, owed' = owed2,
      records' = if (recordsKept) owedOf(owed2).intersect(records.union(if (n > 0) Set(plane) else Set()))
                 else records,
      drainDue' = true, stuck' = false, mode' = mode,
    },
  }
  action install = { nondet n = 0.to(MAX_ROWS).oneOf() installWith(n) }

  // Rule R defers: nothing is signed this install.
  action drainDefer = all {
    not(stuck), drainDue,
    drainDue' = false,
    mode' = mode, plane' = plane, owed' = owed, kept' = kept, records' = records, stuck' = stuck,
  }

  // The drain resolves authority for every owed row; a missing one throws (STUCK).
  action drainThrow = all {
    not(stuck), drainDue, not(allCovered),
    stuck' = true, drainDue' = false,
    mode' = mode, plane' = plane, owed' = owed, kept' = kept, records' = records,
  }

  // Replace every owed row; resolved epochs lose their records.
  action drainAll = all {
    not(stuck), drainDue, allCovered,
    owed' = EPOCHS.mapBy(_ => 0), records' = Set(), drainDue' = false,
    mode' = mode, plane' = plane, kept' = kept, stuck' = stuck,
  }

  // Replace one row of the oldest owed epoch, then defer the rest; the last row of e drops e's record.
  action drainSome = all {
    not(stuck), drainDue, allCovered, owedEpochs != Set(),
    nondet e = owedEpochs.oneOf()
    val owed2 = owed.set(e, owed.get(e) - 1)
    all {
      owedEpochs.forall(x => x >= e),
      owed' = owed2, records' = records.intersect(owedOf(owed2)), drainDue' = false,
      mode' = mode, plane' = plane, kept' = kept, stuck' = stuck,
    },
  }

  // A refused replay: the drain replays a row of the oldest owed epoch, the Writer's own admission refuses
  // it, and it is handed back in ONE plan write (the row leaves the owed set). FIX narrows the records in
  // that write; MERGE writes them unchanged, and the store refuses a record naming the handed-back row:
  // nothing is written, the install fails, the member never advances again.
  action drainHandBack = all {
    not(stuck), drainDue, allCovered, owedEpochs != Set(),
    nondet e = owedEpochs.oneOf()
    val owed2 = owed.set(e, owed.get(e) - 1)
    val refusedByStore = mode == "merge" and records.contains(e)
    all {
      owedEpochs.forall(x => x >= e),
      owed' = if (refusedByStore) owed else owed2,
      records' = if (refusedByStore) records else records.intersect(owedOf(owed2)),
      stuck' = refusedByStore, drainDue' = false,
      mode' = mode, plane' = plane, kept' = kept,
    },
  }

  // Crash and cold reopen: kept is lost; the plan and the records survive; the reopen drains.
  action crashReopen = all {
    not(stuck),
    kept' = Set(), drainDue' = true,
    mode' = mode, plane' = plane, owed' = owed, records' = records, stuck' = stuck,
  }

  action stutter = all {
    mode' = mode, plane' = plane, owed' = owed, kept' = kept, records' = records,
    drainDue' = drainDue, stuck' = stuck,
  }

  action step = any { install, drainDefer, drainThrow, drainAll, drainSome, drainHandBack, crashReopen, stutter }

  val neverStuck = not(stuck)
  val coldReopenKeepsAuthority = allCovered
  val noReclaimWhileOwed = recordsKept implies
    (owedEpochs.forall(e => e < plane - 1 implies records.contains(e)) and records.subseteq(owedEpochs))
  // The store's record bound (SETTLEMENT_SOURCE_AUTHORITY_LIMITS.maxRecords = W - 1): the window leaves at
  // most the epochs P-1, P-2, P-3 owed, so the merge always finds a free slot for the epoch it closed.
  val recordsBounded = records.size() <= W - 1
  val safety = neverStuck and coldReopenKeepsAuthority and noReclaimWhileOwed and recordsBounded

  // FIX: owed epoch-2 rows deferred at plane 3, kept at plane 4, then a cold reopen: the record covers them.
  run fixColdReopenAfterDeferralTest =
    init.then(installWith(1)).then(drainDefer).then(installWith(0))
      .then(all { assert(owedEpochs == Set(2) and kept.contains(2) and records == Set(2)), crashReopen })
      .then(all { assert(kept == Set() and allCovered and safety), drainAll })
      .then(all { assert(owedEpochs == Set() and records == Set() and safety), stutter })

  // FIX: rows deferred until the window gives them back; their record goes with them.
  run fixWindowGivesBackTest =
    init.then(installWith(2)).then(drainDefer).then(installWith(0)).then(drainDefer)
      .then(crashReopen).then(drainSome)
      .then(all { assert(owed.get(2) == 1 and records == Set(2) and safety), installWith(0) })
      .then(drainDefer).then(installWith(0))
      .then(all { assert(plane == 6 and owedEpochs == Set() and records == Set() and safety), stutter })

  // FIX: a row deferred past its install is replayed at the next and refused; its hand-back narrows its
  // epoch's record, which keeps the other owed row, and the last hand-back drops the record.
  run fixRefusedReplayHandBackTest =
    init.then(installWith(2)).then(drainDefer).then(installWith(0))
      .then(all { assert(owed.get(2) == 2 and records == Set(2)), drainHandBack })
      .then(all { assert(owed.get(2) == 1 and records == Set(2) and safety), crashReopen })
      .then(drainHandBack)
      .then(all { assert(owedEpochs == Set() and records == Set() and safety), stutter })

  // MERGE: the same refused replay; the hand-back keeps the record naming the handed-back row, the store
  // refuses the write and the install fails.
  run mergeRefusedReplayStuckTest =
    initMerge.then(installWith(1)).then(drainDefer).then(installWith(0))
      .then(all { assert(records == Set(2)), drainHandBack })
      .then(all { assert(stuck and not(neverStuck) and owed.get(2) == 1), stutter })

  // MERGE without any deferral: the merge that adds an owed row records its epoch in the same write, so
  // even a replay refused in its own install's drain is a hand-back of a recorded row: the store refuses.
  run mergeOwnInstallHandBackStuckTest =
    initMerge.then(installWith(1))
      .then(all { assert(records == Set(2)), drainHandBack })
      .then(all { assert(stuck), stutter })

  // FIX: the same hand-back in its own install's drain writes, and the record leaves with the row.
  run fixOwnInstallHandBackTest =
    init.then(installWith(1)).then(drainHandBack)
      .then(all { assert(not(stuck) and owedEpochs == Set() and records == Set() and safety), stutter })

  // PRE-FIX without a crash: kept carries epoch 2's authority across the live install.
  run preFixLiveInstallReplacesTest =
    initPreFix.then(installWith(1)).then(drainDefer).then(installWith(0))
      .then(all { assert(allCovered), drainAll })
      .then(all { assert(owedEpochs == Set() and safety), stutter })

  // PRE-FIX: the same deferral, then a cold reopen: kept is gone and the reopen's drain throws.
  run preFixColdReopenStuckTest =
    initPreFix.then(installWith(1)).then(drainDefer).then(installWith(0)).then(crashReopen)
      .then(all { assert(not(coldReopenKeepsAuthority)), drainThrow })
      .then(all { assert(stuck and not(neverStuck)), stutter })
}
