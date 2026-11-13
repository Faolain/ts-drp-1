module censusClassificationCell {
  // A creator close hold's recovery census (readCreatorRecoveryDependencyCensus) is a pure function of
  // its inputs: the complete native census, the outbox pages, the replay rows, pending ingress, rebase
  // state and the bound registration context. The hold is sealed with one census; every later check
  // must decide exactly as a complete census would (equal to the sealed one, or stale).
  //
  // Two cells may answer a check without classifying again (prepareCreatorUnchangedHeldCensusRead):
  // - the hold cell (no lease): it reads every input afresh and reuses the classification only when all of
  //   them equal the classified ones. A changed native census or replay row is stale; anything else runs
  //   the complete census, which re-captures the cell.
  // - a lease cell: inside one issuance lease the native census and the pages cannot change (the lease's
  //   native exclusion). Its storage probe is currency for that lease only; the replay, pending ingress,
  //   rebase state and context are compared on every check.
  // Pages carry rows the classification does not depend on (foreign objects): `foreign` models them.
  //
  // Mutants: the hold cell skipping the page comparison, or the pending-ingress comparison; a lease cell
  // whose probe is used in another lease (crossLeaseProbe). The safety invariant catches each.
  pure val VALUES = Set(0, 1)
  pure val NONE = -1
  pure val LEASES = Set(0, 1, 2)

  type Inputs = { native: int, pages: int, foreign: int, replay: int, pending: int, rebase: int, context: int }
  type Census = { native: int, pages: int, replay: int, pending: int, rebase: int, context: int }
  pure def classify(i: Inputs): Census =
    { native: i.native, pages: i.pages, replay: i.replay, pending: i.pending, rebase: i.rebase, context: i.context }

  var inputs: Inputs
  var sealed: Census
  var lease: int
  var nextLease: int
  var holdCell: Inputs
  var holdCellValid: bool
  var leaseCell: { lease: int, at: Inputs }
  var leaseCellValid: bool
  // The last check: what it saw, what it answered, and how.
  var lastSeen: Inputs
  var lastOk: bool
  var lastPath: str

  // Safety: every check answers as the complete census over the inputs it saw would.
  val exactDecision = lastOk == (classify(lastSeen) == sealed)
  val safety = exactDecision

  // Witnesses (existential coverage, expected to be violated).
  val noHoldReuseUnheld = not(lastPath == "hold-reuse-unheld")
  val noHoldReuseLeased = not(lastPath == "hold-reuse-leased")
  val noLeaseReuse = not(lastPath == "lease-reuse")
  val noRecapture = not(lastPath == "complete" and lastOk)
  val noStale = lastOk

  action init = {
    nondet native = VALUES.oneOf()
    nondet pages = VALUES.oneOf()
    nondet foreign = VALUES.oneOf()
    val i = { native: native, pages: pages, foreign: foreign, replay: 0, pending: 0, rebase: 0, context: 0 }
    all {
      inputs' = i, sealed' = classify(i), lease' = NONE, nextLease' = 0,
      // The seal's own complete census captures the hold cell (sealCreatorRecoveryDependencies).
      holdCell' = i, holdCellValid' = true,
      leaseCell' = { lease: NONE, at: i }, leaseCellValid' = false,
      lastSeen' = i, lastOk' = true, lastPath' = "seal",
    }
  }

  // Outside a lease anything may change; inside one, the native census and the pages cannot.
  action mutate = {
    nondet which = Set("native", "pages", "foreign", "replay", "pending", "rebase", "context").oneOf()
    nondet v = VALUES.oneOf()
    all {
      lease == NONE or not(Set("native", "pages", "foreign").contains(which)),
      inputs' = if (which == "native") inputs.with("native", v) else if (which == "pages") inputs.with("pages", v)
        else if (which == "foreign") inputs.with("foreign", v) else if (which == "replay") inputs.with("replay", v)
        else if (which == "pending") inputs.with("pending", v) else if (which == "rebase") inputs.with("rebase", v)
        else inputs.with("context", v),
      lease' = lease, nextLease' = nextLease, sealed' = sealed, holdCell' = holdCell, holdCellValid' = holdCellValid,
      leaseCell' = leaseCell, leaseCellValid' = leaseCellValid, lastSeen' = lastSeen, lastOk' = lastOk, lastPath' = lastPath,
    }
  }

  // A new lease starts without a currency cell; releasing a lease revokes its cell (ownIssuanceReservation,
  // child.release). crossLease keeps the old cell across leases (the mutant).
  action openLease(crossLease: bool): bool = all {
    lease == NONE, LEASES.contains(nextLease),
    lease' = nextLease, nextLease' = nextLease + 1,
    leaseCellValid' = (crossLease and leaseCellValid), leaseCell' = leaseCell,
    inputs' = inputs, sealed' = sealed, holdCell' = holdCell, holdCellValid' = holdCellValid,
    lastSeen' = lastSeen, lastOk' = lastOk, lastPath' = lastPath,
  }
  action closeLease(crossLease: bool): bool = all {
    lease != NONE, lease' = NONE, nextLease' = nextLease,
    leaseCellValid' = (crossLease and leaseCellValid), leaseCell' = leaseCell,
    inputs' = inputs, sealed' = sealed, holdCell' = holdCell, holdCellValid' = holdCellValid,
    lastSeen' = lastSeen, lastOk' = lastOk, lastPath' = lastPath,
  }

  // The fields a cell compares on every use, besides its currency for the native census and pages.
  pure def ambientSame(a: Inputs, b: Inputs, comparePending: bool): bool =
    a.replay == b.replay and a.rebase == b.rebase and a.context == b.context and (not(comparePending) or a.pending == b.pending)

  action check(comparePages: bool, comparePending: bool, crossLease: bool): bool =
    val now = inputs
    val complete = classify(now) == sealed
    // The lease probe answers "unchanged" for its own lease (the native exclusion); crossLease trusts it anywhere.
    val probeCurrent = leaseCellValid and lease != NONE and (crossLease or leaseCell.lease == lease)
    val leaseHit = probeCurrent and ambientSame(leaseCell.at, now, true)
    val holdSame = holdCellValid and holdCell.native == now.native and (not(comparePages) or (holdCell.pages == now.pages and holdCell.foreign == now.foreign))
      and ambientSame(holdCell, now, comparePending)
    val holdStale = holdCellValid and (holdCell.native != now.native or holdCell.replay != now.replay)
    if (leaseHit) all {
      lastSeen' = now, lastOk' = true, lastPath' = "lease-reuse",
      holdCell' = holdCell, holdCellValid' = holdCellValid, leaseCell' = leaseCell, leaseCellValid' = leaseCellValid,
    } else if (holdSame) all {
      lastSeen' = now, lastOk' = true, lastPath' = if (lease == NONE) "hold-reuse-unheld" else "hold-reuse-leased",
      holdCell' = holdCell, holdCellValid' = holdCellValid,
      // Under a lease the cell's actual complete read captures that lease's own probe.
      leaseCell' = if (lease == NONE) leaseCell else { lease: lease, at: holdCell },
      leaseCellValid' = (leaseCellValid or lease != NONE),
    } else if (holdStale) all {
      lastSeen' = now, lastOk' = false, lastPath' = "hold-stale",
      holdCell' = holdCell, holdCellValid' = holdCellValid, leaseCell' = leaseCell, leaseCellValid' = leaseCellValid,
    } else all {
      // The complete census; a success re-captures the hold cell (and the lease cell under a lease).
      lastSeen' = now, lastOk' = complete, lastPath' = "complete",
      holdCell' = if (complete) now else holdCell, holdCellValid' = (holdCellValid or complete),
      leaseCell' = if (complete and lease != NONE) { lease: lease, at: now } else leaseCell,
      leaseCellValid' = (leaseCellValid or (complete and lease != NONE)),
    }

  action checkStep(comparePages: bool, comparePending: bool, crossLease: bool): bool = all {
    check(comparePages, comparePending, crossLease),
    inputs' = inputs, sealed' = sealed, lease' = lease, nextLease' = nextLease,
  }

  action stepWith(comparePages: bool, comparePending: bool, crossLease: bool): bool = any {
    mutate, openLease(crossLease), closeLease(crossLease), checkStep(comparePages, comparePending, crossLease),
  }
  action step = stepWith(true, true, false)
  action stepIgnorePages = stepWith(false, true, false)
  action stepIgnorePending = stepWith(true, false, false)
  action stepCrossLeaseProbe = stepWith(true, true, true)
}
