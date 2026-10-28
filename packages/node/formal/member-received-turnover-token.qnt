// A member's (recipient's) received recovery turnover, run either by its own
// recovery-pool lull at an idle head or inline in the next successor install, and
// the token that lets the install skip a turnover the lull already ran.
//
// Builds on member-successor-install.qnt (the stuck-member fix): the same install
// steps, failure points, recovery and retirement-halt discharge, plus:
//   plane     the live plane handle's incarnation: a successor plane registers at
//             activate, and a recovery reopen or a process death opens a new one;
//   inv       the recovery-role inventory (captureRecoveryRoleInventory) as a
//             version: a reconcile may retire a scope, an install retains one;
//   work      the member's own retained/held work as the turnover's classification reads
//             it, as a version: its settlement plan (unresolved accepted work, its
//             dispositions and replacements). An abandonment
//             (abandonUnresolvedAcceptedWork) or a settlement resolution rewrites the plan
//             between a lull and the next install without moving the head, the Cut or the
//             recovery-role inventory; the reconciliation then protects or retires
//             differently (a scope held only by abandoned work becomes collectible);
//   edge      the received transition's own input: the received successor takes one slot
//             of the bounded recovery window (AHE_BOUNDED_READ_LIMITS.maxObjectGenerations),
//             so the install's classification authenticates one historical source fewer
//             than a lull's at the same head. A closed journal scope at or below that edge
//             (received epoch - maxObjectGenerations) that nothing else protects loses its
//             header's protection inside the install's turnover and is retired there; no
//             lull (which has no received successor) can retire it. The window slides at
//             every head advance, so an edge scope may appear at each commit;
//   token     what a completed lull leaves for the next install: the plane, the head
//             epoch, the inventory and the work it reconciled (NONE epoch: no token).
// The code keys the token by the plane handle (a WeakMap), so a reopen or a successor
// plane drops it; a lull clears it on entry and sets it only when its passes ran to
// completion; the install consumes it at its turnover step and skips only when the
// token's plane, epoch, inventory and work equal the current ones. The epoch fixes the
// current trust and the Cut the reconciliation classifies from (the current Cut is
// the transition record at epoch - 1 under that trust). The work binding is the
// settlement-plan image the classification reads for the member's own held work. The
// edge check is the install's own: at its decision point it reads the journal and turns
// over while an unprotected closed scope sits at or below the edge. The token shipped in
// 7125cdb1 had neither (SHIPPED below).
//
// Ghost state:
//   cleanAt     the head epoch whose complete reconciliation the durable state still
//               is (NONE once a partial reconciliation dirtied it);
//   cleanWork   the work version that reconciliation classified (with cleanAt: the
//               durable state is the complete reconciliation of (cleanAt, cleanWork));
//   reconciled  the head epochs a complete reconciliation ran at;
//   lulledAt    the head epoch of the last scheduled lull (one per adopted epoch).
//
// Properties:
//   skipSound          - an install skips only when the durable state is the complete
//                        reconciliation of the same head, with completed = head - 1;
//   skipSeesWork       - an install never skips a turnover that would change protection
//                        or retirement: at a skip the durable state is the reconciliation
//                        of the CURRENT work, and no edge scope is left for the install's
//                        own classification (the header-coverage regression: SHIPPED skips
//                        the edge retirement at every head once the window is full, and an
//                        abandonment between the lull and the install);
//   noLeftUnreconciled - no install leaves a head (epoch >= 2) whose Cut it did not
//                        see reconciled;
//   refusalEscapable   - the stuck-member property: a refused member can always
//                        recover into a resolvable registration (the retirement-halt
//                        discharge happens on every path);
//   noRedundant        - with no failure or death, no install turnover repeats a
//                        reconciliation of its head (the cost this token removes:
//                        base violates it; a scheduled lull after an explicit one, or a
//                        recovery's discharge, can still repeat one and is not counted);
//   cutsReconciled     - liveness: every head a member behind the creator is at is
//                        eventually reconciled, unless the session is terminal.
//
// Mutants (broken controls):
//   SHIPPED          - the 7125cdb1 token: plane, epoch and inventory; no work binding and
//                      no edge check (violates skipSeesWork; holds every other property);
//   workOnly         - the work binding without the edge check (violates skipSeesWork);
//   edgeOnly         - the edge check without the work binding (violates skipSeesWork);
//   abandonOnly      - edge check; no work binding; the boundary is instead invalidated by an
//                      abandonment but not by a settlement resolution (violates
//                      skipSeesWork: every plan mutator must invalidate);
//   allMutators      - edge check; no work binding; every plan mutator invalidates the
//                      boundary (the alternative fix; holds);
//   base             - no token: the install always turns over (violates noRedundant);
//   STALE            - a room-level "the lull ran" flag: not keyed by plane, epoch or
//                      inventory, never consumed or cleared (violates skipSound and
//                      noLeftUnreconciled);
//   single bindings  - initNoPlane, initNoEpoch, initNoInv, initNoConsume, initNoClear,
//                      initNoPlaneNoClear, initOnlyInv remove one or several bindings,
//                      to show which ones the properties depend on;
//   skipWithoutToken - the install skips whenever the pool is not full, token or not
//                      (violates skipSound and noLeftUnreconciled);
//   noDischarge      - the stuck-member fix removed: recovery leaves a halted reopen
//                      (violates refusalEscapable).
module memberReceivedTurnoverToken {
  pure val MAX_EPOCH = 4
  pure val MAX_FAILURES = 2
  pure val MAX_DEATHS = 1
  pure val NONE = -1

