module ledgerHeldTargetLaw {
  // Slice 14b stage 2 (decision rows 20 and 29): on an opted-in room host the ledger planner
  // (internal/creator-closed-rollback-data.ts planRoomRetentionFromLedger) decides a boundary from
  // its in-session ledger; stage 1's complete cold acquisition (acquireClosedData via
  // reconcileSnapshotRecoveryRoles) decides it otherwise and seeds the ledger. Both start from the
  // same `authenticate` of the boundary, which returns the held snapshot targets.
  //
  // 1515daab gave `authenticate` a native publication path: a settlement-v1 member whose AHE base
  // is a received or checkpoint publication (base epoch < n) holds one target per authenticated row
  // that carries a live generation, not the two newest closed epochs. Stage 1's held-count law was
  // taught that shape; the planner kept `held.length === 2`, refused every such boundary
  // "snapshot-unavailable" and dropped its facts. Stage 1 then decided cold and re-seeded, so the
  // ledger never decided (nor, in shadow mode, compared) a single recipient boundary:
  // tests/track-m2-ledger-differential.test.ts "Track N's settlement room", 0 recipient comparisons.
  //
  // Each step is one boundary of one member: `authenticate` picks a shape (closed or native, and
  // for native the number of rows carrying a live generation), the planner runs when the ledger is
  // seeded, then stage 1 decides (it accepts every shape `authenticate` returns) and seeds the
  // ledger when it is empty.
  //
  // Properties:
  //   sameShapeLaw - the planner never refuses as snapshot-unavailable a shape stage 1 accepts.
  //   decides      - every boundary entered with a seeded ledger is decided (compared) by it.
  //
  // Configurations:
  //   init               - the fix (the planner uses stage 1's held-target law): both hold.
  //   initPreFix         - the planner requires two held targets: violates both.
  //   initPreFixClosed   - pre-fix, closed shapes only (the creator's own closes, and every
  //                        member before 1515daab): holds, which is why only the recipient lost it.
  //
  // Checking (2026-11-21, quint 0.32.0, Apalache 0.56.1 on openjdk@17):
  //   quint run    --init <cfg> --step step --invariant safety --max-steps 12 --max-samples 20000 --seed 7
  //   quint verify --init <cfg> --step step --invariant safety --max-steps 6 --backend apalache
  //   init, initPreFixClosed: no violation (both).
  //   initPreFix: Apalache counterexample in 2 steps: a closed boundary seeds the ledger; the next
  //     boundary is native with one live row (held 1): stage 1 accepts it, the planner refuses it
  //     (sameShapeLaw) and the boundary entered with a seeded ledger is not decided by it (decides).
  pure val MAX_BOUNDARIES = 6

  var boundaries: int     // boundaries decided so far
  var seeded: bool        // the member's ledger holds facts (a prior boundary)
  var entered: int        // boundaries entered with a seeded ledger
  var compared: int       // boundaries the planner decided (shadow mode: compared)
  var refusedShape: bool  // the planner refused, as snapshot-unavailable, a shape stage 1 accepted
  var lastShape: str      // the last boundary's shape, for counterexamples: "closed" | "native:<live rows>"
  var fixed: bool
  var closedOnly: bool

  // authenticate's held targets for a shape.
  pure def held(native: bool, liveRows: int): int = if (native) liveRows else 2
  // Stage 1's law (acquireClosedData, since 1515daab).
  pure def stage1Law(native: bool, liveRows: int): int = if (native) liveRows else 2
  // The planner's law: before the fix, two held targets whatever the shape.
  pure def plannerLaw(fix: bool, native: bool, liveRows: int): int =
    if (fix) stage1Law(native, liveRows) else 2

  action initWith(fix: bool, closed: bool): bool = all {
    boundaries' = 0, seeded' = false, entered' = 0, compared' = 0, refusedShape' = false, lastShape' = "none",
    fixed' = fix, closedOnly' = closed,
  }
  action init = initWith(true, false)
  action initPreFix = initWith(false, false)
  action initPreFixClosed = initWith(false, true)

  action boundary(native: bool, liveRows: int): bool = all {
    boundaries < MAX_BOUNDARIES,
    not(native and closedOnly),
    val h = held(native, liveRows)
    val stage1Accepts = h == stage1Law(native, liveRows)
    val plannerAccepts = h == plannerLaw(fixed, native, liveRows)
    all {
      boundaries' = boundaries + 1,
      entered' = if (seeded) entered + 1 else entered,
      compared' = if (seeded and plannerAccepts) compared + 1 else compared,
      // (if-form: an `or` right of an assignment loses its parentheses in translation)
      refusedShape' = if (seeded and stage1Accepts and not(plannerAccepts)) true else refusedShape,
      // A refusal drops the facts; stage 1 then decides and seeds again (open verification).
      seeded' = true,
      lastShape' = if (native) (if (liveRows == 1) "native:1" else if (liveRows == 2) "native:2" else "native:3") else "closed",
      fixed' = fixed, closedOnly' = closedOnly,
    },
  }

  action stutter: bool = all {
    boundaries' = boundaries, seeded' = seeded, entered' = entered, compared' = compared,
    refusedShape' = refusedShape, lastShape' = lastShape, fixed' = fixed, closedOnly' = closedOnly,
  }

  action step = any {
    nondet native = oneOf(Set(true, false))
    nondet liveRows = oneOf(1.to(3))
    boundary(native, liveRows),
    stutter,
  }

  val sameShapeLaw = not(refusedShape)
  val decides = compared == entered
  val safety = sameShapeLaw and decides
}
