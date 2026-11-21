module ledgerHeldTargetLaw {
  // Slice 14b stage 2 (decision rows 20 and 29): on an opted-in room host the ledger planner
  // (internal/creator-closed-rollback-data.ts planRoomRetentionFromLedger) decides a boundary from
  // its in-session ledger; stage 1's complete cold acquisition (acquireClosedData via
  // reconcileSnapshotRecoveryRoles) decides it otherwise and seeds the ledger. Both start from the
  // same `authenticate` of the boundary, which returns the held snapshot targets.
  //
  // 1515daab gave `authenticate` a native publication path: a settlement-v1 member whose AHE base
  // is a received or checkpoint publication (base epoch < n). Stage 1 was taught two laws for it;
  // the planner neither:
  //
  //   Held-target law. The member holds one target per authenticated row that carries a live
  //   generation, not the two newest closed epochs. The planner kept `held.length === 2`, refused
  //   every such boundary "snapshot-unavailable" and dropped its facts. Stage 1 then decided cold
  //   and re-seeded, so the ledger never decided (nor, in shadow mode, compared) a single recipient
  //   boundary: tests/track-m2-ledger-differential.test.ts "Track N's settlement room".
  //
  //   Retained-cut law. Stage 1 does not prove a native publication's retained cuts against local
  //   generations (checkpoint cuts name remote proof epochs); it checks each native row's carrier
  //   trust. The planner (authenticateRoomRetentionRetainedCuts) kept the closed law: every cut's
  //   carrier must be one of the boundary's required generations. A recipient lull runs a second
  //   pass at one boundary; the first pass's applied retirement can demote a cut's carrier from a
  //   required to an excluded (historical) generation. Stage 1 accepts that repeat pass; the
  //   planner refused it "chain-invalid": tests/track-m2-ledger-native-publication-red.test.ts.
  //
  // Each step is one pass of one member: either the first pass at a new boundary (`authenticate`
  // picks a shape: closed or native, and for native the number of rows carrying a live
  // generation; every retained cut's carrier is a required generation), or a repeat pass at the
  // same boundary (same shape; the previous pass's retirement may have demoted a cut's carrier).
  // The planner runs when the ledger is seeded; stage 1 decides when its own laws accept the pass
  // and seeds the ledger.
  //
  // Properties:
  //   sameShapeLaw - the planner never refuses a pass stage 1 accepts.
  //   decides      - every pass stage 1 accepts, entered with a seeded ledger, is decided
  //                  (compared) by the planner.
  //
  // Configurations:
  //   init               - both fixes (the planner uses stage 1's held-target and retained-cut
  //                        laws): both hold.
  //   initPreFix         - neither fix (two held targets; every cut carried by a required row):
  //                        violates both.
  //   initPreCutFix      - the held-target fix only (4e2161104): violates both, on a repeat pass.
  //   initPreFixClosed   - neither fix, closed shapes only (the creator's own closes, and every
  //                        member before 1515daab): holds, which is why only the recipient lost it.
  //
  // Checking (2026-11-21, quint 0.32.0, Apalache 0.56.1 on openjdk@17):
  //   quint run    --init <cfg> --step step --invariant safety --max-steps 12 --max-samples 20000 --seed 7
  //   quint verify --init <cfg> --step step --invariant safety --max-steps 6 --backend apalache
  //   init, initPreFixClosed: no violation (both).
  //   initPreFix: Apalache counterexample in 2 steps: a first native pass (3 live rows) seeds the
  //     ledger; the next boundary is native with one live row (held 1): stage 1 accepts it, the
  //     planner refuses it "snapshot-unavailable" (sameShapeLaw) and does not decide it (decides).
  //   initPreCutFix: Apalache counterexample in 2 steps: a first native pass (3 live rows) seeds
  //     the ledger; a repeat pass at the same boundary finds a retained cut's carrier demoted to an
  //     excluded generation: stage 1 accepts it, the planner refuses it "chain-invalid".
  pure val MAX_PASSES = 6

  var passes: int         // passes decided so far
  var seeded: bool        // the member's ledger holds facts (a prior pass)
  var entered: int        // passes stage 1 accepts, entered with a seeded ledger
  var compared: int       // passes the planner decided (shadow mode: compared)
  var refusedShape: bool  // the planner refused a pass stage 1 accepted
  var refusal: str        // the planner's last refusal: "none" | "snapshot-unavailable" | "chain-invalid"
  var lastNative: bool    // the current boundary's shape (for counterexamples, and the repeat pass)
  var lastLive: int
  var lastRepeat: bool    // the last pass was a repeat pass at its boundary
  var lastCarrierRequired: bool // the last pass found every retained cut's carrier required
  var heldFixed: bool
  var cutFixed: bool
  var closedOnly: bool

  // authenticate's held targets for a shape.
  pure def held(native: bool, liveRows: int): int = if (native) liveRows else 2
  // Stage 1's laws (acquireClosedData, since 1515daab).
  pure def stage1Held(native: bool, liveRows: int): int = if (native) liveRows else 2
  pure def stage1Cuts(native: bool, carrierRequired: bool): bool = native or carrierRequired
  // The planner's laws: before each fix, the closed law whatever the shape.
  pure def plannerHeld(fix: bool, native: bool, liveRows: int): int = if (fix) stage1Held(native, liveRows) else 2
  pure def plannerCuts(fix: bool, native: bool, carrierRequired: bool): bool =
    if (fix) stage1Cuts(native, carrierRequired) else carrierRequired

  action initWith(heldFix: bool, cutFix: bool, closed: bool): bool = all {
    passes' = 0, seeded' = false, entered' = 0, compared' = 0, refusedShape' = false, refusal' = "none",
    lastNative' = false, lastLive' = 1, lastRepeat' = false, lastCarrierRequired' = true,
    heldFixed' = heldFix, cutFixed' = cutFix, closedOnly' = closed,
  }
  action init = initWith(true, true, false)
  action initPreFix = initWith(false, false, false)
  action initPreCutFix = initWith(true, false, false)
  action initPreFixClosed = initWith(false, false, true)

  action decide(repeat: bool, native: bool, liveRows: int, carrierRequired: bool): bool = all {
    passes < MAX_PASSES,
    not(native and closedOnly),
    val h = held(native, liveRows)
    val stage1Accepts = h == stage1Held(native, liveRows) and stage1Cuts(native, carrierRequired)
    val heldAccepts = h == plannerHeld(heldFixed, native, liveRows)
    val plannerAccepts = heldAccepts and plannerCuts(cutFixed, native, carrierRequired)
    all {
      passes' = passes + 1,
      entered' = if (seeded and stage1Accepts) entered + 1 else entered,
      compared' = if (seeded and stage1Accepts and plannerAccepts) compared + 1 else compared,
      // (if-form: an `or` right of an assignment loses its parentheses in translation)
      refusedShape' = if (seeded and stage1Accepts and not(plannerAccepts)) true else refusedShape,
      refusal' = if (seeded and not(plannerAccepts)) (if (heldAccepts) "chain-invalid" else "snapshot-unavailable") else refusal,
      // A refusal drops the facts; stage 1 then decides and seeds again (open verification).
      seeded' = if (stage1Accepts) true else seeded,
      lastNative' = native, lastLive' = liveRows, lastRepeat' = repeat, lastCarrierRequired' = carrierRequired,
      heldFixed' = heldFixed, cutFixed' = cutFixed, closedOnly' = closedOnly,
    },
  }

  // The first pass at a new boundary: every retained cut is carried by a required generation.
  action firstPass(native: bool, liveRows: int): bool = decide(false, native, liveRows, true)
  // A repeat pass at the same boundary: the previous pass's retirement may have demoted a carrier.
  action repeatPass(carrierRequired: bool): bool = all {
    passes > 0,
    decide(true, lastNative, lastLive, carrierRequired),
  }

  action stutter: bool = all {
    passes' = passes, seeded' = seeded, entered' = entered, compared' = compared,
    refusedShape' = refusedShape, refusal' = refusal, lastNative' = lastNative, lastLive' = lastLive,
    lastRepeat' = lastRepeat, lastCarrierRequired' = lastCarrierRequired,
    heldFixed' = heldFixed, cutFixed' = cutFixed, closedOnly' = closedOnly,
  }

  action step = any {
    nondet native = oneOf(Set(true, false))
    nondet liveRows = oneOf(1.to(3))
    firstPass(native, liveRows),
    nondet carrierRequired = oneOf(Set(true, false))
    repeatPass(carrierRequired),
    stutter,
  }

  val sameShapeLaw = not(refusedShape)
  val decides = compared == entered
  val safety = sameShapeLaw and decides
}