  // The token's bindings, each its own flag so each can be removed alone.
  type Mutants = { token: bool, skipWithoutToken: bool, noDischarge: bool,
    matchPlane: bool, matchEpoch: bool, matchInv: bool, consume: bool, clearOnEntry: bool,
    matchWork: bool, checkEdge: bool, invalidateOnAbandon: bool, invalidateOnSettle: bool }
  pure val SOUND: Mutants = { token: true, skipWithoutToken: false, noDischarge: false,
    matchPlane: true, matchEpoch: true, matchInv: true, consume: true, clearOnEntry: true,
    matchWork: true, checkEdge: true, invalidateOnAbandon: false, invalidateOnSettle: false }
  // The token shipped in 7125cdb1: no binding to the member's own work, no edge check.
  pure val SHIPPED: Mutants = { ...SOUND, matchWork: false, checkEdge: false }
  // A room-level "the lull ran" flag: no binding at all.
  pure val STALE: Mutants = { ...SOUND, matchPlane: false, matchEpoch: false, matchInv: false, consume: false,
    clearOnEntry: false, matchWork: false, checkEdge: false }
  type Token = { e: int, p: int, i: int, w: int }
  pure val NO_TOKEN: Token = { e: NONE, p: NONE, i: NONE, w: NONE }
  // Bounded plan rewrites (abandonments and settlement resolutions) per behavior.
  pure val MAX_WORK = 2

  var creatorEpoch: int
  var headEpoch: int
  var headPending: bool
  var regEpoch: int
  var regStatus: str        // active | receiving | terminal | halted
  var completed: int        // durable completed retirement through epoch (NONE: none)
  var recoveryRequired: bool
  var phase: str            // idle | started | recovered | received | fetched | turned | pending | committed
  var target: int
  var candidate: int
  var terminal: bool
  var failures: int
  var deaths: int
  var plane: int
  var inv: int
  var token: Token
  var cleanAt: int
  var work: int
  var cleanWork: int
  var staleSkip: bool
  var edge: bool
  var reconciled: Set[int]
  var lulledAt: int
  var badSkip: bool
  var leftUnreconciled: bool
  var redundant: bool
  var recovered: bool      // a recovery reopen happened (a failure path, as is a stale-target refusal)
  var m: Mutants

  pure def reopenHalted(h: int, c: int): bool = h >= 2 and c + 1 == h
  pure def max(a: int, b: int): int = if (a > b) a else b

