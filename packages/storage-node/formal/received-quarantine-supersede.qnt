// A recipient's snapshot quarantine across successor installs that may die
// (SIGKILL, or any failure) after opening their received predecessor scope.
//
// An install at head h opens a temporary scope at its manifest epoch e: e = h
// for an adjacent successor, e > h for a checkpoint (cut.epoch). It then runs
// the received recovery turnover, retains e for recovery and advances the head
// to e + 1 (the head advance is a separate native write, so death can fall
// between retention and advance). The received turnover refuses when any
// physical scope below the head lies outside the recovery inventory
// (completeSnapshotRecoveryInventoryIsPresent): `turnoverAdmissible`.
//
// Rule (storage-node/storage-browser retainForRecovery): retaining epoch e
// deletes every TEMPORARY scope of the same object strictly below e that is
// collectible (not protected, not retired) when no retirement intent is active.
// Mutants: noSupersede is the shipped base; supersedeRecovery also deletes
// recovery scopes below e; supersedeAtOrAbove deletes temporaries at >= e
// other than the one being retained (an in-flight or future receive).
module receivedQuarantineSupersede {
  pure val MAX_EPOCH = 5
  pure val EPOCHS = 0.to(MAX_EPOCH)
  type Scope = { e: int, recovery: bool }
  type Mutants = { noSupersede: bool, supersedeRecovery: bool, supersedeAtOrAbove: bool }
  pure val SOUND: Mutants = { noSupersede: false, supersedeRecovery: false, supersedeAtOrAbove: false }

  var floorHead: int
  var scopes: Set[Scope]
  var receiving: int        // -1 none; otherwise the open install's manifest epoch
  var retained: int         // -1 none; epoch retained but floorHead not yet advanced
  var protectedEpochs: Set[int] // recovery scopes held by a retirement fence
  var lostRecovery: bool    // a recovery scope was deleted by the rule
  var lostLive: bool        // a temporary at/above the retained epoch was deleted
  var mutants: Mutants

  pure def epochsOf(ss: Set[Scope]): Set[int] = ss.map(s => s.e)

  // The received turnover's completeness predicate at head h.
  pure def admissible(ss: Set[Scope], h: int): bool = ss.forall(s => s.recovery or s.e >= h)

  pure def supersede(ss: Set[Scope], e: int, m: Mutants, held: Set[int]): Set[Scope] =
    if (m.noSupersede) ss
    else ss.filter(row =>
      not((not(row.recovery) or m.supersedeRecovery) and not(held.contains(row.e)) and
        (row.e < e or (m.supersedeAtOrAbove and row.e > e))))

  action initWith(m: Mutants): bool = all {
    floorHead' = 2,
    scopes' = Set({ e: 0, recovery: true }, { e: 1, recovery: true }),
    receiving' = -1, retained' = -1,
    protectedEpochs' = Set(1),
    lostRecovery' = false, lostLive' = false,
    mutants' = m,
  }
  action init = initWith(SOUND)