  // One init per configuration (the TLA+ translation needs each init spelled out).
  action init = all {
    creatorEpoch' = 0, headEpoch' = 0, headPending' = false, regEpoch' = 0, regStatus' = "active",
    completed' = NONE, recoveryRequired' = false, phase' = "idle", target' = NONE, candidate' = NONE,
    terminal' = false, failures' = 0, deaths' = 0, plane' = 0, inv' = 0, token' = NO_TOKEN, cleanAt' = NONE,
    reconciled' = Set(), lulledAt' = NONE, badSkip' = false, leftUnreconciled' = false, redundant' = false, recovered' = false,
    work' = 0, cleanWork' = NONE, staleSkip' = false, edge' = false,
    m' = SOUND,
  }
  action initBase = all {
    creatorEpoch' = 0, headEpoch' = 0, headPending' = false, regEpoch' = 0, regStatus' = "active",
    completed' = NONE, recoveryRequired' = false, phase' = "idle", target' = NONE, candidate' = NONE,
    terminal' = false, failures' = 0, deaths' = 0, plane' = 0, inv' = 0, token' = NO_TOKEN, cleanAt' = NONE,
    reconciled' = Set(), lulledAt' = NONE, badSkip' = false, leftUnreconciled' = false, redundant' = false, recovered' = false,
    work' = 0, cleanWork' = NONE, staleSkip' = false, edge' = false,
    m' = { ...SOUND, token: false },
  }
  action initStaleToken = all {
    creatorEpoch' = 0, headEpoch' = 0, headPending' = false, regEpoch' = 0, regStatus' = "active",
    completed' = NONE, recoveryRequired' = false, phase' = "idle", target' = NONE, candidate' = NONE,
    terminal' = false, failures' = 0, deaths' = 0, plane' = 0, inv' = 0, token' = NO_TOKEN, cleanAt' = NONE,
    reconciled' = Set(), lulledAt' = NONE, badSkip' = false, leftUnreconciled' = false, redundant' = false, recovered' = false,
    work' = 0, cleanWork' = NONE, staleSkip' = false, edge' = false,
    m' = STALE,
  }
  action initNoPlane = all {
    creatorEpoch' = 0, headEpoch' = 0, headPending' = false, regEpoch' = 0, regStatus' = "active",
    completed' = NONE, recoveryRequired' = false, phase' = "idle", target' = NONE, candidate' = NONE,
    terminal' = false, failures' = 0, deaths' = 0, plane' = 0, inv' = 0, token' = NO_TOKEN, cleanAt' = NONE,
    reconciled' = Set(), lulledAt' = NONE, badSkip' = false, leftUnreconciled' = false, redundant' = false, recovered' = false,
    work' = 0, cleanWork' = NONE, staleSkip' = false, edge' = false,
    m' = { ...SOUND, matchPlane: false },
  }
  action initNoEpoch = all {
    creatorEpoch' = 0, headEpoch' = 0, headPending' = false, regEpoch' = 0, regStatus' = "active",
    completed' = NONE, recoveryRequired' = false, phase' = "idle", target' = NONE, candidate' = NONE,
    terminal' = false, failures' = 0, deaths' = 0, plane' = 0, inv' = 0, token' = NO_TOKEN, cleanAt' = NONE,
    reconciled' = Set(), lulledAt' = NONE, badSkip' = false, leftUnreconciled' = false, redundant' = false, recovered' = false,
    work' = 0, cleanWork' = NONE, staleSkip' = false, edge' = false,
    m' = { ...SOUND, matchEpoch: false },
  }
  action initNoInv = all {
    creatorEpoch' = 0, headEpoch' = 0, headPending' = false, regEpoch' = 0, regStatus' = "active",
    completed' = NONE, recoveryRequired' = false, phase' = "idle", target' = NONE, candidate' = NONE,
    terminal' = false, failures' = 0, deaths' = 0, plane' = 0, inv' = 0, token' = NO_TOKEN, cleanAt' = NONE,
    reconciled' = Set(), lulledAt' = NONE, badSkip' = false, leftUnreconciled' = false, redundant' = false, recovered' = false,
    work' = 0, cleanWork' = NONE, staleSkip' = false, edge' = false,
    m' = { ...SOUND, matchInv: false },
  }
  action initNoConsume = all {
    creatorEpoch' = 0, headEpoch' = 0, headPending' = false, regEpoch' = 0, regStatus' = "active",
    completed' = NONE, recoveryRequired' = false, phase' = "idle", target' = NONE, candidate' = NONE,
    terminal' = false, failures' = 0, deaths' = 0, plane' = 0, inv' = 0, token' = NO_TOKEN, cleanAt' = NONE,
    reconciled' = Set(), lulledAt' = NONE, badSkip' = false, leftUnreconciled' = false, redundant' = false, recovered' = false,
    work' = 0, cleanWork' = NONE, staleSkip' = false, edge' = false,
    m' = { ...SOUND, consume: false },
  }
  action initNoClear = all {
    creatorEpoch' = 0, headEpoch' = 0, headPending' = false, regEpoch' = 0, regStatus' = "active",
    completed' = NONE, recoveryRequired' = false, phase' = "idle", target' = NONE, candidate' = NONE,
    terminal' = false, failures' = 0, deaths' = 0, plane' = 0, inv' = 0, token' = NO_TOKEN, cleanAt' = NONE,
    reconciled' = Set(), lulledAt' = NONE, badSkip' = false, leftUnreconciled' = false, redundant' = false, recovered' = false,
    work' = 0, cleanWork' = NONE, staleSkip' = false, edge' = false,
    m' = { ...SOUND, clearOnEntry: false },
  }
  action initNoPlaneNoClear = all {
    creatorEpoch' = 0, headEpoch' = 0, headPending' = false, regEpoch' = 0, regStatus' = "active",
    completed' = NONE, recoveryRequired' = false, phase' = "idle", target' = NONE, candidate' = NONE,
    terminal' = false, failures' = 0, deaths' = 0, plane' = 0, inv' = 0, token' = NO_TOKEN, cleanAt' = NONE,
    reconciled' = Set(), lulledAt' = NONE, badSkip' = false, leftUnreconciled' = false, redundant' = false, recovered' = false,
    work' = 0, cleanWork' = NONE, staleSkip' = false, edge' = false,
    m' = { ...SOUND, matchPlane: false, clearOnEntry: false },
  }
  action initOnlyInv = all {
    creatorEpoch' = 0, headEpoch' = 0, headPending' = false, regEpoch' = 0, regStatus' = "active",
    completed' = NONE, recoveryRequired' = false, phase' = "idle", target' = NONE, candidate' = NONE,
    terminal' = false, failures' = 0, deaths' = 0, plane' = 0, inv' = 0, token' = NO_TOKEN, cleanAt' = NONE,
    reconciled' = Set(), lulledAt' = NONE, badSkip' = false, leftUnreconciled' = false, redundant' = false, recovered' = false,
    work' = 0, cleanWork' = NONE, staleSkip' = false, edge' = false,
    m' = { ...SOUND, matchPlane: false, matchEpoch: false, consume: false, clearOnEntry: false },
  }
  action initSkipWithoutToken = all {
    creatorEpoch' = 0, headEpoch' = 0, headPending' = false, regEpoch' = 0, regStatus' = "active",
    completed' = NONE, recoveryRequired' = false, phase' = "idle", target' = NONE, candidate' = NONE,
    terminal' = false, failures' = 0, deaths' = 0, plane' = 0, inv' = 0, token' = NO_TOKEN, cleanAt' = NONE,
    reconciled' = Set(), lulledAt' = NONE, badSkip' = false, leftUnreconciled' = false, redundant' = false, recovered' = false,
    work' = 0, cleanWork' = NONE, staleSkip' = false, edge' = false,
    m' = { ...SOUND, skipWithoutToken: true },
  }
  action initNoDischarge = all {
    creatorEpoch' = 0, headEpoch' = 0, headPending' = false, regEpoch' = 0, regStatus' = "active",
    completed' = NONE, recoveryRequired' = false, phase' = "idle", target' = NONE, candidate' = NONE,
    terminal' = false, failures' = 0, deaths' = 0, plane' = 0, inv' = 0, token' = NO_TOKEN, cleanAt' = NONE,
    reconciled' = Set(), lulledAt' = NONE, badSkip' = false, leftUnreconciled' = false, redundant' = false, recovered' = false,
    work' = 0, cleanWork' = NONE, staleSkip' = false, edge' = false,
    m' = { ...SOUND, noDischarge: true },
  }
  action initShipped = all {
    creatorEpoch' = 0, headEpoch' = 0, headPending' = false, regEpoch' = 0, regStatus' = "active",
    completed' = NONE, recoveryRequired' = false, phase' = "idle", target' = NONE, candidate' = NONE,
    terminal' = false, failures' = 0, deaths' = 0, plane' = 0, inv' = 0, token' = NO_TOKEN, cleanAt' = NONE,
    reconciled' = Set(), lulledAt' = NONE, badSkip' = false, leftUnreconciled' = false, redundant' = false, recovered' = false,
    work' = 0, cleanWork' = NONE, staleSkip' = false, edge' = false,
    m' = SHIPPED,
  }
  action initAbandonOnly = all {
    creatorEpoch' = 0, headEpoch' = 0, headPending' = false, regEpoch' = 0, regStatus' = "active",
    completed' = NONE, recoveryRequired' = false, phase' = "idle", target' = NONE, candidate' = NONE,
    terminal' = false, failures' = 0, deaths' = 0, plane' = 0, inv' = 0, token' = NO_TOKEN, cleanAt' = NONE,
    reconciled' = Set(), lulledAt' = NONE, badSkip' = false, leftUnreconciled' = false, redundant' = false, recovered' = false,
    work' = 0, cleanWork' = NONE, staleSkip' = false, edge' = false,
    m' = { ...SHIPPED, checkEdge: true, invalidateOnAbandon: true },
  }
  action initAllMutators = all {
    creatorEpoch' = 0, headEpoch' = 0, headPending' = false, regEpoch' = 0, regStatus' = "active",
    completed' = NONE, recoveryRequired' = false, phase' = "idle", target' = NONE, candidate' = NONE,
    terminal' = false, failures' = 0, deaths' = 0, plane' = 0, inv' = 0, token' = NO_TOKEN, cleanAt' = NONE,
    reconciled' = Set(), lulledAt' = NONE, badSkip' = false, leftUnreconciled' = false, redundant' = false, recovered' = false,
    work' = 0, cleanWork' = NONE, staleSkip' = false, edge' = false,
    m' = { ...SHIPPED, checkEdge: true, invalidateOnAbandon: true, invalidateOnSettle: true },
  }
  action initWorkOnly = all {
    creatorEpoch' = 0, headEpoch' = 0, headPending' = false, regEpoch' = 0, regStatus' = "active",
    completed' = NONE, recoveryRequired' = false, phase' = "idle", target' = NONE, candidate' = NONE,
    terminal' = false, failures' = 0, deaths' = 0, plane' = 0, inv' = 0, token' = NO_TOKEN, cleanAt' = NONE,
    reconciled' = Set(), lulledAt' = NONE, badSkip' = false, leftUnreconciled' = false, redundant' = false, recovered' = false,
    work' = 0, cleanWork' = NONE, staleSkip' = false, edge' = false,
    m' = { ...SOUND, checkEdge: false },
  }
  action initEdgeOnly = all {
    creatorEpoch' = 0, headEpoch' = 0, headPending' = false, regEpoch' = 0, regStatus' = "active",
    completed' = NONE, recoveryRequired' = false, phase' = "idle", target' = NONE, candidate' = NONE,
    terminal' = false, failures' = 0, deaths' = 0, plane' = 0, inv' = 0, token' = NO_TOKEN, cleanAt' = NONE,
    reconciled' = Set(), lulledAt' = NONE, badSkip' = false, leftUnreconciled' = false, redundant' = false, recovered' = false,
    work' = 0, cleanWork' = NONE, staleSkip' = false, edge' = false,
    m' = { ...SOUND, matchWork: false },
  }

  // Unchanged-variable groups.
  action keepGhost = all {
    recovered' = recovered, cleanAt' = cleanAt, reconciled' = reconciled, lulledAt' = lulledAt, badSkip' = badSkip,
    leftUnreconciled' = leftUnreconciled, redundant' = redundant, m' = m,
  }
  // The member's own work and the reconciliation's view of it.
  action keepWork = all { work' = work, cleanWork' = cleanWork, staleSkip' = staleSkip, edge' = edge }
  action keepMember = all {
    headEpoch' = headEpoch, headPending' = headPending, regEpoch' = regEpoch, regStatus' = regStatus,
    completed' = completed, recoveryRequired' = recoveryRequired, phase' = phase, target' = target,
    terminal' = terminal, failures' = failures, deaths' = deaths, plane' = plane, inv' = inv, token' = token,
  }

  // A complete reconciliation at the current head: redundant when the state already is one.
  pure def redundantNow(clean: int, cw: int, h: int, w: int, e: bool, f: int, d: int, was: bool): bool =
    if (clean == h and cw == w and not(e) and f == 0 and d == 0) true else was

  action creatorAdvance: bool = all {
    creatorEpoch < MAX_EPOCH, creatorEpoch' = creatorEpoch + 1, candidate' = candidate, keepMember, keepGhost,
  }
  action offer: bool = all {
    not(terminal), creatorEpoch > headEpoch, creatorEpoch > candidate,
    candidate' = creatorEpoch, creatorEpoch' = creatorEpoch, keepMember, keepGhost,
  }
  action start: bool = all {
    not(terminal), phase == "idle", candidate > headEpoch,
    phase' = "started", target' = candidate, candidate' = NONE, creatorEpoch' = creatorEpoch,
    headEpoch' = headEpoch, headPending' = headPending, regEpoch' = regEpoch, regStatus' = regStatus,
    completed' = completed, recoveryRequired' = recoveryRequired, terminal' = terminal, failures' = failures,
    deaths' = deaths, plane' = plane, inv' = inv, token' = token, keepGhost,
  }
  // recoverSettlementOwner(true): a reopen (new plane handle). A reopen halted on a
  // completed retirement is discharged by the original reconciliation (the stuck-member
  // fix), which is a complete reconciliation of this head; it leaves no token.
  action recover: bool = all {
    phase == "started", recoveryRequired,
    val halted = reopenHalted(headEpoch, completed)
    val discharged = halted and not(m.noDischarge)
    all {
      regStatus' = if (halted and m.noDischarge) "halted" else "active",
      cleanAt' = if (discharged) headEpoch else cleanAt,
      cleanWork' = if (discharged) work else cleanWork,
      reconciled' = if (discharged) reconciled.union(Set(headEpoch)) else reconciled,
    },
    work' = work, staleSkip' = staleSkip, edge' = edge,
    regEpoch' = headEpoch, recoveryRequired' = false, phase' = "recovered", plane' = plane + 1,
    token' = token,
    creatorEpoch' = creatorEpoch, headEpoch' = headEpoch, headPending' = headPending, completed' = completed,
    target' = target, candidate' = candidate, terminal' = terminal, failures' = failures, deaths' = deaths, inv' = inv,
    lulledAt' = lulledAt, badSkip' = badSkip, leftUnreconciled' = leftUnreconciled, redundant' = redundant, recovered' = true, m' = m,
  }
  action recoverFails: bool = all {
    phase == "started", recoveryRequired, failures < MAX_FAILURES,
    terminal' = true, phase' = "idle", failures' = failures + 1, regStatus' = "terminal",
    creatorEpoch' = creatorEpoch, headEpoch' = headEpoch, headPending' = headPending, regEpoch' = regEpoch,
    completed' = completed, recoveryRequired' = recoveryRequired, target' = target, candidate' = candidate,
    deaths' = deaths, plane' = plane, inv' = inv, token' = token, keepGhost,
  }
  action skipRecover: bool = all {
    phase == "started", not(recoveryRequired), phase' = "recovered",
    creatorEpoch' = creatorEpoch, headEpoch' = headEpoch, headPending' = headPending, regEpoch' = regEpoch,
    regStatus' = regStatus, completed' = completed, recoveryRequired' = recoveryRequired, target' = target,
    candidate' = candidate, terminal' = terminal, failures' = failures, deaths' = deaths, plane' = plane,
    inv' = inv, token' = token, keepGhost,
  }
  val resolves = regStatus == "active" and regEpoch == headEpoch and not(headPending)
  action precheck: bool = all {
    phase == "recovered",
    if (resolves) all { phase' = "received", regStatus' = "receiving", recoveryRequired' = recoveryRequired }
    else all { phase' = "idle", regStatus' = regStatus, recoveryRequired' = true },
    creatorEpoch' = creatorEpoch, headEpoch' = headEpoch, headPending' = headPending, regEpoch' = regEpoch,
    completed' = completed, target' = target, candidate' = candidate, terminal' = terminal, failures' = failures,
    deaths' = deaths, plane' = plane, inv' = inv, token' = token, keepGhost,
  }
  action fetch: bool = all {
    phase == "received",
    if (target < creatorEpoch) all { phase' = "idle", regStatus' = "terminal", recoveryRequired' = true }
    else all { phase' = "fetched", regStatus' = regStatus, recoveryRequired' = recoveryRequired },
    creatorEpoch' = creatorEpoch, headEpoch' = headEpoch, headPending' = headPending, regEpoch' = regEpoch,
    completed' = completed, target' = target, candidate' = candidate, terminal' = terminal, failures' = failures,
    deaths' = deaths, plane' = plane, inv' = inv, token' = token, keepGhost,
  }
  // The install's turnover step (prepareReceivedRecoveryTurnover). Due at every head
  // >= 2 here (the app's classified Cut keeps it due). The token is consumed; the
  // install skips when it matches (or, mutant, without one); otherwise it runs the
  // complete original passes.
  val tokenMatches = token.e != NONE and (not(m.matchEpoch) or token.e == headEpoch) and
    (not(m.matchInv) or token.i == inv) and (not(m.matchPlane) or token.p == plane) and
    (not(m.matchWork) or token.w == work) and
    // The install's own check at its decision point (not a token binding).
    (not(m.checkEdge) or not(edge))
  // A lull-view reconciliation of this head and this work is the durable state.
  val lullReconciledNow = cleanAt == headEpoch and cleanWork == work
  // The install's turnover would change nothing: the lull-view reconciliation, and no edge.
  val reconciledNow = lullReconciledNow and not(edge)
  val skips = headEpoch >= 2 and (m.skipWithoutToken or (m.token and tokenMatches))
  action turnover: bool = {
    nondet retires = Set(true, false).oneOf()
    all {
      phase == "fetched", phase' = "turned",
      token' = if (m.consume) NO_TOKEN else token,
      work' = work,
      if (headEpoch < 2) all {
        completed' = completed, inv' = inv, cleanAt' = cleanAt, reconciled' = reconciled, recovered' = recovered, redundant' = redundant,
        badSkip' = badSkip, cleanWork' = cleanWork, staleSkip' = staleSkip, edge' = edge,
      } else if (skips) all {
        completed' = completed, inv' = inv, cleanAt' = cleanAt, reconciled' = reconciled, recovered' = recovered, redundant' = redundant,
        badSkip' = if (cleanAt == headEpoch and completed == headEpoch - 1) badSkip else true,
        cleanWork' = cleanWork, edge' = edge,
        // The skipped turnover would classify the current work, or the edge, differently.
        staleSkip' = if (cleanWork == work and not(edge)) staleSkip else true,
      } else all {
        // The install's classification retires the edge scope (a header retirement).
        completed' = max(completed, headEpoch - 1), inv' = if ((retires and not(lullReconciledNow)) or edge) inv + 1 else inv,
        cleanAt' = headEpoch, cleanWork' = work, edge' = false, reconciled' = reconciled.union(Set(headEpoch)),
        recovered' = recovered,
        redundant' = if (recovered) redundant else redundantNow(cleanAt, cleanWork, headEpoch, work, edge, failures, deaths, redundant),
        badSkip' = badSkip, staleSkip' = staleSkip,
      },
      creatorEpoch' = creatorEpoch, headEpoch' = headEpoch, headPending' = headPending, regEpoch' = regEpoch,
      regStatus' = regStatus, recoveryRequired' = recoveryRequired, target' = target, candidate' = candidate,
      terminal' = terminal, failures' = failures, deaths' = deaths, plane' = plane,
      lulledAt' = lulledAt, leftUnreconciled' = leftUnreconciled, m' = m,
    }
  }
  // A transient failure inside the receive. Inside the turnover it may leave a partial
  // reconciliation (dirty state, maybe a completed control, maybe a retired scope).
  action receiveFails: bool = {
    nondet partial = Set(true, false).oneOf()
    nondet c = Set(completed, max(completed, headEpoch - 1)).oneOf()
    nondet retires = Set(true, false).oneOf()
    val dirty = partial and phase == "fetched" and headEpoch >= 2
    all {
      Set("received", "fetched", "turned").contains(phase), failures < MAX_FAILURES,
      phase' = "idle", regStatus' = "terminal", recoveryRequired' = true, failures' = failures + 1,
      completed' = if (dirty) c else completed, inv' = if (dirty and retires) inv + 1 else inv,
      cleanAt' = if (dirty) NONE else cleanAt,
      creatorEpoch' = creatorEpoch, headEpoch' = headEpoch, headPending' = headPending, regEpoch' = regEpoch,
      target' = target, candidate' = candidate, terminal' = terminal, deaths' = deaths, plane' = plane,
      token' = token, reconciled' = reconciled, lulledAt' = lulledAt, badSkip' = badSkip,
      leftUnreconciled' = leftUnreconciled, recovered' = recovered, redundant' = redundant, m' = m, keepWork,
    }
  }
  // The install retains its received scope (inventory changes) and begins the head advance.
  action pending: bool = all {
    phase == "turned", phase' = "pending", headPending' = true, inv' = inv + 1,
    leftUnreconciled' = if (headEpoch >= 2 and cleanAt != headEpoch) true else leftUnreconciled,
    creatorEpoch' = creatorEpoch, headEpoch' = headEpoch, regEpoch' = regEpoch, regStatus' = regStatus,
    completed' = completed, recoveryRequired' = recoveryRequired, target' = target, candidate' = candidate,
    terminal' = terminal, failures' = failures, deaths' = deaths, plane' = plane, token' = token,
    cleanAt' = cleanAt, reconciled' = reconciled, lulledAt' = lulledAt, badSkip' = badSkip, recovered' = recovered, redundant' = redundant,
    m' = m,
  }
  action commit: bool = all {
    phase == "pending", phase' = "committed", headPending' = false, headEpoch' = target,
    creatorEpoch' = creatorEpoch, regEpoch' = regEpoch, regStatus' = regStatus, completed' = completed,
    recoveryRequired' = recoveryRequired, target' = target, candidate' = candidate, terminal' = terminal,
    failures' = failures, deaths' = deaths, plane' = plane, inv' = inv, token' = token, keepGhost,
  }
  // The successor plane registers: a new plane handle.
  action activate: bool = all {
    phase == "committed", phase' = "idle", regEpoch' = target, regStatus' = "active", plane' = plane + 1,
    token' = token,
    creatorEpoch' = creatorEpoch, headEpoch' = headEpoch, headPending' = headPending, completed' = completed,
    recoveryRequired' = recoveryRequired, target' = target, candidate' = candidate, terminal' = terminal,
    failures' = failures, deaths' = deaths, inv' = inv, keepGhost,
  }
  action adoptionFails: bool = all {
    Set("pending", "committed").contains(phase), failures < MAX_FAILURES,
    terminal' = true, phase' = "idle", regStatus' = "terminal", failures' = failures + 1, recoveryRequired' = true,
    creatorEpoch' = creatorEpoch, headEpoch' = headEpoch, headPending' = headPending, regEpoch' = regEpoch,
    completed' = completed, target' = target, candidate' = candidate, deaths' = deaths, plane' = plane, inv' = inv,
    token' = token, keepGhost,
  }
  // The member's scheduled recovery-pool lull at an idle head (one per adopted epoch):
  // clears the token on entry, runs the complete passes, leaves a token for this plane,
  // head and the inventory it leaves.
  val lullBoundary = not(terminal) and phase == "idle" and resolves and headEpoch >= 2 and not(recoveryRequired)
  val lullEnabled = lullBoundary and lulledAt != headEpoch
  // An application's explicit maintainRecoveryPool() (or a session without scheduled
  // lulls): the same passes at any idle boundary; not counted as redundant.
  action explicitLull: bool = {
    nondet retires = Set(true, false).oneOf()
    // A reconciliation of an already reconciled state retires nothing.
    val nextInv = if (retires and not(lullReconciledNow)) inv + 1 else inv
    all {
      lullBoundary,
      completed' = max(completed, headEpoch - 1), inv' = nextInv,
      token' = if (m.token) { e: headEpoch, p: plane, i: nextInv, w: work } else NO_TOKEN,
      cleanAt' = headEpoch, cleanWork' = work, work' = work, staleSkip' = staleSkip, edge' = edge, reconciled' = reconciled.union(Set(headEpoch)), lulledAt' = lulledAt,
      recovered' = recovered, redundant' = redundant,
      creatorEpoch' = creatorEpoch, headEpoch' = headEpoch, headPending' = headPending, regEpoch' = regEpoch,
      regStatus' = regStatus, recoveryRequired' = recoveryRequired, phase' = phase, target' = target,
      candidate' = candidate, terminal' = terminal, failures' = failures, deaths' = deaths, plane' = plane,
      badSkip' = badSkip, leftUnreconciled' = leftUnreconciled, m' = m,
    }
  }
  action lull: bool = {
    nondet retires = Set(true, false).oneOf()
    // A reconciliation of an already reconciled state retires nothing.
    val nextInv = if (retires and not(lullReconciledNow)) inv + 1 else inv
    all {
      lullEnabled,
      completed' = max(completed, headEpoch - 1), inv' = nextInv,
      token' = if (m.token) { e: headEpoch, p: plane, i: nextInv, w: work } else NO_TOKEN,
      cleanAt' = headEpoch, cleanWork' = work, work' = work, staleSkip' = staleSkip, edge' = edge, reconciled' = reconciled.union(Set(headEpoch)), lulledAt' = headEpoch,
      recovered' = recovered, redundant' = redundant,
      creatorEpoch' = creatorEpoch, headEpoch' = headEpoch, headPending' = headPending, regEpoch' = regEpoch,
      regStatus' = regStatus, recoveryRequired' = recoveryRequired, phase' = phase, target' = target,
      candidate' = candidate, terminal' = terminal, failures' = failures, deaths' = deaths, plane' = plane,
      badSkip' = badSkip, leftUnreconciled' = leftUnreconciled, m' = m,
    }
  }
  // A failed lull: admission halts and the next install recovers first. Its passes may
  // have completed the control or retired a scope before the failure; the state is dirty.
  // Scheduled or explicit (an explicit failure leaves the scheduled lull owed).
  action lullFails: bool = {
    nondet scheduledOrNot = Set(headEpoch, lulledAt).oneOf()
    nondet c = Set(completed, max(completed, headEpoch - 1)).oneOf()
    nondet retires = Set(true, false).oneOf()
    all {
      lullBoundary, failures < MAX_FAILURES,
      completed' = c, inv' = if (retires) inv + 1 else inv, regStatus' = "terminal", recoveryRequired' = true,
      failures' = failures + 1, lulledAt' = scheduledOrNot, cleanAt' = NONE,
      token' = if (m.clearOnEntry) NO_TOKEN else token,
      creatorEpoch' = creatorEpoch, headEpoch' = headEpoch, headPending' = headPending, regEpoch' = regEpoch,
      phase' = phase, target' = target, candidate' = candidate, terminal' = terminal, deaths' = deaths,
      plane' = plane, reconciled' = reconciled, badSkip' = badSkip, leftUnreconciled' = leftUnreconciled,
      recovered' = recovered, redundant' = redundant, m' = m, keepWork,
    }
  }
  // Process death (or close and reopen) at any point: a new plane handle; a pending head
  // resolves forward; startup discharges a halted reopen (a complete reconciliation).
  action die: bool = all {
    deaths < MAX_DEATHS, deaths' = deaths + 1,
    val h = if (headPending) target else headEpoch
    val halted = reopenHalted(h, completed)
    all {
      headEpoch' = h, regEpoch' = h,
      cleanAt' = if (halted) h else cleanAt,
      cleanWork' = if (halted) work else cleanWork,
      reconciled' = if (halted) reconciled.union(Set(h)) else reconciled,
    },
    work' = work, staleSkip' = staleSkip, edge' = edge,
    headPending' = false, regStatus' = "active", phase' = "idle", candidate' = NONE, recoveryRequired' = false,
    terminal' = false, plane' = plane + 1, token' = token,
    creatorEpoch' = creatorEpoch, completed' = completed, target' = target, failures' = failures, inv' = inv,
    lulledAt' = lulledAt, badSkip' = badSkip, leftUnreconciled' = leftUnreconciled, recovered' = recovered, redundant' = redundant, m' = m,
  }

  // The member rewrites its own settlement plan outside the lifecycle FIFO, at any point
  // of an open session: an abandonment of unresolved accepted work, or a settlement
  // resolution (a frontier/commit disposition, a replacement, a hand-back). Neither moves
  // the head, the Cut or the recovery-role inventory. The shipped boundary sees neither;
  // the invalidation mutants clear it from the mutators they cover.
  action rewritePlan(invalidates: bool): bool = all {
    not(terminal), work < MAX_WORK, work' = work + 1,
    token' = if (invalidates) NO_TOKEN else token,
    cleanWork' = cleanWork, staleSkip' = staleSkip, edge' = edge,
    creatorEpoch' = creatorEpoch, headEpoch' = headEpoch, headPending' = headPending, regEpoch' = regEpoch,
    regStatus' = regStatus, completed' = completed, recoveryRequired' = recoveryRequired, phase' = phase,
    target' = target, candidate' = candidate, terminal' = terminal, failures' = failures, deaths' = deaths,
    plane' = plane, inv' = inv, keepGhost,
  }
  action abandon: bool = rewritePlan(not(m.matchWork) and m.invalidateOnAbandon)
  action settle: bool = rewritePlan(not(m.matchWork) and m.invalidateOnSettle)

  // Steps that leave the member's work and its reconciled view unchanged.
  action creatorAdvanceW = all { creatorAdvance, keepWork }
  action offerW = all { offer, keepWork }
  action startW = all { start, keepWork }
  action recoverFailsW = all { recoverFails, keepWork }
  action skipRecoverW = all { skipRecover, keepWork }
  action precheckW = all { precheck, keepWork }
  action fetchW = all { fetch, keepWork }
  action pendingW = all { pending, keepWork }
  // The head advance slides the bounded window: an edge scope may now exist.
  action commitW = {
    nondet slid = Set(true, false).oneOf()
    all { commit, work' = work, cleanWork' = cleanWork, staleSkip' = staleSkip, edge' = slid }
  }
  action activateW = all { activate, keepWork }
  action adoptionFailsW = all { adoptionFails, keepWork }

  action memberStep = any { offerW, startW, recover, skipRecoverW, precheckW, fetchW, turnover, pendingW, commitW, activateW }
  action step = any {
    creatorAdvanceW, offerW, startW, recover, recoverFailsW, skipRecoverW, precheckW, fetchW, turnover, receiveFails,
    pendingW, commitW, activateW, adoptionFailsW, lull, explicitLull, lullFails, die, abandon, settle,
  }

  val skipSound = not(badSkip)
  val noLeftUnreconciled = not(leftUnreconciled)
  val recoveryLeavesResolvable = if (m.noDischarge) not(reopenHalted(headEpoch, completed)) else true
  val refusalEscapable =
    if (phase != "idle") true
    else if (terminal) true
    else if (resolves) true
    else if (not(recoveryRequired)) false
    else recoveryLeavesResolvable
  val headMatchesRegistration = if (phase != "idle") true else if (terminal) true else regEpoch == headEpoch
  // The original (work-blind) safety, and the full safety with the work input.
  val safetyWithoutWork = skipSound and noLeftUnreconciled and refusalEscapable and headMatchesRegistration
  val skipSeesWork = not(staleSkip)
  val safety = safetyWithoutWork and skipSeesWork
  val noRedundant = not(redundant)

  val vars = (creatorEpoch, headEpoch, headPending, regEpoch, regStatus, completed, recoveryRequired, phase, target,
    candidate, terminal, failures, deaths, plane, inv, token, cleanAt, reconciled, lulledAt, badSkip, leftUnreconciled,
    redundant, m, work, cleanWork, staleSkip, edge)
  // Liveness: under weak fairness of the member's own steps, every head >= 2 a member
  // behind the creator is at is reconciled once (its Cut), or the session is terminal.
  // (A member that stays at its last head after a failed lull and a restart reconciles
  // only at its next install; base behaves the same: nothing needs it before then.)
  temporal cutsReconciled = weakFair(memberStep, vars) implies
    Set(2, 3).forall(h => always((headEpoch == h and creatorEpoch > h) implies
      eventually(reconciled.contains(h) or terminal)))
  // Liveness from the stuck-member model: a member behind the creator catches up or is terminal.
  temporal memberFollows = weakFair(memberStep, vars) implies
    always(headEpoch < creatorEpoch implies eventually(terminal or headEpoch == creatorEpoch))

  // Witnesses (deterministic head advances: the window slides only where stated).
  action commitQuiet = all { commit, work' = work, cleanWork' = cleanWork, staleSkip' = staleSkip, edge' = false }
  action commitSlid = all { commit, work' = work, cleanWork' = cleanWork, staleSkip' = staleSkip, edge' = true }
  action installToTurnover = offerW.then(startW).then(skipRecoverW).then(precheckW).then(fetchW)
  action follow = installToTurnover.then(turnover).then(pendingW).then(commitQuiet).then(activateW)
  action followSlid = installToTurnover.then(turnover).then(pendingW).then(commitSlid).then(activateW)
  run lullThenSkipTest = init.then(creatorAdvanceW).then(follow).then(creatorAdvanceW).then(follow)
    .then(lull).then(creatorAdvanceW).then(installToTurnover)
    .then(all { assert(skips and tokenMatches), turnover })
    .then(all { assert(reconciled == Set(2) and not(redundant) and safety), pendingW }).then(commitQuiet).then(activateW)
    .then(all { assert(headEpoch == 3 and token == NO_TOKEN and safety), creatorAdvanceW })
  run baseRedundantTest = initBase.then(creatorAdvanceW).then(follow).then(creatorAdvanceW).then(follow)
    .then(lull).then(creatorAdvanceW).then(installToTurnover)
    .then(all { assert(not(skips)), turnover }).then(all { assert(redundant), creatorAdvanceW })
  // An abandonment between the lull and the install: the next install must turn over (its
  // classification of the new plan retires the scope the abandoned work held).
  run shippedAbandonSkipsTest = initShipped.then(creatorAdvanceW).then(follow).then(creatorAdvanceW).then(follow)
    .then(lull).then(abandon).then(creatorAdvanceW).then(installToTurnover)
    .then(all { assert(skips and tokenMatches and not(reconciledNow)), turnover })
    .then(all { assert(not(skipSeesWork) and safetyWithoutWork), creatorAdvanceW })
  run soundAbandonTurnsOverTest = init.then(creatorAdvanceW).then(follow).then(creatorAdvanceW).then(follow)
    .then(lull).then(abandon).then(creatorAdvanceW).then(installToTurnover)
    .then(all { assert(not(skips) and not(tokenMatches)), turnover })
    .then(all { assert(reconciledNow and safety and not(redundant)), creatorAdvanceW })
  run abandonOnlyMissesSettleTest = initAbandonOnly.then(creatorAdvanceW).then(follow).then(creatorAdvanceW).then(follow)
    .then(lull).then(settle).then(creatorAdvanceW).then(installToTurnover)
    .then(all { assert(skips), turnover })
    .then(all { assert(not(skipSeesWork)), creatorAdvanceW })
  run edgeOnlyMissesAbandonTest = initEdgeOnly.then(creatorAdvanceW).then(follow).then(creatorAdvanceW).then(follow)
    .then(lull).then(abandon).then(creatorAdvanceW).then(installToTurnover)
    .then(all { assert(skips), turnover })
    .then(all { assert(not(skipSeesWork)), creatorAdvanceW })
  // The observed regression: once the window is full, the head advance leaves an edge scope
  // that only the install's own classification retires. A lull at that head cannot.
  run shippedEdgeSkipsTest = initShipped.then(creatorAdvanceW).then(follow).then(creatorAdvanceW).then(followSlid)
    .then(lull).then(all { assert(edge), creatorAdvanceW }).then(installToTurnover)
    .then(all { assert(skips and tokenMatches and not(reconciledNow)), turnover })
    .then(all { assert(edge and not(skipSeesWork) and safetyWithoutWork), creatorAdvanceW })
  run workOnlyMissesEdgeTest = initWorkOnly.then(creatorAdvanceW).then(follow).then(creatorAdvanceW).then(followSlid)
    .then(lull).then(creatorAdvanceW).then(installToTurnover)
    .then(all { assert(skips), turnover })
    .then(all { assert(not(skipSeesWork)), creatorAdvanceW })
  run soundEdgeTurnsOverTest = init.then(creatorAdvanceW).then(follow).then(creatorAdvanceW).then(followSlid)
    .then(lull).then(creatorAdvanceW).then(installToTurnover)
    .then(all { assert(not(skips) and tokenMatches == false), turnover })
    .then(all { assert(not(edge) and reconciledNow and safety and not(redundant)), creatorAdvanceW })
}