  // Open the received predecessor scope (reused when the same epoch's row exists).
  action open(e: int): bool = all {
    receiving == -1, retained == -1, e >= floorHead, e <= MAX_EPOCH,
    scopes' = if (epochsOf(scopes).contains(e)) scopes else scopes.union(Set({ e: e, recovery: false })),
    receiving' = e,
    floorHead' = floorHead, retained' = retained, protectedEpochs' = protectedEpochs,
    lostRecovery' = lostRecovery, lostLive' = lostLive, mutants' = mutants,
  }
  // The turnover runs inside the install; it must be admissible to proceed.
  pure def keptAfterRetain(ss: Set[Scope], e: int): Set[Scope] = ss.map(kept => if (kept.e == e) { e: kept.e, recovery: true } else kept)
  pure def lostBy(before: Set[Scope], after: Set[Scope], recovery: bool, above: int): bool =
    before.exists(row => row.recovery == recovery and (recovery or row.e > above) and not(after.contains(row)))
  action retain: bool = all {
    receiving != -1, admissible(scopes, floorHead),
    val kept = keptAfterRetain(scopes, receiving)
    val after = supersede(kept, receiving, mutants, protectedEpochs)
    all {
      scopes' = after,
      // if-form: quint 0.32 typescript evaluator returned false for `lostRecovery or lostBy(...)` here.
      lostRecovery' = if (lostRecovery) true else lostBy(kept, after, true, receiving),
      lostLive' = if (lostLive) true else lostBy(kept, after, false, receiving),
      retained' = receiving, receiving' = -1,
      floorHead' = floorHead, protectedEpochs' = protectedEpochs, mutants' = mutants,
    },
  }
  action advance: bool = all {
    retained != -1,
    floorHead' = retained + 1, retained' = -1,
    scopes' = scopes, receiving' = receiving, protectedEpochs' = protectedEpochs,
    lostRecovery' = lostRecovery, lostLive' = lostLive, mutants' = mutants,
  }
  // Process death (or a failed install): every durable row stays; volatile state is lost.
  action die: bool = all {
    receiving != -1 or retained != -1,
    receiving' = -1, retained' = -1,
    floorHead' = floorHead, scopes' = scopes, protectedEpochs' = protectedEpochs,
    lostRecovery' = lostRecovery, lostLive' = lostLive, mutants' = mutants,
  }
  // Ordinary turnover retires the oldest unprotected recovery scope (bounded pool).
  action retireOldest: bool = all {
    receiving == -1, retained == -1, admissible(scopes, floorHead),
    nondet victim = oneOf(scopes)
    all {
      victim.recovery, victim.e < floorHead - 2, not(protectedEpochs.contains(victim.e)),
      scopes' = scopes.exclude(Set(victim)),
    },
    floorHead' = floorHead, receiving' = receiving, retained' = retained, protectedEpochs' = protectedEpochs,
    lostRecovery' = lostRecovery, lostLive' = lostLive, mutants' = mutants,
  }
  action step = any {
    nondet e = oneOf(EPOCHS)
    open(e),
    retain, advance, die, retireOldest,
  }

  // Safety: no recovery scope and no live/future temporary scope is ever lost.
  val noLostRecovery = not(lostRecovery)
  val noLostLive = not(lostLive)
  // Whenever no install holds a retained-but-unadvanced epoch, the next turnover is admissible.
  val turnoverAdmissible = retained != -1 or admissible(scopes, floorHead)
  val safety = noLostRecovery and noLostLive and turnoverAdmissible

  // Witness trace (the T9 / recipient-crash shape): death after opening epoch 2
  // at head 2, then a checkpoint whose manifest epoch is 3, then one more install.
  run checkpointPastDeathTest = init.then(open(2)).then(die).then(open(3)).then(retain).then(advance)
    .then(all { assert(turnoverAdmissible), assert(not(epochsOf(scopes).contains(2))), open(4) })
    .then(all { assert(safety), retain })
  run supersedeRecoveryBrokenTest = initSupersedeRecovery.then(open(2)).then(retain).then(all { assert(lostRecovery), advance })
  run supersedeAtOrAboveBrokenTest = initSupersedeAtOrAbove.then(open(4)).then(die).then(open(2)).then(retain)
    .then(all { assert(lostLive), advance })
  run checkpointPastDeathBrokenTest = initNoSupersede.then(open(2)).then(die).then(open(3)).then(retain).then(advance)
    .then(all { assert(not(turnoverAdmissible)), floorHead' = floorHead, scopes' = scopes, receiving' = receiving,
      retained' = retained, protectedEpochs' = protectedEpochs, lostRecovery' = lostRecovery, lostLive' = lostLive,
      mutants' = mutants })

  // Broken controls.
  action initNoSupersede = initWith({ ...SOUND, noSupersede: true })
  action initSupersedeRecovery = initWith({ ...SOUND, supersedeRecovery: true })
  action initSupersedeAtOrAbove = initWith({ ...SOUND, supersedeAtOrAbove: true })
}
